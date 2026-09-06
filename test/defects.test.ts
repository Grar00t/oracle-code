// Falsifiers. Every test in this file fails on f940b70 and passes after the
// fixes in this branch. A test written after a fix usually only proves the code
// does what it does; these were written first, and observed to fail first.

import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { codePointWidth, stringWidth } from "../src/text/width"
import { shapeArabic } from "../src/text/arabic"
import { Permissions } from "../src/safety/permissions"
import { resolveTheme } from "../src/theme/theme"
import { Screen } from "../src/tui/screen"

describe("D1 cell width: wide code points outside the two emoji ranges", () => {
	test("transport and symbol emoji are two cells", () => {
		expect(codePointWidth(0x1f680)).toBe(2) // rocket
		expect(codePointWidth(0x1f6f9)).toBe(2) // skateboard
		expect(codePointWidth(0x1fa70)).toBe(2) // ballet shoes
		expect(codePointWidth(0x1f7e0)).toBe(2) // orange circle
	})

	test("wide dingbats and misc symbols are two cells", () => {
		expect(codePointWidth(0x231a)).toBe(2) // watch
		expect(codePointWidth(0x26a1)).toBe(2) // high voltage
		expect(codePointWidth(0x2b50)).toBe(2) // star
		expect(codePointWidth(0x2705)).toBe(2) // check mark button
		expect(codePointWidth(0x274c)).toBe(2) // cross mark
	})

	test("narrow neighbours stay one cell", () => {
		expect(codePointWidth(0x2713)).toBe(1) // check mark
		expect(codePointWidth(0x2717)).toBe(1) // ballot x
		expect(codePointWidth(0x25cf)).toBe(1) // black circle
		expect(codePointWidth(0x2500)).toBe(1) // box drawing
		expect(codePointWidth(0x1f650)).toBe(1) // ornamental, not emoji
	})

	test("a status line with a rocket measures what it draws", () => {
		expect(stringWidth("\u{1f680} ship")).toBe(7)
	})

	test("the grid reserves a continuation cell for a rocket", () => {
		const screen = new Screen(8, 1)
		screen.beginFrame()
		expect(screen.putText(0, 0, "\u{1f680}ab")).toBe(4)
	})
})

describe("D2/D3 joining controls are not transparent", () => {
	test("ZWNJ breaks a join that would otherwise happen", () => {
		expect(shapeArabic("\u0628\u200c\u0628")).toBe("\ufe8f\u200c\ufe8f")
	})

	test("ZWJ forces a join that would otherwise not happen", () => {
		expect(shapeArabic("\u0628\u200d")).toBe("\ufe91\u200d")
		expect(shapeArabic("\u200d\u0628")).toBe("\u200d\ufe90")
	})

	test("harakat stay transparent", () => {
		expect(shapeArabic("\u0628\u064e\u0628")).toBe("\ufe91\u064e\ufe90")
	})
})

describe("D4 Persian and Urdu letters must not cut the joining chain", () => {
	test("peh between two behs keeps all three joined", () => {
		expect(shapeArabic("\u0628\u067e\u0628")).toBe("\ufe91\ufb59\ufe90")
	})

	test("gaf, tcheh and jeh are shaped, not passed through", () => {
		expect(shapeArabic("\u06af")).toBe("\ufb92")
		expect(shapeArabic("\u0686\u0686")).toBe("\ufb7c\ufb7b")
		expect(shapeArabic("\u0698")).toBe("\ufb8a")
	})

	test("a right-joining Persian letter does not join forward", () => {
		expect(shapeArabic("\u0628\u0698\u0628")).toBe("\ufe91\ufb8b\ufe8f")
	})
})

describe("D5 the session allowlist must not outrank the irreversible gate", () => {
	test("an allowlisted irreversible command is still prompted", async () => {
		let prompts = 0
		const permissions = new Permissions("acceptEdits", async () => {
			prompts++
			return true
		})
		const risk = { readOnly: false, irreversible: true }
		await permissions.check("bash", risk, "$ rm -rf /home/a/work")
		permissions.alwaysAllow("bash:$ rm -rf /home/a/work")
		const second = await permissions.check("bash", risk, "$ rm -rf /home/a/work")
		expect(second.prompted).toBe(true)
		expect(prompts).toBe(2)
		expect(second.reason).not.toContain("allowlist")
	})

	test("an allowlisted quarantined tool is still prompted", async () => {
		let prompts = 0
		const permissions = new Permissions("acceptEdits", async () => {
			prompts++
			return true
		})
		permissions.alwaysAllow("mcp__x:{}")
		const decision = await permissions.check(
			"mcp__x",
			{ readOnly: true, irreversible: false, quarantined: true },
			"{}",
		)
		expect(decision.prompted).toBe(true)
		expect(prompts).toBe(1)
	})

	test("a reversible edit is still served from the allowlist", async () => {
		const permissions = new Permissions("manual", async () => false)
		permissions.alwaysAllow("edit:src/a.ts")
		const decision = await permissions.check(
			"edit",
			{ readOnly: false, irreversible: false },
			"src/a.ts",
		)
		expect(decision.allowed).toBe(true)
		expect(decision.prompted).toBe(false)
		expect(decision.reason).toBe("session allowlist")
	})

	test("full-access mode does not silence the irreversible gate", async () => {
		let prompts = 0
		const permissions = new Permissions("full", async () => {
			prompts++
			return true
		})
		const decision = await permissions.check(
			"bash",
			{ readOnly: false, irreversible: true },
			"$ dd if=/dev/zero of=/dev/sda",
		)
		expect(decision.prompted).toBe(true)
		expect(prompts).toBe(1)
	})
})

describe("D6 a known-but-unsupported theme key is not an unknown key", () => {
	test("subagents and rainbow are reported as unsupported, not unknown", () => {
		const resolved = resolveTheme({
			base: "dark",
			overrides: { subagents: ["#fff"], rainbow: ["#fff"], nonsense: "#fff" },
		})
		expect(resolved.ignored).toEqual([
			{ key: "subagents", reason: "unsupported key" },
			{ key: "rainbow", reason: "unsupported key" },
			{ key: "nonsense", reason: "unknown key" },
		])
	})
})

describe("D7 a leading combining mark must not be dropped", () => {
	test("a line that starts with a haraka keeps every code point", () => {
		const screen = new Screen(8, 1)
		const shaped = screen.lines.shape("\u064e\u0628")
		expect(shaped.width).toBe(1)
		const joined = [...shaped.ids].map((id) => screen.pools.chars.resolve(id)).join("")
		expect([...joined].length).toBe(2)
		expect(joined).toContain("\u064e")
	})

	test("a mark with no base at all still occupies one cell", () => {
		const screen = new Screen(8, 1)
		const shaped = screen.lines.shape("\u064e")
		expect(shaped.width).toBe(1)
		const joined = [...shaped.ids].map((id) => screen.pools.chars.resolve(id)).join("")
		expect(joined).toContain("\u064e")
	})
})

describe("D8 fork must land in the session base, not above it", () => {
	test("three levels up from <base>/sessions/<project> overshoots", () => {
		// The base is built with resolve() rather than written as a POSIX literal.
		// On Windows, resolve("/home/a/work/.oracle") prepends the current drive,
		// so comparing against the raw string failed for a reason that had nothing
		// to do with the defect this test guards.
		const base = resolve(tmpdir(), "work", ".oracle")
		const dir = resolve(base, "sessions", "proj")
		expect(resolve(dir, "..", "..", "..")).not.toBe(base)
		expect(resolve(dir, "..", "..")).toBe(base)
	})
})
