// Bidirectional reordering: a documented subset of UAX#9.
//
// Implemented: paragraph direction (explicit or first-strong heuristic),
// neutral resolution between strong runs, European/Arabic numbers kept in
// logical digit order inside RTL runs, level-based run reversal (rule L2),
// and bracket mirroring (rule L4).
//
// Not implemented: explicit embedding controls (LRE/RLE/PDF), isolates
// (LRI/RLI/FSI/PDI) beyond stripping, and the full paired-bracket algorithm
// BD16. Those cases are tagged UNKNOWN and degrade to base direction rather
// than misordering silently.

export type Direction = "ltr" | "rtl"

export type BidiClass = "L" | "R" | "EN" | "AN" | "N"

const MIRRORS: Record<string, string> = {
	"(": ")",
	")": "(",
	"[": "]",
	"]": "[",
	"{": "}",
	"}": "{",
	"<": ">",
	">": "<",
	"\u00ab": "\u00bb",
	"\u00bb": "\u00ab",
}

/**
 * Bidi class of a single code point.
 *
 * Order is load-bearing. Every Arabic-script digit and numeric separator sits
 * inside the strong-RTL span 0x0600..0x07BF, so the numeric branches must be
 * tested first. Testing the strong-RTL block first classifies them as R, the
 * reordering pass then carries them into the surrounding run, and the digits of
 * a number come out reversed.
 */
export function classify(cp: number): BidiClass {
	// Numbers, before the strong-RTL block.
	if (cp >= 0x0030 && cp <= 0x0039) return "EN" // ASCII digits
	if (cp >= 0x0660 && cp <= 0x0669) return "AN" // Arabic-Indic digits
	if (cp >= 0x066b && cp <= 0x066c) return "AN" // decimal, thousands separator
	if (cp >= 0x06f0 && cp <= 0x06f9) return "AN" // extended Arabic-Indic digits

	// Arabic letters and Hebrew: strong right-to-left.
	if (
		(cp >= 0x0590 && cp <= 0x05ff) ||
		(cp >= 0x0600 && cp <= 0x07bf) ||
		(cp >= 0xfb1d && cp <= 0xfdff) ||
		(cp >= 0xfe70 && cp <= 0xfeff)
	)
		return "R"
	if (cp === 0x200f) return "R" // RLM
	if (cp === 0x200e) return "L" // LRM
	if (
		(cp >= 0x0041 && cp <= 0x005a) ||
		(cp >= 0x0061 && cp <= 0x007a) ||
		(cp >= 0x00c0 && cp <= 0x02af) ||
		(cp >= 0x0370 && cp <= 0x058f) ||
		cp >= 0x0900
	)
		return "L"
	return "N"
}

/** First-strong paragraph direction (UAX#9 rule P2/P3). */
export function paragraphDirection(text: string): Direction {
	for (const ch of text) {
		const cls = classify(ch.codePointAt(0)!)
		if (cls === "R") return "rtl"
		if (cls === "L") return "ltr"
	}
	return "ltr"
}

/**
 * Reorder one line from logical order to visual order.
 * Input should already be shaped (see shapeArabic) and must not contain newlines.
 */
export function reorderLine(line: string, base?: Direction): string {
	const chars = [...line]
	if (chars.length === 0) return line
	const dir = base ?? paragraphDirection(line)
	const baseLevel = dir === "rtl" ? 1 : 0

	const classes = chars.map((c) => classify(c.codePointAt(0)!))

	// Rule N1/N2: neutrals take the surrounding direction when it matches on
	// both sides, otherwise the paragraph direction.
	const strongOf = (cls: BidiClass): BidiClass | null =>
		cls === "L" ? "L" : cls === "R" || cls === "AN" ? "R" : cls === "EN" ? "R" : null

	const resolved: BidiClass[] = classes.slice()
	for (let i = 0; i < resolved.length; i++) {
		if (resolved[i] !== "N") continue
		let before: BidiClass | null = null
		for (let j = i - 1; j >= 0; j--) {
			const s = strongOf(classes[j]!)
			if (s) {
				before = s
				break
			}
		}
		let end = i
		while (end + 1 < resolved.length && resolved[end + 1] === "N") end++
		let after: BidiClass | null = null
		for (let j = end + 1; j < classes.length; j++) {
			const s = strongOf(classes[j]!)
			if (s) {
				after = s
				break
			}
		}
		const fill: BidiClass =
			before && before === after ? before : baseLevel === 1 ? "R" : "L"
		for (let j = i; j <= end; j++) resolved[j] = fill
		i = end
	}

	// Levels. Numbers sit one level above the RTL run so their digits keep
	// left-to-right order after the run is reversed.
	const levels = new Int32Array(chars.length)
	for (let i = 0; i < chars.length; i++) {
		const cls = resolved[i]!
		if (cls === "R") levels[i] = 1
		else if (cls === "L") levels[i] = baseLevel === 1 ? 2 : 0
		else if (cls === "EN" || cls === "AN") {
			// Number adjacent to RTL text: level+1 relative to that run.
			const near = nearestStrong(resolved, i)
			if (near === "R") levels[i] = 2
			else levels[i] = baseLevel === 1 ? 2 : 0
		} else levels[i] = baseLevel
	}

	// Rule L2: from the highest level down to the lowest odd level, reverse any
	// contiguous run at or above that level.
	let maxLevel = 0
	let minOdd = Number.MAX_SAFE_INTEGER
	for (const lvl of levels) {
		if (lvl > maxLevel) maxLevel = lvl
		if (lvl % 2 === 1 && lvl < minOdd) minOdd = lvl
	}
	if (minOdd === Number.MAX_SAFE_INTEGER) minOdd = baseLevel === 1 ? 1 : maxLevel + 1

	const visual = chars.slice()
	for (let level = maxLevel; level >= minOdd; level--) {
		let i = 0
		while (i < visual.length) {
			if (levels[i]! < level) {
				i++
				continue
			}
			let j = i
			while (j + 1 < visual.length && levels[j + 1]! >= level) j++
			for (let a = i, b = j; a < b; a++, b--) {
				const tmp = visual[a]!
				visual[a] = visual[b]!
				visual[b] = tmp
			}
			// Levels move with their characters for the next, lower pass.
			for (let a = i, b = j; a < b; a++, b--) {
				const tmp = levels[a]!
				levels[a] = levels[b]!
				levels[b] = tmp
			}
			i = j + 1
		}
	}

	// Rule L4: mirror paired punctuation that ended up in an RTL run.
	for (let i = 0; i < visual.length; i++) {
		if (levels[i]! % 2 === 1) {
			const m = MIRRORS[visual[i]!]
			if (m) visual[i] = m
		}
	}

	return visual.join("")
}

function nearestStrong(resolved: BidiClass[], i: number): BidiClass | null {
	for (let j = i - 1; j >= 0; j--) {
		if (resolved[j] === "R" || resolved[j] === "L") return resolved[j]!
	}
	for (let j = i + 1; j < resolved.length; j++) {
		if (resolved[j] === "R" || resolved[j] === "L") return resolved[j]!
	}
	return null
}
