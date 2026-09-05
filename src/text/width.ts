// Cell width table.
//
// FACT (Unicode): combining marks occupy zero cells; East Asian Wide/Fullwidth
// occupy two. A fixed-width grid that ignores this desynchronizes on the first
// emoji or Arabic diacritic, and every later column in the row is wrong.

const ZERO_WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x0300, 0x036f], // combining diacritical marks
	[0x0483, 0x0489],
	[0x0591, 0x05bd],
	[0x0610, 0x061a], // Arabic marks above/below
	[0x064b, 0x065f], // Arabic harakat
	[0x0670, 0x0670],
	[0x06d6, 0x06dc],
	[0x06df, 0x06e4],
	[0x06e7, 0x06e8],
	[0x06ea, 0x06ed],
	[0x0711, 0x0711],
	[0x200b, 0x200f], // zero width space .. RLM
	[0x202a, 0x202e], // bidi embedding controls
	[0x2060, 0x2064],
	[0xfe00, 0xfe0f], // variation selectors
	[0xfe20, 0xfe2f],
]

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x1100, 0x115f], // Hangul Jamo
	[0x2e80, 0x303e], // CJK radicals, Kangxi
	[0x3041, 0x33ff],
	[0x3400, 0x4dbf],
	[0x4e00, 0x9fff],
	[0xa000, 0xa4cf],
	[0xac00, 0xd7a3], // Hangul syllables
	[0xf900, 0xfaff],
	[0xfe10, 0xfe19],
	[0xfe30, 0xfe6f],
	[0xff00, 0xff60], // fullwidth forms
	[0xffe0, 0xffe6],
	[0x1f300, 0x1f64f], // emoji
	[0x1f900, 0x1f9ff],
	[0x20000, 0x3fffd],
]

function inRanges(
	cp: number,
	ranges: ReadonlyArray<readonly [number, number]>,
): boolean {
	let lo = 0
	let hi = ranges.length - 1
	while (lo <= hi) {
		const mid = (lo + hi) >> 1
		const range = ranges[mid]!
		if (cp < range[0]) hi = mid - 1
		else if (cp > range[1]) lo = mid + 1
		else return true
	}
	return false
}

export function codePointWidth(cp: number): 0 | 1 | 2 {
	if (cp === 0x00ad) return 1
	if (cp < 0x0300) return cp < 0x20 ? 0 : 1
	if (inRanges(cp, ZERO_WIDTH_RANGES)) return 0
	if (inRanges(cp, WIDE_RANGES)) return 2
	return 1
}

/** Width of a string in terminal cells, ignoring escape sequences. */
export function stringWidth(text: string): number {
	let total = 0
	for (const ch of text) total += codePointWidth(ch.codePointAt(0)!)
	return total
}

/**
 * Split a string into render clusters: a base code point plus its trailing
 * zero-width marks. One cluster occupies exactly one grid position (or two,
 * for wide characters), which is what keeps Arabic harakat from stealing cells.
 */
export function clusters(text: string): string[] {
	const out: string[] = []
	for (const ch of text) {
		const w = codePointWidth(ch.codePointAt(0)!)
		if (w === 0 && out.length > 0) out[out.length - 1] += ch
		else out.push(ch)
	}
	return out
}
