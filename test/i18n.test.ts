// Interface language. The interesting tests are not "is the word translated",
// they are "does an Arabic line survive the trip to the grid": shaping,
// reordering, digits kept in logical order, and a base direction that comes
// from the interface rather than from whichever character happens to be first.

import { describe, expect, test } from "bun:test"
import {
	LANGS,
	direction,
	keys,
	lineDirection,
	nextLang,
	resolveLang,
	t,
	visual,
} from "../src/i18n/index"
import { stringWidth } from "../src/text/width"

describe("L1 language resolution", () => {
	test("the default is english, not a guess from the machine", () => {
		expect(resolveLang({})).toBe("en")
	})

	test("ORACLE_LANG wins over the locale", () => {
		expect(resolveLang({ ORACLE_LANG: "ar", LANG: "en_US.UTF-8" })).toBe("ar")
		expect(resolveLang({ ORACLE_LANG: "en", LANG: "ar_SA.UTF-8" })).toBe("en")
	})

	test("an arabic locale is honoured when nothing is set explicitly", () => {
		expect(resolveLang({ LANG: "ar_SA.UTF-8" })).toBe("ar")
		expect(resolveLang({ LC_ALL: "ar_EG.UTF-8", LANG: "en_US.UTF-8" })).toBe("ar")
	})

	test("an unsupported language falls back to english instead of half translating", () => {
		expect(resolveLang({ ORACLE_LANG: "fr" })).toBe("en")
		expect(resolveLang({ ORACLE_LANG: "ar-SA" })).toBe("ar")
	})

	test("the switch cycles and returns to where it started", () => {
		expect(nextLang("en")).toBe("ar")
		expect(nextLang(nextLang("en"))).toBe("en")
		expect(LANGS.length).toBe(2)
		expect(direction("ar")).toBe("rtl")
		expect(direction("en")).toBe("ltr")
	})
})

describe("L2 the two tables stay equal", () => {
	test("every key exists in both languages and none is empty", () => {
		for (const key of keys()) {
			for (const lang of LANGS) {
				expect(typeof t(key, lang)).toBe("string")
				expect(t(key, lang).length).toBeGreaterThan(0)
			}
		}
		expect(keys().length).toBeGreaterThan(15)
	})

	test("the only string shared by both tables is the prompt glyph", () => {
		const shared = keys().filter((key) => t(key, "en") === t(key, "ar"))
		expect(shared).toEqual(["prompt"])
	})

	test("arabic strings are arabic, not transliteration", () => {
		expect(/[\u0600-\u06ff]/.test(t("ready", "ar"))).toBe(true)
		expect(/[\u0600-\u06ff]/.test(t("working", "ar"))).toBe(true)
		expect(/[\u0600-\u06ff]/.test(t("ready", "en"))).toBe(false)
	})
})

describe("L3 what the terminal actually receives", () => {
	test("a latin line is returned untouched", () => {
		expect(visual("ready.", "en")).toBe("ready.")
		expect(visual("ckpt 3  \u00b7  12.40ms", "ar")).toBe("ckpt 3  \u00b7  12.40ms")
	})

	test("an arabic word arrives shaped and in visual order", () => {
		// Two behs: initial then final, and the pair reversed for the screen.
		expect(visual("\u0628\u0628", "ar")).toBe("\ufe90\ufe91")
	})

	test("no unshaped arabic letter survives the pipeline", () => {
		const out = visual(t("nothingToUndo", "ar"), "ar")
		expect(/[\u0621-\u064a]/.test(out)).toBe(false)
	})

	test("digits inside an arabic sentence keep their own order", () => {
		const out = visual("\u0627\u0644\u0625\u0635\u062f\u0627\u0631 12", "ar")
		expect(out).toContain("12")
		expect(out).not.toContain("21")
	})

	test("a latin tool name at the start does not flip the arabic after it", () => {
		// Same sentence, once with the interface in arabic and once in english.
		// Base direction must come from the interface, so the two differ.
		const line = "rg \u0627\u0644\u0628\u062d\u062b \u062a\u0645"
		expect(visual(line, "ar")).not.toBe(visual(line, "en"))
		expect(lineDirection(line, "ar")).toBe("rtl")
		expect(lineDirection(line, "en")).toBe("ltr")
		expect(lineDirection("ckpt 3", "ar")).toBe("ltr")
	})

	test("reordering never changes how many cells the line needs", () => {
		for (const key of keys()) {
			const logical = t(key, "ar")
			const shown = visual(logical, "ar")
			expect(stringWidth(shown)).toBe(stringWidth(visual(shown, "en")))
			expect([...shown].length).toBeGreaterThan(0)
		}
	})
})
