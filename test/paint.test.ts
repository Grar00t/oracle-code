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
		// Base direction is part of the identity: it can change the result.
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
		// The linear width tracking must not lose, merge or reorder words.
		expect(first.join(" ").split(/\s+/).filter(Boolean)).toEqual([
			"one",
			"two",
			"three",
			"four",
		])
		// Three wide code points are six cells, so four cells cannot hold them.
		expect(wrapText("\u4e00\u4e00\u4e00", 4).length).toBe(2)
	})

	test("repainting an identical tree writes nothing and reads nothing", () => {
		const screen = new Screen(60, 12)
		const tree = box(
			[
				text("hello"),
				text("\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645"),
			],
			{ border: true, padding: 1, title: "oracle" },
		)

		screen.beginFrame()
		paintRoot(tree, screen)
		const first = screen.render()
		screen.commit()
		expect(first.length).toBeGreaterThan(0)

		const shapesAfterFirst = screen.lines.misses

		screen.beginFrame()
		paintRoot(tree, screen)
		const second = screen.render()
		screen.commit()

		// Byte-identical output is the correctness proof for the cached cell ids.
		expect(second).toBe("")
		expect(screen.lastStats.patched).toBe(0)
		expect(screen.lastStats.scanned).toBe(0)
		expect(screen.lines.misses).toBe(shapesAfterFirst)
	})

	test("the cached path draws the same row as the uncached one", () => {
		const word = "\u0633\u0644\u0627\u0645"

		const viaTree = new Screen(10, 1)
		viaTree.beginFrame()
		paint(text(word), viaTree, 0, 0, 10, 1)
		viaTree.render()
		viaTree.commit()

		const direct = new Screen(10, 1)
		direct.beginFrame()
		direct.fill({ top: 0, left: 0, bottom: 0, right: 9 })
		const shaped = direct.lines.shape(word)
		direct.putText(10 - shaped.width, 0, word)
		direct.render()
		direct.commit()

		expect(viaTree.rowText(0)).toBe(direct.rowText(0))
		// Four code points, one lam-alef ligature, three cells, flushed right.
		expect(shaped.width).toBe(3)
		expect(viaTree.rowText(0).trimStart().length).toBe(3)
		expect(viaTree.rowText(0).slice(0, 7)).toBe("       ")
	})
})
