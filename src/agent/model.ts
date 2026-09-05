// Model transport.
//
// Any OpenAI-compatible /v1/chat/completions endpoint works. The default points
// at a local server (khz / llama.cpp), so offline is the normal case rather than
// a degraded one. No vendor-specific field is required anywhere in this file.

export type ToolCall = { id: string; name: string; arguments: string }

export type Message =
	| { role: "system" | "user"; content: string }
	| { role: "assistant"; content: string; toolCalls?: ToolCall[] }
	| { role: "tool"; content: string; toolCallId: string; name: string }

export type ToolSchema = {
	name: string
	description: string
	parameters: Record<string, unknown>
}

export type ModelConfig = {
	baseUrl?: string
	model?: string
	apiKey?: string
	temperature?: number
	/** Hard cap on context tokens; used by the compactor, not sent upstream. */
	contextTokens?: number
}

export type Completion = {
	text: string
	toolCalls: ToolCall[]
	stopReason: "stop" | "tool_calls" | "length" | "unknown"
}

function wire(messages: Message[]): unknown[] {
	return messages.map((m) => {
		if (m.role === "tool")
			return { role: "tool", content: m.content, tool_call_id: m.toolCallId, name: m.name }
		if (m.role === "assistant" && m.toolCalls?.length)
			return {
				role: "assistant",
				content: m.content || null,
				tool_calls: m.toolCalls.map((c) => ({
					id: c.id,
					type: "function",
					function: { name: c.name, arguments: c.arguments },
				})),
			}
		return { role: m.role, content: m.content }
	})
}

export class Model {
	readonly baseUrl: string
	readonly name: string
	readonly contextTokens: number
	private readonly apiKey: string | undefined
	private readonly temperature: number

	constructor(cfg: ModelConfig = {}) {
		this.baseUrl = (cfg.baseUrl ?? process.env.ORACLE_BASE_URL ?? "http://127.0.0.1:8080/v1").replace(
			/\/$/,
			"",
		)
		this.name = cfg.model ?? process.env.ORACLE_MODEL ?? "local"
		this.apiKey = cfg.apiKey ?? process.env.ORACLE_API_KEY
		this.temperature = cfg.temperature ?? 0.2
		this.contextTokens = cfg.contextTokens ?? Number(process.env.ORACLE_CONTEXT ?? 32768)
	}

	/** Streaming completion. onToken receives assistant text deltas only. */
	async complete(
		messages: Message[],
		tools: ToolSchema[],
		onToken?: (delta: string) => void,
	): Promise<Completion> {
		const body = {
			model: this.name,
			messages: wire(messages),
			temperature: this.temperature,
			stream: true,
			...(tools.length
				? {
						tools: tools.map((t) => ({
							type: "function",
							function: { name: t.name, description: t.description, parameters: t.parameters },
						})),
						tool_choice: "auto",
					}
				: {}),
		}

		const res = await fetch(`${this.baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
			},
			body: JSON.stringify(body),
		})
		if (!res.ok || !res.body) {
			throw new Error(`model endpoint ${this.baseUrl} returned ${res.status}: ${await res.text()}`)
		}

		let text = ""
		let stopReason: Completion["stopReason"] = "unknown"
		const partial = new Map<number, ToolCall>()

		const reader = res.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ""
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			buffer += decoder.decode(value, { stream: true })
			const lines = buffer.split("\n")
			buffer = lines.pop() ?? ""
			for (const raw of lines) {
				const line = raw.trim()
				if (!line.startsWith("data:")) continue
				const payload = line.slice(5).trim()
				if (payload === "[DONE]") continue
				let chunk: any
				try {
					chunk = JSON.parse(payload)
				} catch {
					continue
				}
				const choice = chunk.choices?.[0]
				if (!choice) continue
				const delta = choice.delta ?? {}
				if (typeof delta.content === "string" && delta.content) {
					text += delta.content
					onToken?.(delta.content)
				}
				for (const tc of delta.tool_calls ?? []) {
					const slot = tc.index ?? 0
					const current = partial.get(slot) ?? { id: tc.id ?? `call_${slot}`, name: "", arguments: "" }
					if (tc.id) current.id = tc.id
					if (tc.function?.name) current.name += tc.function.name
					if (tc.function?.arguments) current.arguments += tc.function.arguments
					partial.set(slot, current)
				}
				if (choice.finish_reason) {
					stopReason =
						choice.finish_reason === "tool_calls"
							? "tool_calls"
							: choice.finish_reason === "length"
								? "length"
								: "stop"
				}
			}
		}

		const toolCalls = [...partial.values()].filter((c) => c.name)
		return { text, toolCalls, stopReason: toolCalls.length ? "tool_calls" : stopReason }
	}
}
