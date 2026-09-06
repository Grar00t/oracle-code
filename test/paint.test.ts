import { describe, expect, test } from "bun:test"
import { box, paint, paintRoot, text } from "../src/tui/layout"
import { clearWrapCache, wrapCached, wrapText } from "../src/tui/lines"
import { Screen } from "../src/tui/screen"
import { stringWidth } from "../src/text/width"

describe("paint pipeline", () => {
	test("a line is shaped once no matter how often it is drawn", () => {
		const screen = new Screen(40, 4)
		const before = screen.lines.misses
		const first = screen.lines.shape("hello world")
		const second = screen.lines.shape("hello world")
		expect(second).toBe(first)
		expect(screen.lines.misses - before).toBe(1)
		// Base direction is part of the identity: it changes the result.
		screen.lines.shape("hello world", "rtl")
		expect(screen.lines.misses - before).toBe(2)
	})

	test("wrapping is cached by width and text, and still respects cells", () => {
		clearWrapCache()
		const source = "one two three four"
		const first = wrapCached(source, 9)
		expect(wrapCached(source, 9)).toBe(first)
		expect(wrapCached(source, 8)).not.toBe(first)
		for (const line of first) expect(stringWidth(line)).toBeLessThanOrEqual(9)
		// Linear width tracking must not lose or reorder words.
		expect(first.join(" ").split(/\s+/).filter(Boolean)).toEqual([
			"one",
			"two",
			"three",
			"four",
		])
		// A wide code point costs two cells, so it must wrap earlier than length.
		expect(wrapText("\u4e00\u4e00\u4e00", 4).length).toBe(2)
	})

	test("repainting an identical tree writes nothing and reads nothing", () => {
		const screen = new Screen(60, 12)
		const tree = box([text("hello"), text("\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645")], {
			border: true,
			padding: 1,
			title: "oracle",
		})

		screen.beginFrame()
		paintRoot(tree, screen)
		const first = screen.render()
		screen