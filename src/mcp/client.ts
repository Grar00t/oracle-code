// MCP client over stdio with lazy schema exposure.
//
// FACT: shipping every MCP schema into the context is expensive - one large
// server can cost tens of thousands of tokens before the first user message.
// So the catalog the model sees carries names and one-line descriptions only;
// the full input schema is fetched on first use and then kept on the tool.
//
// Capability firewall: a server tool is only eligible for parallel execution if
// it declares readOnlyHint. Anything undeclared is quarantined - serial, and it
// always requires a permission decision.
//
// Portability: spawned through node:child_process, and the executable is
// resolved through PATH with PATHEXT, because MCP servers are normally started
// as `npx ...` and on Windows that is npx.cmd, not npx.

import { spawn, type ChildProcess } from "node:child_process"
import { isWindows, scrubEnv, which } from "../rt/index"
import type { Tool } from "../agent/tools"

type JsonRpcId = number

type Pending = {
	resolve: (value: unknown) => void
	reject: (error: Error) => void
	timer: ReturnType<typeof setTimeout>
	method: string
}

export type McpToolInfo = {
	name: string
	description?: string
	inputSchema?: Record<string, unknown>
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}

export class McpClient {
	private proc: ChildProcess | null = null
	private nextId: JsonRpcId = 1
	private readonly pending = new Map<JsonRpcId, Pending>()
	private catalogCache: McpToolInfo[] | null = null
	private buffer = ""
	private exitReason: string | null = null

	constructor(
		readonly serverName: string,
		private readonly command: string[],
		private readonly env: Record<string, string> = {},
	) {}

	async start(): Promise<void> {
		if (this.proc) return
		const head = this.command[0]
		if (!head) throw new Error(`${this.serverName}: empty command`)
		const file = (await which(head)) ?? head
		this.exitReason = null
		this.proc = spawn(file, this.command.slice(1), {
			stdio: ["pipe", "pipe", "inherit"],
			env: { ...scrubEnv(process.env), ...this.env },
			windowsHide: true,
			shell: isWindows && /\.(cmd|bat)$/i.test(file),
		})
		this.proc.stdin?.on("error", () => undefined)
		this.proc.stdout?.setEncoding("utf8")
		this.proc.stdout?.on("data", (chunk: string) => this.consume(chunk))
		this.proc.on("error", (error) => this.failAll(`spawn failed: ${(error as Error).message}`))
		this.proc.on("exit", (code, signal) =>
			this.failAll(`server exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`),
		)
		await this.request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "oracle-code", version: "0.2.0" },
		})
		this.notify("notifications/initialized", {})
	}

	consume(chunk: string): void {
		this.buffer += chunk
		const lines = this.buffer.split("\n")
		this.buffer = lines.pop() ?? ""
		for (const line of lines) {
			if (!line.trim()) continue
			try {
				const msg = JSON.parse(line) as { id?: JsonRpcId; error?: { message: string }; result?: unknown }
				if (msg.id === undefined) continue
				const entry = this.pending.get(msg.id)
				if (!entry) continue
				this.pending.delete(msg.id)
				clearTimeout(entry.timer)
				if (msg.error) entry.reject(new Error(`${this.serverName}: ${msg.error.message}`))
				else entry.resolve(msg.result)
			} catch {
				// Non-JSON noise on stdout is ignored rather than fatal.
			}
		}
	}

	failAll(reason: string): void {
		this.exitReason = reason
		const entries = [...this.pending.entries()]
		this.pending.clear()
		for (const [, entry] of entries) {
			clearTimeout(entry.timer)
			entry.reject(new Error(`${this.serverName}: ${entry.method}: ${reason}`))
		}
	}

	inFlight(): number {
		return this.pending.size
	}

	private write(payload: unknown): void {
		const stdin = this.proc?.stdin
		if (!stdin) throw new Error(`${this.serverName}: mcp server not started`)
		stdin.write(`${JSON.stringify(payload)}\n`)
	}

	private notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params })
	}

	async request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
		if (this.exitReason) throw new Error(`${this.serverName}: ${method}: ${this.exitReason}`)
		const id = this.nextId++
		const promise = new Promise<unknown>((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new Error(`${this.serverName}: ${method} timed out after ${timeoutMs}ms`))
			}, timeoutMs)
			this.pending.set(id, { resolve: resolvePromise, reject, timer, method })
		})
		this.write({ jsonrpc: "2.0", id, method, params })
		return promise
	}

	async catalog(): Promise<McpToolInfo[]> {
		if (this.catalogCache) return this.catalogCache
		await this.start()
		const result = (await this.request("tools/list", {})) as { tools?: McpToolInfo[] }
		this.catalogCache = result?.tools ?? []
		return this.catalogCache
	}

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
		const result = (await this.request("tools/call", { name: toolName, arguments: args })) as {
			content?: Array<{ type: string; text?: string }>
			structuredContent?: unknown
		}
		const content = result?.content ?? []
		const text = content.map((item) => (item.type === "text" ? item.text ?? "" : `[${item.type}]`)).join("\n")
		return text || JSON.stringify(result?.structuredContent ?? result ?? {})
	}

	stop(): void {
		this.proc?.kill()
		this.proc = null
		this.failAll("client stopped")
	}
}

export async function mcpTools(client: McpClient): Promise<Tool[]> {
	const catalog = await client.catalog()
	return catalog.map((info) => {
		const declaredReadOnly = info.annotations?.readOnlyHint === true
		let schemaResolved = false
		const tool: Tool = {
			name: `${client.serverName}__${info.name}`,
			description: (info.description ?? "").split("\n")[0]!.slice(0, 200),
			parameters: { type: "object", properties: {}, additionalProperties: true },
			readOnly: declaredReadOnly,
			irreversible: info.annotations?.destructiveHint === true,
			quarantined: info.annotations?.readOnlyHint === undefined,
			summarize: (args) => `${client.serverName}/${info.name} ${JSON.stringify(args).slice(0, 120)}`,
			async run(args) {
				if (!schemaResolved) {
					const schema = await client.schema(info.name)
					if (schema && typeof schema === "object") tool.parameters = schema
					schemaResolved = true
				}
				return client.call(info.name, args)
			},
		}
		return tool
	})
}
