// Raw LSP client: JSON-RPC 2.0 over stdio with Content-Length framing.
// No dependency — the protocol is a header, a JSON body, and message ids.
//
// FACT (LSP 3.17 spec): every message is "Content-Length: N\r\n\r\n" followed
// by N bytes of JSON. Requests carry an id and get one response; notifications
// carry no id and get none. Servers push diagnostics as the notification
// "textDocument/publishDiagnostics" — the client cannot request them, it can
// only open a document and wait.

import { spawn, type ChildProcess } from "node:child_process"
import { pathToFileURL } from "node:url"

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

/** Parse framed messages out of a growing buffer. Returns messages and the tail. */
export function parseFrames(buffer: Buffer): { messages: unknown[]; rest: Buffer } {
	const messages: unknown[] = []
	let cursor = 0
	while (true) {
		const headerEnd = buffer.indexOf("\r\n\r\n", cursor)
		if (headerEnd === -1) break
		const header = buffer.subarray(cursor, headerEnd).toString("ascii")
		const match = /content-length:\s*(\d+)/i.exec(header)
		if (!match) {
			// Unparseable header: skip past it rather than loop forever.
			cursor = headerEnd + 4
			continue
		}
		const length = Number(match[1])
		const bodyStart = headerEnd + 4
		if (buffer.length < bodyStart + length) break
		try {
			messages.push(JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString("utf8")))
		} catch {
			// A body the server misframed; drop it, keep the stream alive.
		}
		cursor = bodyStart + length
	}
	return { messages, rest: buffer.subarray(cursor) as Buffer }
}

export function frame(message: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf8")
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body])
}

export function toUri(path: string): string {
	return pathToFileURL(path).toString()
}

export type Diagnostic = {
	range: { start: { line: number; character: number }; end: { line: number; character: number } }
	severity?: number
	message: string
	source?: string
}

const SEVERITY = ["", "error", "warning", "info", "hint"]

export function formatDiagnostic(d: Diagnostic): string {
	const sev = SEVERITY[d.severity ?? 1] || "error"
	const line = d.range.start.line + 1
	const col = d.range.start.character + 1
	return `${sev} ${line}:${col} ${d.message}${d.source ? ` [${d.source}]` : ""}`
}

/**
 * One live server. The client speaks only what the tools need: initialize,
 * didOpen/didChange, diagnostics, definition, references, documentSymbol,
 * rename. Anything the server pushes beyond diagnostics is ignored.
 */
export class LspClient {
	private child: ChildProcess
	private nextId = 1
	private readonly pending = new Map<number, Pending>()
	private buffer: Buffer = Buffer.alloc(0)
	private readonly openDocs = new Map<string, number>()
	private readonly diagnostics = new Map<string, Diagnostic[]>()
	private readonly diagnosticWaiters = new Map<string, Array<() => void>>()
	/** Set once the process dies; every later call fails fast instead of hanging. */
	private dead: Error | null = null

	constructor(
		readonly command: string,
		readonly args: string[],
		readonly rootDir: string,
	) {
		this.child = spawn(command, args, {
			cwd: rootDir,
			stdio: ["pipe", "pipe", "ignore"],
			windowsHide: true,
		})
		this.child.stdout!.on("data", (chunk: Buffer) => this.onData(chunk))
		this.child.on("error", (error) => this.fail(error))
		this.child.on("close", () => this.fail(new Error(`${command} exited`)))
	}

	get alive(): boolean {
		return this.dead === null
	}

	private fail(error: Error): void {
		if (this.dead) return
		this.dead = error
		for (const [, waiter] of this.pending) waiter.reject(error)
		this.pending.clear()
		for (const [, waiters] of this.diagnosticWaiters) for (const w of waiters) w()
		this.diagnosticWaiters.clear()
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk])
		const { messages, rest } = parseFrames(this.buffer)
		this.buffer = rest
		for (const raw of messages) {
			const msg = raw as {
				id?: number
				method?: string
				result?: unknown
				error?: { message?: string }
				params?: any
			}
			if (msg.id !== undefined && msg.method === undefined) {
				const waiter = this.pending.get(msg.id)
				if (!waiter) continue
				this.pending.delete(msg.id)
				if (msg.error) waiter.reject(new Error(msg.error.message ?? "lsp error"))
				else waiter.resolve(msg.result)
				continue
			}
			if (msg.method === "textDocument/publishDiagnostics" && msg.params?.uri) {
				const uri = String(msg.params.uri)
				this.diagnostics.set(uri, (msg.params.diagnostics ?? []) as Diagnostic[])
				const waiters = this.diagnosticWaiters.get(uri)
				if (waiters) {
					this.diagnosticWaiters.delete(uri)
					for (const w of waiters) w()
				}
				continue
			}
			// A server-to-client request must get some answer or some servers stall.
			if (msg.id !== undefined && msg.method !== undefined) {
				this.send({ jsonrpc: "2.0", id: msg.id, result: null })
			}
		}
	}

	private send(message: unknown): void {
		if (this.dead) return
		this.child.stdin?.write(frame(message))
	}

	request(method: string, params: unknown, timeoutMs = 8000): Promise<unknown> {
		if (this.dead) return Promise.reject(this.dead)
		const id = this.nextId++
		this.send({ jsonrpc: "2.0", id, method, params })
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new Error(`${method} timed out after ${timeoutMs}ms`))
			}, timeoutMs)
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer)
					resolve(value)
				},
				reject: (error) => {
					clearTimeout(timer)
					reject(error)
				},
			})
		})
	}

	notify(method: string, params: unknown): void {
		this.send({ jsonrpc: "2.0", method, params })
	}

	async initialize(): Promise<void> {
		await this.request("initialize", {
			processId: process.pid,
			rootUri: toUri(this.rootDir),
			capabilities: {
				textDocument: {
					publishDiagnostics: {},
					definition: {},
					references: {},
					documentSymbol: { hierarchicalDocumentSymbolSupport: true },
					rename: {},
				},
			},
			workspaceFolders: [{ uri: toUri(this.rootDir), name: "workspace" }],
		})
		this.notify("initialized", {})
	}

	/** Open or refresh a document. Version bumps make edits visible to the server. */
	openDocument(path: string, text: string, languageId: string): void {
		const uri = toUri(path)
		const version = this.openDocs.get(uri)
		if (version === undefined) {
			this.openDocs.set(uri, 1)
			this.notify("textDocument/didOpen", {
				textDocument: { uri, languageId, version: 1, text },
			})
			return
		}
		const next = version + 1
		this.openDocs.set(uri, next)
		this.notify("textDocument/didChange", {
			textDocument: { uri, version: next },
			contentChanges: [{ text }],
		})
	}

	/**
	 * Wait for the server's diagnostics for a document. Publish is a push, so
	 * this waits for the next push or returns what is already known on timeout.
	 */
	waitDiagnostics(path: string, timeoutMs = 5000): Promise<Diagnostic[]> {
		const uri = toUri(path)
		return new Promise((resolve) => {
			const finish = () => resolve(this.diagnostics.get(uri) ?? [])
			const timer = setTimeout(finish, timeoutMs)
			const waiters = this.diagnosticWaiters.get(uri) ?? []
			waiters.push(() => {
				clearTimeout(timer)
				finish()
			})
			this.diagnosticWaiters.set(uri, waiters)
		})
	}

	dispose(): void {
		try {
			this.notify("exit", {})
			this.child.kill()
		} catch {
			// Already dead is fine.
		}
	}
}
