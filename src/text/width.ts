// Cell width table.
//
// FACT (Unicode): combining marks occupy zero cells; East Asian Wide/Fullwidth
// occupy two. A fixed-width grid that ignores this desynchronizes on the first
// emoji or Arabic diacritic, and every later column in the row is wrong.
//
// The wide table is derived from EastAsianWidth W and F plus the
// Emoji_Presentation code points that terminals render double-wide. It is NOT
// "the emoji blocks": U+1F650..U+1F67F sits inside the emoji planes and is one
// cell, while U+231A, U+26A1 and U+2B50 sit among narrow symbols and are two.
// Guessing by block desynchronizes the grid, which is the exact failure this
// file exists to stop.

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

// Must stay sorted ascending and non-overlapping: inRanges binary-searches it.
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x1100, 0x115f], // Hangul Jamo
	[0x231a, 0x231b], // watch, hourglass
	[0x2329, 0x232a], // angle brackets (EAW W)
	[0x23e9, 0x23ec], // fast-forward .. fast down
	[0x23f0, 0x23f0], // alarm clock
	[0x23f3, 0x23f3], // hourglass flowing
	[0x25fd, 0x25fe], // small squares
	[0x2614, 0x2615], // umbrella, hot beverage
	[0x2648, 0x2653], // zodiac
	[0x267f, 0x267f], // wheelchair
	[0x2693, 0x2693], // anchor
	[0x26a1, 0x26a1], // high voltage
	[0x26aa, 0x26ab], // circles
	[0x26bd, 0x26be], // ball games
	[0x26c4, 0x26c5], // snowman, sun behind cloud
	[0x26ce, 0x26ce], // ophiuchus
	[0x26d4, 0x26d4], // no entry
	[0x26ea, 0x26ea], // church
	[0x26f2, 0x26f3], // fountain, golf
	[0x26f5, 0x26f5], // sailboat
	[0x26fa, 0x26fa], // tent
	[0x26fd, 0x26fd], // fuel pump
	[0x2705, 0x2705], // check mark button
	[0x270a, 0x270b], // fist, raised hand
	[0x2728, 0x2728], // sparkles
	[0x274c, 0x274c], // cross mark
	[0x274e, 0x274e], // cross mark button
	[0x2753, 0x2755], // question / exclamation marks
	[0x2757, 0x2757], // heavy exclamation
	[0x2795, 0x2797], // heavy plus, minus, divide
	[0x27b0, 0x27b0], // curly loop
	[0x27bf, 0x27bf], // double curly loop
	[0x2b1b, 0x2b1c], // large squares
	[0x2b50, 0x2b50], // star
	[0x2b55, 0x2b55], // heavy circle
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
	[0x1f004, 0x1f004], // mahjong red dragon
	[0x1f0cf, 0x1f0cf], // joker
	[0x1f18e, 0x1f18e], // AB button
	[0x1f191, 0x1f19a], // squared CL .. VS
	[0x1f200, 0x1f2ff], // enclosed ideographic supplement
	[0x1f300, 0x1f64f], // misc symbols and pictographs, emoticons
	[0x1f680, 0x1f6ff], // transport and map symbols
	[0x1f7e0, 0x1f7eb], // coloured circles and squares
	[0x1f7f0, 0x1f7f0], // heavy equals sign
	[0x1f900, 0x1f9ff], // supplemental symbols and pictographs
	[0x1fa70, 0x1faff], // symbols and pictographs extended-A
	[0x20000, 0x3fffd],
]

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
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
 *
 * A mark that arrives before any base is held and attached to the next base,
 * so no code point is silently lost at the start of a line.
 */
export function clusters(text: string): string[] {
	const out: string[] = []
	let leading = ""
	for (const ch of text) {
		const w = codePointWidth(ch.codePointAt(0)!)
		if (w === 0) {
			if (out.length > 0) out[out.length - 1] += ch
			else leading += ch
			continue
		}
		out.push(leading ? leading + ch : ch)
		leading = ""
	}
	// Marks with no base at all still have to be shown somewhere.
	if (leading) out.push(leading)
	return out
}
