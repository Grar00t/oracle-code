// LSP-backed tools: diagnostics, definition, references, symbols, rename.
//
// Every tool degrades honestly: when no server for the file's language is on
// PATH, the output names the missing binary instead of pretending the file is
// clean. All but rename are readOnly, so they enter the parallel scheduler.

import { resolve } from "node:path"
import {
	applyEdits,
	clientFor,
	diagnosticsFor,
	editsByUri,
	formatLocations,
	formatSymbols,
	languageIdFor,
	specForPath,
	toUri,
	type WorkspaceEdit,
} from "../lsp/index"
import { readText, writeText } from "../rt/index"
import { fileURLToPath } from "node:url"
import type { Tool, ToolContext } from "./tools"

type OpenResult =
	| { ok: false; message: string }
	| { ok: true; client: import("../lsp/client").LspClient; full: string }

async function openFor(path: string, ctx: ToolContext): Promise<OpenResult> {
	const full = resolve(ctx.cwd, path)
	const spec = specForPath(full)
	if (!spec) return { ok: false, message: `no language server registered for ${path}` }
	const client = await clientFor(full, ctx.cwd)
	if (!client) return { ok: false, message: `${spec.bin} is not on PATH; install it to analyze ${path}` }
	const text = await readText(full)
	client.openDocument(full, text, languageIdFor(full))
	return { ok: true, client, full }
}

export const diagnostics: Tool = {
	name: "diagnostics",
	description:
		"Language-server errors and warnings for a file. Empty output means the server reported the file clean.",
	readOnly: true,
	parameters: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	},
	summarize: (a) => `diagnostics ${a.path}`,
	async run(args, ctx) {
		const spec = specForPath(String(args.path))
		if (!spec) return `no language server registered for ${args.path}`
		const lines = await diagnosticsFor(args.path, ctx.cwd)
		if (lines === null) return `${spec.bin} is not on PATH; install it to analyze ${args.path}`
		return lines.length ? lines.join("\n") : "(no diagnostics)"
	},
}

export const definition: Tool = {
	name: "definition",
	description: "Where the symbol at file:line:column is defined. Line and column are 1-based.",
	readOnly: true,
	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
			line: { type: "number" },
			column: { type: "number" },
		},
		required: ["path", "line", "column"],
	},
	summarize: (a) => `definition ${a.path}:${a.line}:${a.column}`,
	async run(args, ctx) {
		const doc = await openFor(args.path, ctx)
		if (!doc.ok) return doc.message
		const result = await doc.client.request("textDocument/definition", {
			textDocument: { uri: toUri(doc.full) },
			position: { line: args.line - 1, character: args.column - 1 },
		})
		const locations = formatLocations(result, ctx.cwd)
		return locations.length ? locations.join("\n") : "(no definition found)"
	},
}

export const references: Tool = {
	name: "references",
	description: "Every reference to the symbol at file:line:column. Line and column are 1-based.",
	readOnly: true,
	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
			line: { type: "number" },
			column: { type: "number" },
		},
		required: ["path", "line", "column"],
	},
	summarize: (a) => `references ${a.path}:${a.line}:${a.column}`,
	async run(args, ctx) {
		const doc = await openFor(args.path, ctx)
		if (!doc.ok) return doc.message
		const result = await doc.client.request("textDocument/references", {
			textDocument: { uri: toUri(doc.full) },
			position: { line: args.line - 1, character: args.column - 1 },
			context: { includeDeclaration: true },
		})
		const locations = formatLocations(result, ctx.cwd)
		return locations.length ? locations.join("\n") : "(no references found)"
	},
}

export const symbols: Tool = {
	name: "symbols",
	description:
		"Outline of a file: classes, functions, methods with their lines. Cheaper context than reading the whole file.",
	readOnly: true,
	parameters: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	},
	summarize: (a) => `symbols ${a.path}`,
	async run(args, ctx) {
		const doc = await openFor(args.path, ctx)
		if (!doc.ok) return doc.message
		const result = await doc.client.request("textDocument/documentSymbol", {
			textDocument: { uri: toUri(doc.full) },
		})
		const lines = formatSymbols(result)
		return lines.length ? lines.join("\n") : "(no symbols)"
	},
}

export const rename: Tool = {
	name: "rename",
	description:
		"Rename the symbol at file:line:column across the workspace using the language server. Safer than text replace.",
	readOnly: false,
	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
			line: { type: "number" },
			column: { type: "number" },
			newName: { type: "string" },
		},
		required: ["path", "line", "column", "newName"],
	},
	summarize: (a) => `rename ${a.path}:${a.line}:${a.column} -> ${a.newName}`,
	async run(args, ctx) {
		const doc = await openFor(args.path, ctx)
		if (!doc.ok) return doc.message
		const result = (await doc.client.request("textDocument/rename", {
			textDocument: { uri: toUri(doc.full) },
			position: { line: args.line - 1, character: args.column - 1 },
			newName: args.newName,
		})) as WorkspaceEdit | null
		if (!result) return "(server returned no edit)"
		const perFile = editsByUri(result)
		if (perFile.size === 0) return "(server returned no edit)"
		const touched: string[] = []
		for (const [uri, edits] of perFile) {
			const filePath = fileURLToPath(uri)
			const checkpoint = await ctx.checkpoints.snapshot(filePath, "rename")
			await ctx.session.append("checkpoint", checkpoint)
			const before = await readText(filePath)
			await writeText(filePath, applyEdits(before, edits))
			touched.push(`${filePath} (${edits.length} edits, checkpoint #${checkpoint.seq})`)
		}
		return `renamed to ${args.newName}\n${touched.join("\n")}`
	},
}

export const lspTools: Tool[] = [diagnostics, definition, references, symbols, rename]
