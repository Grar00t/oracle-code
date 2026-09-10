import { describe, expect, test } from "bun:test"
import { splitBlocks, tokenizeLine } from "../src/tui/highlight"
import { detectFiller, restatesQuestion } from "../src/agent/filler"

describe("fence splitting", () => {
	test("prose only is one text block", () => {
		expect(splitBlocks("hello\nworld")).toEqual([{ kind: "text", lines: ["hello", "world"] }])
	})

	test("a fenced block is separated and carries its language", () => {
		const blocks = splitBlocks("before\n```ts\nconst x = 1\n```\nafter")
		expect(blocks).toEqual([
			{ kind: "text", lines: ["before"] },
			{ kind: "code", lang: "ts", lines: ["const x = 1"] },
			{ kind: "text", lines: ["after"] },
		])
	})

	test("an unclosed fence runs to the end instead of vanishing", () => {
		const blocks = splitBlocks("```py\nprint(1)")
		expect(blocks).toEqual([{ kind: "code", lang: "py", lines: ["print(1)"] }])
	})

	test("an empty code block still appears", () => {
		const blocks = splitBlocks("```\n```")
		expect(blocks).toEqual([{ kind: "code", lang: "", lines: [] }])
	})
})

describe("tokenizer", () => {
	test("keywords, strings and plain text separate", () => {
		expect(tokenizeLine('const x = "hi"')).toEqual([
			{ text: "const", token: "keyword" },
			{ text: " x = ", token: "plain" },
			{ text: '"hi"', token: "string" },
		])
	})

	test("a line comment swallows the rest of the line", () => {
		expect(tokenizeLine("x = 1 // done")).toEqual([
			{ text: "x = 1 ", token: "plain" },
			{ text: "// done", token: "comment" },
		])
	})

	test("a url is not a comment", () => {
		const tokens = tokenizeLine('u = "http://x.test"')
		expect(tokens.some((t) => t.token === "comment")).toBe(false)
	})

	test("an escaped quote does not end the string", () => {
		expect(tokenizeLine('"a\\"b"')).toEqual([{ text: '"a\\"b"', token: "string" }])
	})

	test("a hash comment", () => {
		expect(tokenizeLine("# top")).toEqual([{ text: "# top", token: "comment" }])
	})
})

describe("filler detection", () => {
	test("clean technical text passes", () => {
		expect(detectFiller("The bug is in parse(): the loop never advances i.")).toEqual([])
	})

	test("openers are caught", () => {
		expect(detectFiller("Great! The tests pass now.").length).toBeGreaterThan(0)
		expect(detectFiller("Certainly! Here is the fix.").length).toBeGreaterThan(0)
		expect(detectFiller("I'll now update the file.").length).toBeGreaterThan(0)
	})

	test("closers are caught anywhere", () => {
		expect(detectFiller("Fixed.\n\nHope this helps!").length).toBeGreaterThan(0)
		expect(detectFiller("Done. Let me know if you have any questions.").length).toBeGreaterThan(0)
	})

	test("a quoted phrase mid-answer is not an opener offence", () => {
		expect(detectFiller('The string "Great!" appears in the fixture.')).toEqual([])
	})

	test("restating the question is caught, short echoes are not", () => {
		const q = "how does the frame pipeline diff cells between the front and back buffers"
		expect(restatesQuestion(q, "The frame pipeline diffs cells between the front and back buffers. It...")).toBe(
			true,
		)
		expect(restatesQuestion(q, "Per row. Each put() keeps a difference counter.")).toBe(false)
	})
})
