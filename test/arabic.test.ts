import { describe, expect, test } from "bun:test"
import { hasArabic, shapeArabic } from "../src/text/arabic"
import { clusters, stringWidth } from "../src/text/width"

describe("arabic shaping", () => {
	test("isolated letter stays isolated", () => {
		expect(shapeArabic("\u0628")).toBe("\ufe8f")
	})

	test("initial, medial and final forms are selected by context", () => {
		// beh + beh + beh -> initial, medial, final
		expect(shapeArabic("\u0628\u0628\u0628")).toBe("\ufe91\ufe92\ufe90")
	})

	test("right-joining letters do not join forward", () => {
		// dal is right-joining: beh before it is initial, meem after it is isolated
		expect(shapeArabic("\u0628\u062f\u0645")).toBe("\ufe91\ufeaa\ufee1")
	})

	test("lam-alef ligature replaces two code points", () => {
		// seen + lam + alef + meem  ->  seen initial, lam-alef final, meem isolated
		const shaped = shapeArabic("\u0633\u0644\u0627\u0645")
		expect(shaped).toBe("\ufeb3\ufefc\ufee1")
		expect([...shaped]).toHaveLength(3)
	})

	test("harakat are transparent to joining and take zero cells", () => {
		// beh + fatha + beh: the mark must not break the join
		const shaped = shapeArabic("\u0628\u064e\u0628")
		expect(shaped.startsWith("\ufe91")).toBe(true)
		expect(shaped.endsWith("\ufe90")).toBe(true)
		expect(stringWidth(shaped)).toBe(2)
		expect(clusters(shaped)).toHaveLength(2)
	})

	test("latin text passes through untouched", () => {
		expect(shapeArabic("oracle-code 42")).toBe("oracle-code 42")
		expect(hasArabic("oracle-code")).toBe(false)
	})
})
