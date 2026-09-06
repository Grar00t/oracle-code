import { describe, expect, test } from "bun:test"
import { classify, reorderLine } from "../src/text/bidi"

// Regression cover for the classification-order defect.
//
// Every Arabic-script digit and numeric separator lies inside the strong-RTL
// span 0x0600..0x07BF. When classify() tested that span before the numeric
// branches, U+06F0..U+06F9, U+066B and U+066C were returned as R, the AN branch
// for the extended digits was unreachable, and reorderLine reversed the digits
// of a number along with the run around it.
//
// Every assertion in this file fails on the previous revision of src/text/bidi.ts.

const SEEN = "\u0633\u0639\u0631" // س ع ر

function digitsOf(text: string, lo: number, hi: number): string {
	return [...text]
		.filter((ch) => {
			const cp = ch.codePointAt(0)!
			return cp >= lo && cp <= hi
		})
		.join("")
}

describe("bidi numeric classes", () => {
	test("extended Arabic-Indic digits are AN, not R", () => {
		for (let cp = 0x06f0; cp <= 0x06f9; cp++) {
			expect(classify(cp)).toBe("AN")
		}
	})

	test("Arabic decimal and thousands separators are AN", () => {
		expect(classify(0x066b)).toBe("AN")
		expect(classify(0x066c)).toBe("AN")
	})

	test("standard Arabic-Indic digits stay AN", () => {
		for (let cp = 0x0660; cp <= 0x0669; cp++) {
			expect(classify(cp)).toBe("AN")
		}
	})

	test("Arabic letters are still strong RTL", () => {
		expect(classify(0x0633)).toBe("R")
		expect(classify(0x0645)).toBe("R")
		expect(classify(0xfedf)).toBe("R") // a presentation form
	})

	test("extended Arabic-Indic digits keep logical order in an RTL line", () => {
		const visual = reorderLine(`${SEEN} \u06f1\u06f2\u06f3`)
		expect(digitsOf(visual, 0x06f0, 0x06f9)).toBe("\u06f1\u06f2\u06f3")
	})

	test("standard Arabic-Indic digits keep logical order in an RTL line", () => {
		const visual = reorderLine(`${SEEN} \u0661\u0662\u0663`)
		expect(digitsOf(visual, 0x0660, 0x0669)).toBe("\u0661\u0662\u0663")
	})

	test("a thousands separator stays inside its number", () => {
		const visual = reorderLine(`${SEEN} \u0661\u066c\u0662\u0663\u0664`)
		expect(digitsOf(visual, 0x0660, 0x066c)).toBe("\u0661\u066c\u0662\u0663\u0664")
	})

	test("reordering preserves the character count for numeric lines", () => {
		const samples = [
			`${SEEN} \u06f1\u06f2\u06f3`,
			`${SEEN} \u0661\u066c\u0662\u0663\u0664`,
			`${SEEN} \u06f1\u066b\u06f5 \u0645\u0646`,
		]
		for (const sample of samples) {
			expect([...reorderLine(sample)].length).toBe([...sample].length)
		}
	})
})
