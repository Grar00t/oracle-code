// Model transport.
//
// Any OpenAI-compatible /v1/chat/completions endpoint works. The default points
// at a local server (khz / llama.cpp), so offline is the normal case rather than
// a degraded one. No vendor-specific field is required anywhere in this file.
//
// Three things here exist because of observed failures, not taste:
//   - probe(): an unreachable endpoint must say which address failed and what to
//     do next. Waiting in silence is not a diagnosis.
//   - withTimeout(): a request owns its own abort timer and releases it on the
//     way out. A timer that outlives its request holds the event loop and
//     delays process exit for the length of the timeout.
//   - chatTemplateKwargs: on a server-rendered chat template this is the only
//     place a reasoning budget can be set, and on one consumer GPU that budget
//     dominates wall time far more than any sampling parameter.

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
	/** Sent as chat_template_kwargs, e.g. { reasoning_effort: "low" }. */
	chatTemplateKwargs?: Record<string, unknown>
	/** Abort a completion after this many ms. 0 disables the cap. */
	requestTimeoutMs?: number
	/** Abort the reachability probe after this many ms. */
	probeTimeoutMs?: number
	/** Injectable transport, so the failure paths above can be tested. */
	fetchImpl?: typeof fetch
}

export type Completion = {
	text: string
	toolCalls: ToolCall[]
	stopReason: "stop" | "tool_calls" | "length" | "unknown"
}

/** A reachability verdict. Failure always carries an address and a next step. */
export type ProbeResult =
	| { ok: true; models: string[] }
	| { ok: false; reason: string; hint: string }

let liveTimers = 0

/**
 * How many abort timers are still armed. Must be 0 whenever no request is in
 * flight; a non-zero count means something is holding the event loop open.
 */
export function liveAbortTimers(): number {
	return liveTimers
}

// The timer lives exactly as long as the call it guards. AbortSignal.timeout
// cannot do this: its timer runs to completion regardless.
function withTimeout<T>(ms: number, run: (signal?: AbortSignal) => Promise<T>): Promise<T> {
	if (ms <= 0) return run()
	const controller = new AbortController()
	liveTimers++
	const handle = setTimeout(
		() => controller.abort(Object.assign(new Error("the request timed out"), { name: "TimeoutError" })),
		ms,
	)
	return run(controller.signal).finally(() => {
		clearTimeout(handle)
		liveTimers--
	})
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

// A malformed override must fail loudly rather than quietly send a different
// request than the one that was asked for.
function templateKwargsFromEnv(): Record<string, unknown> {
	const raw = process.env.ORACLE_TEMPLATE_KWARGS
	if (raw) {
		let parsed: unknown
		try {
			parsed = JSON.parse(raw)
		} catch {
			throw new Error("ORACLE_TEMPLATE_KWARGS is not valid JSON")
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("ORACLE_TEMPLATE_KWARGS must be a JSON object")
		}
		return parsed as Record<string, unknown>
	}
	const effort = process.env.ORACLE_REASONING_EFFORT
	return effort ? { reasoning_effort: effort } : {}
}

// Refused and dropped look the same to a caller that only sees "it did not
// work", but they have opposite fixes: one is the wrong port, the other is the
// wrong bind address. Keep them apart.
function describeFailure(error: unknown, baseUrl: string): { reason: string; hint: string } {
	const carrier = error as { name?: string; code?: string; message?: string } | null
	const signature = [carrier?.name, carrier?.code, carrier?.message].filter(Boolean).join(" ")

	if (/timeout|timedout|abort/i.test(signature)) {
		return {
			reason: `${baseUrl} accepted no connection before the probe timed out`,
			hint: "the route exists but nothing answered: the server is probably bound to 127.0.0.1, so restart it with --host 0.0.0.0, or allow the port through the firewall",
		}
	}
	if (/refused/i.test(signature)) {
		return {
			reason: `${baseUrl} refused the connection`,
			hint: "the host is reachable but nothing is listening on that port: compare it with the port the server printed on its listening line",
		}
	}
	if (/notfound|eai_again|getaddrinfo|dns/i.test(signature)) {
		return {
			reason: `${baseUrl} did not resolve`,
			hint: "use a literal address: from WSL the Windows host is the default gateway, printed by ip route show default",
		}
	}
	return {
		reason: `${baseUrl} failed: ${carrier?.message ?? String(error)}`,
		hint: "check that the server is running and that the base url ends in /v1",
	}
}

export class Model {
	readonly baseUrl: string
	readonly name: string
	readonly contextTokens: number
	private readonly apiKey: string | undefined
	private readonly temperature: number
	private readonly chatTemplateKwargs: Record<string, unknown>
	private readonly requestTimeoutMs: number
	private readonly probeTimeoutMs: number
	private readonly fetchImpl: typeof fetch

	constructor(cfg: ModelConfig = {}) {
		this.baseUrl = (cfg.baseUrl ?? process.env.ORACLE_BASE_URL ?? "http://127.0.0.1:8080/v1").replace(
			/\/$/,
			"",
		)
		this.name = cfg.model ?? process.env.ORACLE_MODEL ?? "local"
		this.apiKey = cfg.apiKey ?? process.env.ORACLE_API_KEY
		this.temperature = cfg.temperature ?? 0.2
		this.contextTokens = cfg.contextTokens ?? Number(process.env.ORACLE_CONTEXT ?? 32768)
		this.chatTemplateKwargs = cfg.chatTemplateKwargs ?? templateKwargsFromEnv()
		this.requestTimeoutMs = cfg.requestTimeoutMs ?? 0
		this.probeTimeoutMs = cfg.probeTimeoutMs ?? 3000
		this.fetchImpl = cfg.fetchImpl ?? fetch
	}

	private headers(): Record<string, string> {
		return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}
	}

	/**
	 * Ask the endpoint what it is serving. Cheap, bounded, and side-effect free,
	 * so it is safe to run before every session.
	 *
	 * A 200 here does not prove the model can generate; it proves only that an
	 * OpenAI-compatible server is listening. Generation is a separate test.
	 */
	async probe(): Promise<ProbeResult> {
		const url = `${this.baseUrl}/models`
		let res: Response
		try {
			res = await withTimeout(this.probeTimeoutMs, (signal) =>
				this.fetchImpl(url, { headers: this.headers(), ...(signal ? { signal } : {}) }),
			)
		} catch (error) {
			return { ok: false, ...describeFailure(error, this.baseUrl) }
		}

		if (!res.ok) {
			return {
				ok: false,
				reason: `${url} returned ${res.status}`,
				hint:
					res.status === 404
						? "something is listening but not at that path: the base url must end in /v1"
						: "the server answered and refused: check the api key and the base url",
			}
		}

		try {
			const parsed = (await res.json()) as { data?: Array<{ id?: string }> }
			const models = (parsed.data ?? []).map((m) => m.id ?? "").filter(Boolean)
			return { ok: true, models }
		} catch {
			return {
				ok: false,
				reason: `${url} did not answer with JSON`,
				hint: "something other than an OpenAI-compatible server holds that port",
			}
		}
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
			...(Object.keys(this.chatTemplateKwargs).length
				? { chat_template_kwargs: this.chatTemplateKwargs }
				: {}),
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

		// The cap covers getting a response, not draining it. A long generation is
		// not a stalled request, and must not be aborted like one.
		let res: Response
		try {
			res = await withTimeout(this.requestTimeoutMs, (signal) =>
				this.fetchImpl(`${this.baseUrl}/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json", ...this.headers() },
					body: JSON.stringify(body),
					...(signal ? { signal } : {}),
				}),
			)
		} catch (error) {
			const { reason, hint } = describeFailure(error, this.baseUrl)
			throw new Error(`${reason}. ${hint}`)
		}

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
