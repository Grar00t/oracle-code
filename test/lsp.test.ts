import { describe, expect, test } from "bun:test"
import { frame, parseFrames, formatDiagnostic } from "../src/lsp/client"
import { applyEdits, editsByUri, formatLocations, formatSymbols, specForPath, languageIdFor } from "../src/lsp/index"

describe("jsonrpc framing", () => {
	test("frame then parse round-trips", () => {
		const message = { jsonrpc: "2.0", id: 1, method: "initialize", params: { a: 1 } }
		const { messages, rest } = parseFrames(frame(message))
		expect(messages).toEqual([message])
		expect(rest.length).toBe(0)
	})

	test("two messages in one buffer both parse", () => {
		const a = { id: 1 }
		const b = { id: 2 }
		const buffer = Buffer.concat([frame(a), frame(b)])
		expect(parseFrames(buffer).messages).toEqual([a, b])
	})

	test("a split body waits for the rest", () => {
		const whole = frame({ id: 7, result: "x" })
		const cut = whole.subarray(0, whole.length - 4)
		const first = parseFrames(Buffer.from(cut))
		expect(first.messages).toEqual([])
		const second = parseFrames(Buffer.concat([first.rest, whole.subarray(whole.length - 4)]))
		expect(second.messages).toEqual([{ id: 7, result: "x" }])
	})

	test("content-length counts utf-8 bytes, not characters", () => {
		const message = { text: "\u0645\u0631\u062d\u0628\u0627" }
		expect(parseFrames(frame(message)).messages).toEqual([message])
	})
})

describe("diagnostics formatting", () => {
	test("severity, 1-based position, source", () => {
		const line = formatDiagnostic({
			range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } },
			severity: 2,
			message: "unused variable",
			source: "ts",
		})
		expect(line).toBe("warning 5:3 unused variable [ts]")
	})
})

describe("server routing", () => {
	test("known extensions resolve to a server and languageId", () => {
		expect(specForPath("a/b.ts")?.bin).toBe("typescript-language-server")
		expect(specForPath("x.py")?.bin).toBe("pyright-langserver")
		expect(specForPath("m.rs")?.bin).toBe("rust-analyzer")
		expect(specForPath("m.go")?.bin).toBe("gopls")
		expect(specForPath("notes.txt")).toBeNull()
		expect(languageIdFor("a.tsx")).toBe("typescriptreact")
	})
})

describe("workspace edits", () => {
	test("edits apply bottom-up so earlier ranges stay valid", () => {
		const text = "alpha beta\ngamma alpha"
		const edits = [
			{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "delta" },
			{ range: { start: { line: 1, character: 6 }, end: { line: 1, character: 11 } }, newText: "delta" },
		]
		expect(applyEdits(text, edits)).toBe("delta beta\ngamma delta")
	})

	test("both WorkspaceEdit shapes flatten to the same map", () => {
		const viaChanges = editsByUri({ changes: { "file:///a": [{ range: {}, newText: "x" }] } })
		const viaDocuments = editsByUri({
			documentChanges: [{ textDocument: { uri: "file:///a" }, edits: [{ range: {}, newText: "x" }] }],
		})
		expect([...viaChanges.keys()]).toEqual(["file:///a"])
		expect([...viaDocuments.keys()]).toEqual(["file:///a"])
	})
})

describe("location and symbol formatting", () => {
	test("locations are workspace-relative with 1-based line:col", () => {
		const root = "/repo"
		const raw = [{ uri: "file:///repo/src/a.ts", range: { start: { line: 9, character: 4 } } }]
		expect(formatLocations(raw, root)).toEqual(["src/a.ts:10:5"])
	})

	test("nested symbols indent", () => {
		const raw = [
			{
				name: "Screen",
				kind: 5,
				range: { start: { line: 0 } },
				children: [{ name: "render", kind: 6, range: { start: { line: 10 } } }],
			},
		]
		expect(formatSymbols(raw)).toEqual(["class Screen :1", "  method render :11"])
	})
})
