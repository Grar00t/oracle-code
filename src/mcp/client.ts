// MCP client over stdio with lazy schema exposure.
//
// FACT: shipping every MCP schema into the context is expensive — one large
// server can cost tens of thousands of tokens before the first user message.
// So the catalog the model sees carries names and one-line descriptions only;
// the full input schema is fetched from the cache on first use.
//
// Capability firewall: a server tool is only eligible for parallel execution if
// it declares readOnlyHint. Anything undeclared is quarantined — serial, and it
// always requires a permission decision.

import type { Tool } from "../agent/tools"

type JsonRpcId = number

export type McpToolInfo = {
	name: string
	description?: string
	inputSchema?: Record<string, unknown>
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}

export class McpClient {
	private proc: ReturnType<typeof Bun.spawn> | null = null
	private nextId: JsonRpcId = 1
	private readonly pending = new Map<JsonRpcId, (value: any) => void>()
	private catalogCache: McpToolInfo[] | null = null
	private buffer = ""

	constructor(
		readonly serverName: string,
		private readonly command: string[],
		private readonly env: Record<string, string> = {},
	) {}

	async start(): Promise<void> {
		if (this.proc) return
		this.proc = Bun.spawn(this.command, {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
			env: { ...process.env, ...this.env },
		})
		void this.pump()
		await this.request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "oracle-code", version: "0.1.0" },
		})
		this.notify("notifications/initialized", {})
	}

	private async pump(): Promise<void> {
		const stdout = this.proc?.stdout
		if (!stdout || typeof stdout === "number") return
		const reader = (stdout as ReadableStream<Uint8Array>).getReader()
		const decoder = new TextDecoder()
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			this.buffer += decoder.decode(value, { stream: true })
			const lines = this.buffer.split("\n")
			this.buffer = lines.pop() ?? ""
			for (const line of lines) {
				if (!line.trim()) continue
				try {
					const msg = JSON.parse(line)
					if (msg.id !== undefined && this.pending.has(msg.id)) {
						this.pending.get(msg.id)!(msg)
						this.pending.delete(msg.id)
					}
				} catch {
					// Non-JSON noise on stdout is ignored rather than fatal.
				}
			}
		}
	}

	private write(payload: unknown): void {
		const stdin = this.proc?.stdin
		if (!stdin || typeof stdin === "number") throw new Error("mcp server not started")
		;(stdin as any).write(`${JSON.stringify(payload)}\n`)
		;(stdin as any).flush?.()
	}

	private notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params })
	}

	async request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
		const id = this.nextId++
		const promise = new Promise<any>((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new Error(`${this.serverName}: ${method} timed out after ${timeoutMs}ms`))
			}, timeoutMs)
			this.pending.set(id, (msg) => {
				clearTimeout(timer)
				if (msg.error) reject(new Error(`${this.serverName}: ${msg.error.message}`))
				else resolvePromise(msg.result)
			})
		})
		this.write({ jsonrpc: "2.0", id, method, params })
		return promise
	}

	/** Full tool list, cached. Never handed to the model as-is. */
	async catalog(): Promise<McpToolInfo[]> {
		if (this.catalogCache) return this.catalogCache
		await this.start()
		const result = await this.request("tools/list", {})
		this.catalogCache = (result?.tools ?? []) as McpToolInfo[]
		return this.catalogCache
	}

	/** Names and one-line descriptions: the only thing that costs context. */
	async index(): Promise<Array<{ name: string; description: string }>> {
		return (await this.catalog()).map((t) => ({
			name: `${this.serverName}__${t.name}`,
			description: (t.description ?? "").split("\n")[0]!.slice(0, 200),
		}))
	}

	async schema(toolName: string): Promise<Record<string, unknown>> {
		const info = (await this.catalog()).find((t) => t.name === toolName)
		return info?.inputSchema ?? { type: "object", properties: {} }
	}

	async call(toolName: string, args: unknown): Promise<string> {
		await this.start()
		const result = await this.request("tools/call", { name: toolName, arguments: args })
		const content = (result?.content ?? []) as Array<{ type: string; text?: string }>
		const text = content
			.map((item) => (item.type === "text" ? item.text ?? "" : `[${item.type}]`))
			.join("\n")
		return text || JSON.stringify(result?.structuredContent ?? result ?? {})
	}

	stop(): void {
		this.proc?.kill()
		this.proc = null
	}
}

/**
 * Wrap MCP tools as agent tools. Schemas are resolved on first call, so a large
 * server costs a few hundred context tokens instead of tens of thousands.
 */
export async function mcpTools(client: McpClient): Promise<Tool[]> {
	const catalog = await client.catalog()
	return catalog.map((info) => {
		const declaredReadOnly = info.annotations?.readOnlyHint === true
		let resolvedSchema: Record<string, unknown> | null = null
		return {
			name: `${client.serverName}__${info.name}`,
			description: (info.description ?? "").split("\n")[0]!.slice(0, 200),
			// Placeholder until first use; the real schema is fetched lazily.
			parameters: { type: "object", properties: {}, additionalProperties: true },
			readOnly: declaredReadOnly,
			irreversible: info.annotations?.destructiveHint === true,
			// Undeclared hints mean untrusted: serial and always prompted.
			quarantined: info.annotations?.readOnlyHint === undefined,
			summarize: (args) => `${client.serverName}/${info.name} ${JSON.stringify(args).slice(0, 120)}`,
			async run(args) {
				resolvedSchema ??= await client.schema(info.name)
				return client.call(info.name, args)
			},
		} satisfies Tool
	})
}
