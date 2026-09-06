// Interface language. The program ships English only, so these tests are about
// the machinery, not about vocabulary: does a pack get rejected when it is
// incomplete, and does a right-to-left line survive the trip to the grid.

import { describe, expect, test } from "bun:test"
import {
	ENGLISH,
	activeLanguage,
	direction,
	keys,
	langPath,
	resetLanguage,
	resolveLangCode,
	setLanguage,
	t,
	validatePack,
	visual,
	type StringKey,
} from "../src/i18n/index"
import { stringWidth } from "../src/text/width"

function fullPack(fill: (key: StringKey) => string) {
	const strings: Record<string, string> = {}
	for (const key of keys()) strings[key] = fill(key)
	return strings
}

describe("L1 which pack is asked for", () => {
	test("english unless the user says otherwise", () => {
		expect(resolveLangCode({})).toBe("en")
		expect(resolveLangCode({ LANG: "C" })).toBe("en")
		expect(resolveLangCode({ LANG: "POSIX" })).toBe("en")
	})

	test("ORACLE_LANG wins over the locale", () => {
		expect(resolveLangCode({ ORACLE_LANG: "fr", LANG: "de_DE.UTF-8" })).toBe("fr")
	})

	test("a locale is reduced to its language code", () => {
		expect(resolveLangCode({ LANG: "pt_BR.UTF-8" })).toBe("pt")
		expect(resolveLangCode({ LC_ALL: "ja_JP.UTF-8", LANG: "en_US.UTF-8" })).toBe("ja")
	})

	test("the pack path is absolute and named after the code", () => {
		const path = langPath("xx")
		expect(path.endsWith("xx.json")).toBe(true)
		expect(path.includes("undefined")).toBe(false)
		expect(path.length).toBeGreaterThan("xx.json".length)
	})
})

describe("L2 a pack is refused unless it is complete", () => {
	test("the shipped english pack is complete and non-empty", () => {
		for (const key of keys()) {
			expect(typeof ENGLISH.strings[key]).toBe("string")
			expect(ENGLISH.strings[key].length).toBeGreaterThan(0)
		}
		expect(keys().length).toBeGreaterThan(15)
	})

	test("a missing key names itself instead of falling back silently", () => {
		const strings = fullPack((key) => `x-${key}`)
		delete strings.ready
		const result = validatePack("xx", { direction: "ltr", strings })
		expect(result.pack).toBeNull()
		expect(result.missing).toEqual(["ready"])
	})

	test("an empty string counts as missing", () => {
		const strings = fullPack((key) => (key === "working" ? "   " : `x-${key}`))
		expect(validatePack("xx", { strings }).missing).toEqual(["working"])
	})

	test("unknown keys are reported, not swallowed", () => {
		const strings = fullPack((key) => `x-${key}`)
		strings.redy = "typo"
		const result = validatePack("xx", { strings })
		expect(result.pack).not.toBe(null)
		expect(result.ignored).toEqual(["redy"])
	})

	test("a bad direction is refused rather than guessed", () => {
		const result = validatePack("xx", { direction: "sideways", strings: fullPack(() => "x") })
		expect(result.pack).toBeNull()
		expect(result.reason).toContain("direction")
	})

	test("a pack that is not an object is refused", () => {
		expect(validatePack("xx", "nope").pack).toBeNull()
		expect(validatePack("xx", [1, 2]).pack).toBeNull()
		expect(validatePack("xx", null).pack).toBeNull()
	})
})

describe("L3 what the terminal actually receives", () => {
	test("english is the active language until a pack replaces it", () => {
		resetLanguage()
		expect(activeLanguage().code).toBe("en")
		expect(direction()).toBe("ltr")
		expect(t("ready")).toBe("ready.")
		expect(visual("ckpt 3  \u00b7  12.40ms")).toBe("ckpt 3  \u00b7  12.40ms")
	})

	test("an rtl pack shapes and reorders, an ltr pack does not", () => {
		resetLanguage()
		// Two behs: initial then final, and the pair reversed for the screen.
		const word = "\u0628\u0628"
		setLanguage({ code: "xx", direction: "rtl", strings: fullPack(() => "x") })
		expect(visual(word)).toBe("\ufe90\ufe91")
		resetLanguage()
		expect(visual(word)).toBe("\ufe91\ufe90")
	})

	test("no unshaped letter survives an rtl pack", () => {
		resetLanguage()
		setLanguage({ code: "xx", direction: "rtl", strings: fullPack(() => "x") })
		const out = visual("\u0645\u0631\u062d\u0628\u0627 \u0628\u0643")
		expect(/[\u0621-\u064a]/.test(out)).toBe(false)
	})

	test("digits keep their own order inside a reordered line", () => {
		resetLanguage()
		setLanguage({ code: "xx", direction: "rtl", strings: fullPack(() => "x") })
		const out = visual("\u0627\u0644\u0625\u0635\u062f\u0627\u0631 12")
		expect(out).toContain("12")
		expect(out).not.toContain("21")
	})

	test("base direction comes from the pack, not from the first character", () => {
		resetLanguage()
		const line = "rg \u0627\u0644\u0628\u062d\u062b \u062a\u0645"
		const ltr = visual(line)
		setLanguage({ code: "xx", direction: "rtl", strings: fullPack(() => "x") })
		expect(visual(line)).not.toBe(ltr)
	})

	test("reordering never changes how many cells a line needs", () => {
		resetLanguage()
		const line = "\u0645\u0631\u062d\u0628\u0627 12 ok"
		const before = stringWidth(line)
		setLanguage({ code: "xx", direction: "rtl", strings: fullPack(() => "x") })
		expect(stringWidth(visual(line))).toBe(before)
	})

	test("a lam-alef pair is the one case that legitimately narrows the line", () => {
		// Two code points become one ligature, so the line needs one cell less.
		// Measured, not assumed: layout code must not treat width as invariant.
		resetLanguage()
		const line = "\u0644\u0627"
		setLanguage({ code: "xx", direction: "rtl", strings: fullPack(() => "x") })
		const shown = visual(line)
		expect([...shown].length).toBe(1)
		expect(stringWidth(shown)).toBe(stringWidth(line) - 1)
	})

	test("a pack with no rtl text costs nothing and reads back", () => {
		resetLanguage()
		setLanguage({ code: "xx", direction: "ltr", strings: fullPack((key) => `x-${key}`) })
		expect(t("ready")).toBe("x-ready")
		expect(visual("plain ascii line")).toBe("plain ascii line")
	})
})
