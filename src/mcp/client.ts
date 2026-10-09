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

// JSON-RPC ids are spec-allowed to be string or number. Keying pending calls by
// number alone silently dropped every response from a server that echoes back a
// string id ("1"), leaving each call to die on its timeout instead of resolving.
type JsonRpcId = number | string

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
	// Monotonic counter, never reset: ids must not be reused across stop/start
	// cycles, or a stale echo from a previous server could resolve a fresh call.
	// Requests are keyed by String(id); responses are looked up by String(msg.id),
	// so an echoed 7 and an echoed "7" both match without coercion games.
	private nextId = 1
	private readonly pending = new Map<string, Pending>()
	private catalogCache: McpToolInfo[] | null = null
	private buffer = ""
	private exitReason: string | null = null
	// A server that writes a huge line with no newline (or floods stdout with
	// binary noise) would grow `buffer` without bound and OOM the agent. One
	// JSON-RPC frame over 8 MiB is a protocol violation; fail it loudly.
	private static readonly MAX_LINE = 8 * 1024 * 1024

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
		if (this.buffer.length > McpClient.MAX_LINE) {
			this.failAll(`stdout line limit exceeded (${McpClient.MAX_LINE} bytes, no newline)`)
			this.buffer = ""
			return
		}
		for (const line of lines) {
			if (!line.trim()) continue
			if (line.length > McpClient.MAX_LINE) {
				this.failAll(`stdout line limit exceeded (${McpClient.MAX_LINE} bytes)`)
				continue
			}
			try {
				const msg = JSON.parse(line) as { id?: JsonRpcId; error?: { message: string }; result?: unknown }
				if (msg.id === undefined) continue
				// Match the echoed id exactly, as a string. Requests are keyed by
				// String(id), so an echoed 7, "7", or any other literal form resolves
				// the right call. Number() coercion matched only plain numeric strings
				// and silently broke on every other id shape.
				const key = String(msg.id)
				const entry = this.pending.get(key)
				if (!entry) continue
				this.pending.delete(key)
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

	/** Test seam: attach a fake transport so request/response framing can be
	 *  exercised without spawning a real MCP server. */
	setProcForTest(proc: unknown): void {
		this.proc = proc as ChildProcess
		this.exitReason = null
	}

	/** Test seam: read the pending-call table (keys are stringified JSON-RPC ids). */
	pendingKeysForTest(): string[] {
		return [...this.pending.keys()]
	}

	request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
		// Return the guarded promise itself; an async wrapper would create a
		// second, unguarded rejection for fire-and-forget callers.
		if (this.exitReason) {
			const failed = Promise.reject(new Error(`${this.serverName}: ${method}: ${this.exitReason}`))
			void failed.catch(() => undefined)
			return failed
		}
		const id = this.nextId++
		const key = String(id)
		const promise = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(key)
				reject(new Error(`${this.serverName}: ${method} timed out after ${timeoutMs}ms`))
			}, timeoutMs)
			this.pending.set(key, { resolve, reject, timer, method })
		})
		// This handles abandoned calls without changing rejection for consumers
		// that await or attach their own .catch() to the same promise.
		void promise.catch(() => undefined)
		try {
			this.write({ jsonrpc: "2.0", id, method, params })
		} catch (error) {
			const pending = this.pending.get(key)
			if (pending) {
				this.pending.delete(key)
				clearTimeout(pending.timer)
				pending.reject(error instanceof Error ? error : new Error(String(error)))
			}
		}
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
			isError?: boolean
		}
		const content = result?.content ?? []
		const text = content.map((item) => (item.type === "text" ? item.text ?? "" : `[${item.type}]`)).join("\n")
		// FACT (MCP spec): a tool execution failure comes back as a 200-level
		// JSON-RPC result with isError: true — the request itself succeeded, so
		// the transport has no way to flag it. Without this check a failed tool
		// call was reported to the agent loop as ok:true, and the zero-trust
		// feedback loop never saw the error.
		if (result?.isError) throw new Error(`${this.serverName}: ${toolName} failed: ${text || "(no error text)"}`)
		return text || JSON.stringify(result?.structuredContent ?? result ?? {})
	}

	stop(): void {
		// kill is optional so a stub transport can be stopped in tests; the real
		// ChildProcess always has it.
		;(this.proc as { kill?: () => void } | null)?.kill?.()
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
