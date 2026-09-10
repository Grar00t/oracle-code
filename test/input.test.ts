import { describe, expect, test } from "bun:test"
import { parseKeys, type Key } from "../src/tui/keys"
import { LineEditor } from "../src/tui/editor"

function keysOf(input: string): Key[] {
	return parseKeys(input).keys
}

describe("key parser", () => {
	test("printable characters pass through", () => {
		expect(keysOf("ab")).toEqual([
			{ kind: "char", char: "a" },
			{ kind: "char", char: "b" },
		])
	})

	test("enter, backspace, tab", () => {
		expect(keysOf("\r")).toEqual([{ kind: "enter" }])
		expect(keysOf("\n")).toEqual([{ kind: "enter" }])
		expect(keysOf("\r\n")).toEqual([{ kind: "enter" }])
		expect(keysOf("\u007f")).toEqual([{ kind: "backspace" }])
		expect(keysOf("\t")).toEqual([{ kind: "tab" }])
	})

	test("control keys map to letters", () => {
		expect(keysOf("\u0001")).toEqual([{ kind: "ctrl", char: "a" }])
		expect(keysOf("\u0005")).toEqual([{ kind: "ctrl", char: "e" }])
		expect(keysOf("\u0017")).toEqual([{ kind: "ctrl", char: "w" }])
		expect(keysOf("\u0003")).toEqual([{ kind: "ctrl", char: "c" }])
	})

	test("CSI arrows, home, end", () => {
		expect(keysOf("\u001b[A")).toEqual([{ kind: "up" }])
		expect(keysOf("\u001b[B")).toEqual([{ kind: "down" }])
		expect(keysOf("\u001b[C")).toEqual([{ kind: "right" }])
		expect(keysOf("\u001b[D")).toEqual([{ kind: "left" }])
		expect(keysOf("\u001b[H")).toEqual([{ kind: "home" }])
		expect(keysOf("\u001b[F")).toEqual([{ kind: "end" }])
	})

	test("tilde sequences: delete, page up, page down", () => {
		expect(keysOf("\u001b[3~")).toEqual([{ kind: "delete" }])
		expect(keysOf("\u001b[5~")).toEqual([{ kind: "pageUp" }])
		expect(keysOf("\u001b[6~")).toEqual([{ kind: "pageDown" }])
	})

	test("SS3 application-mode arrows", () => {
		expect(keysOf("\u001bOA")).toEqual([{ kind: "up" }])
	})

	test("a split escape sequence is carried as rest, not misread", () => {
		const first = parseKeys("\u001b[")
		expect(first.keys).toEqual([])
		expect(first.rest).toBe("\u001b[")
		const second = parseKeys(first.rest + "A")
		expect(second.keys).toEqual([{ kind: "up" }])
		expect(second.rest).toBe("")
	})

	test("a lone ESC at end of chunk is held back", () => {
		const out = parseKeys("x\u001b")
		expect(out.keys).toEqual([{ kind: "char", char: "x" }])
		expect(out.rest).toBe("\u001b")
	})
})

function type(editor: LineEditor, text: string): void {
	for (const key of keysOf(text)) editor.feed(key)
}

describe("line editor", () => {
	test("typing and submit", () => {
		const ed = new LineEditor()
		type(ed, "hello")
		expect(ed.text).toBe("hello")
		expect(ed.cursorPosition).toBe(5)
		const action = ed.feed({ kind: "enter" })
		expect(action).toEqual({ kind: "submit", text: "hello" })
		expect(ed.text).toBe("")
	})

	test("cursor movement and mid-line insert", () => {
		const ed = new LineEditor()
		type(ed, "hlo")
		ed.feed({ kind: "left" })
		ed.feed({ kind: "left" })
		type(ed, "el")
		expect(ed.text).toBe("hello")
	})

	test("ctrl-a, ctrl-e, ctrl-u, ctrl-k", () => {
		const ed = new LineEditor()
		type(ed, "abcdef")
		ed.feed({ kind: "ctrl", char: "a" })
		expect(ed.cursorPosition).toBe(0)
		ed.feed({ kind: "ctrl", char: "e" })
		expect(ed.cursorPosition).toBe(6)
		ed.feed({ kind: "ctrl", char: "a" })
		ed.feed({ kind: "right" })
		ed.feed({ kind: "ctrl", char: "k" })
		expect(ed.text).toBe("a")
		type(ed, "bc")
		ed.feed({ kind: "ctrl", char: "u" })
		expect(ed.text).toBe("")
	})

	test("ctrl-w deletes the previous word", () => {
		const ed = new LineEditor()
		type(ed, "one two three")
		ed.feed({ kind: "ctrl", char: "w" })
		expect(ed.text).toBe("one two ")
		ed.feed({ kind: "ctrl", char: "w" })
		expect(ed.text).toBe("one ")
	})

	test("backspace and delete", () => {
		const ed = new LineEditor()
		type(ed, "abc")
		ed.feed({ kind: "backspace" })
		expect(ed.text).toBe("ab")
		ed.feed({ kind: "home" })
		ed.feed({ kind: "delete" })
		expect(ed.text).toBe("b")
	})

	test("history: up recalls, down returns to the pending line", () => {
		const ed = new LineEditor()
		type(ed, "first")
		ed.feed({ kind: "enter" })
		type(ed, "second")
		ed.feed({ kind: "enter" })
		type(ed, "draft")
		ed.feed({ kind: "up" })
		expect(ed.text).toBe("second")
		ed.feed({ kind: "up" })
		expect(ed.text).toBe("first")
		ed.feed({ kind: "up" })
		expect(ed.text).toBe("first")
		ed.feed({ kind: "down" })
		expect(ed.text).toBe("second")
		ed.feed({ kind: "down" })
		expect(ed.text).toBe("draft")
	})

	test("seeded history is browsable", () => {
		const ed = new LineEditor()
		ed.seedHistory(["old prompt"])
		ed.feed({ kind: "up" })
		expect(ed.text).toBe("old prompt")
	})

	test('multiline: """ opens, a second """ submits the block', () => {
		const ed = new LineEditor()
		type(ed, '"""')
		ed.feed({ kind: "enter" })
		expect(ed.isMultiline).toBe(true)
		expect(ed.text).toBe("")
		type(ed, "line one")
		ed.feed({ kind: "enter" })
		type(ed, "line two")
		ed.feed({ kind: "enter" })
		type(ed, '"""')
		const action = ed.feed({ kind: "enter" })
		expect(action).toEqual({ kind: "submit", text: "line one\nline two" })
		expect(ed.isMultiline).toBe(false)
	})

	test("multiline: escape abandons the block", () => {
		const ed = new LineEditor()
		type(ed, '"""')
		ed.feed({ kind: "enter" })
		type(ed, "abandoned")
		ed.feed({ kind: "escape" })
		expect(ed.isMultiline).toBe(false)
		expect(ed.text).toBe("")
	})

	test("page up and page down surface as scroll actions", () => {
		const ed = new LineEditor()
		expect(ed.feed({ kind: "pageUp" })).toEqual({ kind: "scroll", direction: "up" })
		expect(ed.feed({ kind: "pageDown" })).toEqual({ kind: "scroll", direction: "down" })
	})

	test("ctrl-c cancels", () => {
		const ed = new LineEditor()
		expect(ed.feed({ kind: "ctrl", char: "c" })).toEqual({ kind: "cancel" })
	})
})
