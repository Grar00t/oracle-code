import { describe, expect, test } from "bun:test"
import { paragraphDirection, reorderLine } from "../src/text/bidi"
import { layoutLine } from "../src/text"

describe("bidi", () => {
	test("paragraph direction uses the first strong character", () => {
		expect(paragraphDirection("hello \u0645\u0631\u062d\u0628\u0627")).toBe("ltr")
		expect(paragraphDirection("\u0645\u0631\u062d\u0628\u0627 hello")).toBe("rtl")
		expect(paragraphDirection("   42 \u0645")).toBe("rtl")
	})

	test("an rtl run is reversed", () => {
		expect(reorderLine("\u0623\u0628\u062c", "rtl")).toBe("\u062c\u0628\u0623")
	})

	test("latin inside an rtl paragraph keeps its own order", () => {
		const visual = reorderLine("\u0623\u0628 bun \u062c\u062f", "rtl")
		expect(visual).toContain("bun")
		expect(visual.indexOf("b")).toBeLessThan(visual.indexOf("n"))
	})

	test("digits keep logical order inside an rtl run", () => {
		const visual = reorderLine("\u0645 2026 \u0646", "rtl")
		expect(visual).toContain("2026")
	})

	test("reordering never changes the character count", () => {
		const samples = [
			"\u0645\u0631\u062d\u0628\u0627 oracle 12",
			"mixed \u0639\u0631\u0628\u064a (\u0642\u0648\u0633) tail",
			"\u0625\u0644\u0649 127.0.0.1:8080",
		]
		for (const sample of samples) {
			expect([...reorderLine(sample)].length).toBe([...sample].length)
		}
	})

	test("brackets are mirrored in rtl runs", () => {
		const visual = reorderLine("\u0645(\u0646)", "rtl")
		expect(visual.startsWith("(")).toBe(true)
	})

	test("layoutLine keeps ascii on the fast path", () => {
		const laid = layoutLine("plain ascii")
		expect(laid.direction).toBe("ltr")
		expect(laid.width).toBe("plain ascii".length)
	})
})
