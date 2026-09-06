import { describe, expect, test } from "bun:test"
import { Screen } from "../src/tui/screen"
import { STYLE_DEFAULT, StylePool } from "../src/tui/pools"
import { box, paintRoot, text, wrapText } from "../src/tui/layout"

describe("packed screen", () => {
	test("first frame patches only what was drawn", () => {
		const screen = new Screen(20, 3)
		screen.beginFrame()
		screen.putText(0, 0, "hello")
		const patch = screen.render()
		screen.commit()
		expect(patch).toContain("hello")
		expect(screen.lastStats.patched).toBe(5)
		expect(screen.rowText(0).trimEnd()).toBe("hello")
	})

	test("an unchanged frame produces no bytes at all", () => {
		const screen = new Screen(20, 2)
		for (let i = 0; i < 2; i++) {
			screen.beginFrame()
			screen.putText(0, 0, "steady")
			screen.render()
			screen.commit()
		}
		screen.beginFrame()
		screen.putText(0, 0, "steady")
		expect(screen.render()).toBe("")
		expect(screen.lastStats.damage).toBeNull()
	})

	test("a one-cell change patches a handful of cells, not the screen", () => {
		const screen = new Screen(200, 120)
		const frame = (spinner: string) => {
			screen.beginFrame()
			screen.putText(0, 0, `${spinner} working`)
			const patch = screen.render()
			screen.commit()
			return patch
		}
		frame("|")
		frame("/")
		expect(screen.lastStats.patched).toBeLessThanOrEqual(4)
		expect(screen.lastStats.scanned).toBeLessThan(200 * 120)
	})

	test("far-apart changes do not drag the scan across the whole screen", () => {
		// Regression guard, from a measured bench run: with one bounding rectangle
		// a spinner in the top-left plus a status bar in the bottom-right made the
		// diff scan 23636 cells to patch 5. Damage is per row, so the scan must stay
		// proportional to the two short spans that actually changed.
		const screen = new Screen(200, 120)
		const frame = (spinner: string, tail: string) => {
			screen.beginFrame()
			screen.putText(0, 0, spinner)
			screen.putText(190, 119, tail)
			const patch = screen.render()
			screen.commit()
			return patch
		}
		frame("|", "aaa")
		frame("/", "bbb")
		expect(screen.lastStats.damagedRows).toBe(2)
		expect(screen.lastStats.scanned).toBeLessThanOrEqual(64)
		// The bounding box still spans the screen; only the scan is confined.
		expect(screen.lastStats.damage).toEqual({ top: 0, left: 0, bottom: 119, right: 192 })
	})

	test("a row dirtied in an earlier frame does not pay again later", () => {
		// Spans must be cleared per row, not across the previous row range. A wide
		// row from two frames ago must not be rescanned because a later frame's row
		// range happens to contain it.
		const screen = new Screen(200, 120)
		const frame = (paint: () => void) => {
			screen.beginFrame()
			paint()
			screen.render()
			screen.commit()
		}
		const wide = "x".repeat(200)
		frame(() => screen.putText(0, 60, wide))
		frame(() => {
			screen.putText(0, 60, wide) // identical, so row 60 stays clean
			screen.putText(0, 0, "a")
			screen.putText(199, 119, "b")
		})
		expect(screen.lastStats.damagedRows).toBe(2)
		expect(screen.lastStats.scanned).toBeLessThanOrEqual(8)
	})

	test("synchronized output wraps every non-empty write", () => {
		const screen = new Screen(10, 1)
		screen.beginFrame()
		screen.putText(0, 0, "x")
		const patch = screen.render()
		expect(patch.startsWith("\u001b[?2026h")).toBe(true)
		expect(patch.endsWith("\u001b[?2026l")).toBe(true)
	})

	test("style ids encode visible-on-space in bit 0", () => {
		const screen = new Screen(4, 1)
		const fgOnly = screen.pools.styles.intern({ fg: "#ff0000" })
		const withBg = screen.pools.styles.intern({ bg: "#00ff00" })
		expect(StylePool.visibleOnSpace(fgOnly)).toBe(false)
		expect(StylePool.visibleOnSpace(withBg)).toBe(true)
		expect(fgOnly % 2).toBe(0)
		expect(withBg % 2).toBe(1)
		expect(STYLE_DEFAULT).toBe(0)
	})

	test("wide characters reserve a continuation cell", () => {
		const screen = new Screen(6, 1)
		screen.beginFrame()
		const drawn = screen.putText(0, 0, "\u65e5ab")
		expect(drawn).toBe(4)
		expect(screen.pendingRowText(0).startsWith("\u65e5ab")).toBe(true)
	})

	test("rtl text is flushed to the right edge of its box", () => {
		const screen = new Screen(12, 1)
		screen.beginFrame()
		paintRoot(box([text("\u0645\u0631\u062d\u0628\u0627")]), screen)
		const row = screen.pendingRowText(0)
		expect(row.startsWith(" ")).toBe(true)
		expect(row.trimEnd()).not.toBe("")
		expect(row.endsWith(" ")).toBe(false)
	})

	test("wrapping respects cell width, not code point count", () => {
		expect(wrapText("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"])
		expect(wrapText("\u65e5\u65e5\u65e5", 4)).toEqual(["\u65e5\u65e5", "\u65e5"])
	})
})
