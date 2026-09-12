// Language server registry. One client per server binary per workspace,
// started on first use, found on PATH exactly the way ripgrep is: present is
// used, absent is a clean fallback that names itself in `oc doctor`.

import { extname, resolve } from "node:path"
import { readText, which } from "../rt/index"
import { formatDiagnostic, LspClient, toUri, type Diagnostic } from "./client"

export type ServerSpec = {
	/** Executable looked up on PATH. */
	bin: string
	args: string[]
	/** LSP languageId values this server accepts. */
	languages: string[]
	/** File extensions routed to it. */
	extensions: string[]
}

// The four servers named in the design. Adding one is adding a row.
export const SERVERS: ServerSpec[] = [
	{
		bin: "typescript-language-server",
		args: ["--stdio"],
		languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
		extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
	},
	{
		bin: "pyright-langserver",
		args: ["--stdio"],
		languages: ["python"],
		extensions: [".py", ".pyi"],
	},
	{
		bin: "rust-analyzer",
		args: [],
		languages: ["rust"],
		extensions: [".rs"],
	},
	{
		bin: "gopls",
		args: ["serve"],
		languages: ["go"],
		extensions: [".go"],
	},
]

const LANGUAGE_BY_EXT: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescriptreact",
	".mts": "typescript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "javascriptreact",
	".mjs": "javascript",
	".cjs": "javascript",
	".py": "python",
	".pyi": "python",
	".rs": "rust",
	".go": "go",
}

export function specForPath(path: string): ServerSpec | null {
	const ext = extname(path).toLowerCase()
	return SERVERS.find((s) => s.extensions.includes(ext)) ?? null
}

export function languageIdFor(path: string): string {
	return LANGUAGE_BY_EXT[extname(path).toLowerCase()] ?? "plaintext"
}

/** What `oc doctor` reports: each known server and whether PATH has it. */
export async function availableServers(): Promise<Array<{ bin: string; path: string | null }>> {
	const out: Array<{ bin: string; path: string | null }> = []
	for (const spec of SERVERS) {
		out.push({ bin: spec.bin, path: await which(spec.bin) })
	}
	return out
}

const clients = new Map<string, LspClient | null>()

/**
 * Client for a file, or null when no server for that language is on PATH.
 * A server that fails to start is remembered as null: one failed spawn per
 * session, not one per tool call.
 */
export async function clientFor(path: string, rootDir: string): Promise<LspClient | null> {
	const spec = specForPath(path)
	if (!spec) return null
	const key = `${spec.bin}\u0000${rootDir}`
	const cached = clients.get(key)
	if (cached !== undefined) return cached && cached.alive ? cached : null
	const bin = await which(spec.bin)
	if (!bin) {
		clients.set(key, null)
		return null
	}
	try {
		const client = new LspClient(bin, spec.args, rootDir)
		await client.initialize()
		clients.set(key, client)
		return client
	} catch {
		clients.set(key, null)
		return null
	}
}

export function disposeClients(): void {
	for (const [, client] of clients) client?.dispose()
	clients.clear()
}

/**
 * Diagnostics for a file as display lines, or null when no server covers it.
 * Reads the file itself so it reflects what is on disk right now — which is
 * the point when it runs directly after write/edit.
 */
export async function diagnosticsFor(
	path: string,
	rootDir: string,
	timeoutMs = 5000,
): Promise<string[] | null> {
	const full = resolve(rootDir, path)
	const client = await clientFor(full, rootDir)
	if (!client) return null
	const text = await readText(full).catch(() => null)
	if (text === null) return null
	client.openDocument(full, text, languageIdFor(full))
	const diagnostics = await client.waitDiagnostics(full, timeoutMs)
	return diagnostics.map(formatDiagnostic)
}

type Location = { uri?: string; range?: { start?: { line?: number; character?: number } } }

// Slash-normalized absolute path in URL form: backslashes become slashes and
// a drive-letter path gains the leading slash a file URL pathname carries, so
// "/repo" and "D:\\repo" both compare against a URI's decoded pathname.
function toUrlPath(path: string): string {
	const slashed = path.replace(/\\/g, "/")
	return slashed.startsWith("/") ? slashed : `/${slashed}`
}

export function formatLocations(raw: unknown, rootDir: string): string[] {
	const list: Location[] = Array.isArray(raw) ? raw : raw ? [raw as Location] : []
	const rootPath = toUrlPath(rootDir).replace(/\/+$/, "")
	return list.map((loc) => {
		const target = (loc as { targetUri?: string }).targetUri ?? loc.uri ?? ""
		const range =
			(loc as { targetRange?: Location["range"] }).targetRange ?? loc.range ?? undefined
		const line = (range?.start?.line ?? 0) + 1
		const col = (range?.start?.character ?? 0) + 1
		let rel = decodeURIComponent(target)
		if (target.startsWith("file://")) {
			try {
				const path = decodeURIComponent(new URL(target).pathname)
				if (path.toLowerCase().startsWith(`${rootPath.toLowerCase()}/`))
					rel = path.slice(rootPath.length + 1)
			} catch {
				// malformed URI: fall through with the decoded target as-is
			}
		}
		return `${rel}:${line}:${col}`
	})
}

type DocumentSymbol = {
	name: string
	kind?: number
	range?: { start?: { line?: number } }
	location?: { range?: { start?: { line?: number } } }
	children?: DocumentSymbol[]
}

// LSP SymbolKind, 1-based. Only names shown to a model reading an outline.
const SYMBOL_KINDS = [
	"", "file", "module", "namespace", "package", "class", "method", "property",
	"field", "constructor", "enum", "interface", "function", "variable", "constant",
	"string", "number", "boolean", "array", "object", "key", "null", "enum-member",
	"struct", "event", "operator", "type-parameter",
]

export function formatSymbols(raw: unknown, depth = 0): string[] {
	const list: DocumentSymbol[] = Array.isArray(raw) ? raw : []
	const out: string[] = []
	for (const sym of list) {
		const line =
			(sym.range?.start?.line ?? sym.location?.range?.start?.line ?? 0) + 1
		const kind = SYMBOL_KINDS[sym.kind ?? 0] || "symbol"
		out.push(`${"  ".repeat(depth)}${kind} ${sym.name} :${line}`)
		if (sym.children?.length) out.push(...formatSymbols(sym.children, depth + 1))
	}
	return out
}

export type WorkspaceEdit = {
	changes?: Record<string, Array<{ range: any; newText: string }>>
	documentChanges?: Array<{
		textDocument?: { uri: string }
		edits?: Array<{ range: any; newText: string }>
	}>
}

/** Flatten a WorkspaceEdit into per-uri edit lists, whichever shape the server used. */
export function editsByUri(edit: WorkspaceEdit): Map<string, Array<{ range: any; newText: string }>> {
	const out = new Map<string, Array<{ range: any; newText: string }>>()
	for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
		out.set(uri, [...(out.get(uri) ?? []), ...edits])
	}
	for (const change of edit.documentChanges ?? []) {
		if (!change.textDocument?.uri || !change.edits) continue
		const uri = change.textDocument.uri
		out.set(uri, [...(out.get(uri) ?? []), ...change.edits])
	}
	return out
}

/** Apply LSP text edits to a document. Applied bottom-up so ranges stay valid. */
export function applyEdits(text: string, edits: Array<{ range: any; newText: string }>): string {
	const lines = text.split("\n")
	const offsets: number[] = []
	let acc = 0
	for (const line of lines) {
		offsets.push(acc)
		acc += line.length + 1
	}
	const toOffset = (pos: { line: number; character: number }): number =>
		(offsets[pos.line] ?? text.length) + pos.character
	const sorted = [...edits].sort((a, b) => toOffset(b.range.start) - toOffset(a.range.start))
	let out = text
	for (const edit of sorted) {
		const start = toOffset(edit.range.start)
		const end = toOffset(edit.range.end)
		out = out.slice(0, start) + edit.newText + out.slice(end)
	}
	return out
}

export type { Diagnostic }
export { formatDiagnostic, toUri }
