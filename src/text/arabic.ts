// Contextual Arabic shaping.
//
// FACT (Unicode 15, Arabic Presentation Forms-B, U+FE70..U+FEFC): every joining
// Arabic letter has either 2 forms (isolated, final) or 4 forms (isolated,
// final, initial, medial), laid out contiguously in that order. Lam + Alef
// forms a mandatory ligature at U+FEF5..U+FEFC.
//
// A fixed-width cell grid does no joining by itself. Terminals render whatever
// code point they are handed, so shaping must happen before the grid, not after.

type Joining = "dual" | "right" | "none"

type LetterForms = {
	/** First code point of the letter's run in Presentation Forms-B. */
	base: number
	/** 1, 2 or 4 available forms. */
	count: 1 | 2 | 4
	joining: Joining
}

// prettier-ignore
const LETTERS: Record<number, LetterForms> = {
	0x0621: { base: 0xfe80, count: 1, joining: "none" },  // hamza
	0x0622: { base: 0xfe81, count: 2, joining: "right" }, // alef madda
	0x0623: { base: 0xfe83, count: 2, joining: "right" }, // alef hamza above
	0x0624: { base: 0xfe85, count: 2, joining: "right" }, // waw hamza
	0x0625: { base: 0xfe87, count: 2, joining: "right" }, // alef hamza below
	0x0626: { base: 0xfe89, count: 4, joining: "dual" },  // yeh hamza
	0x0627: { base: 0xfe8d, count: 2, joining: "right" }, // alef
	0x0628: { base: 0xfe8f, count: 4, joining: "dual" },  // beh
	0x0629: { base: 0xfe93, count: 2, joining: "right" }, // teh marbuta
	0x062a: { base: 0xfe95, count: 4, joining: "dual" },  // teh
	0x062b: { base: 0xfe99, count: 4, joining: "dual" },  // theh
	0x062c: { base: 0xfe9d, count: 4, joining: "dual" },  // jeem
	0x062d: { base: 0xfea1, count: 4, joining: "dual" },  // hah
	0x062e: { base: 0xfea5, count: 4, joining: "dual" },  // khah
	0x062f: { base: 0xfea9, count: 2, joining: "right" }, // dal
	0x0630: { base: 0xfeab, count: 2, joining: "right" }, // thal
	0x0631: { base: 0xfead, count: 2, joining: "right" }, // reh
	0x0632: { base: 0xfeaf, count: 2, joining: "right" }, // zain
	0x0633: { base: 0xfeb1, count: 4, joining: "dual" },  // seen
	0x0634: { base: 0xfeb5, count: 4, joining: "dual" },  // sheen
	0x0635: { base: 0xfeb9, count: 4, joining: "dual" },  // sad
	0x0636: { base: 0xfebd, count: 4, joining: "dual" },  // dad
	0x0637: { base: 0xfec1, count: 4, joining: "dual" },  // tah
	0x0638: { base: 0xfec5, count: 4, joining: "dual" },  // zah
	0x0639: { base: 0xfec9, count: 4, joining: "dual" },  // ain
	0x063a: { base: 0xfecd, count: 4, joining: "dual" },  // ghain
	0x0641: { base: 0xfed1, count: 4, joining: "dual" },  // feh
	0x0642: { base: 0xfed5, count: 4, joining: "dual" },  // qaf
	0x0643: { base: 0xfed9, count: 4, joining: "dual" },  // kaf
	0x0644: { base: 0xfedd, count: 4, joining: "dual" },  // lam
	0x0645: { base: 0xfee1, count: 4, joining: "dual" },  // meem
	0x0646: { base: 0xfee5, count: 4, joining: "dual" },  // noon
	0x0647: { base: 0xfee9, count: 4, joining: "dual" },  // heh
	0x0648: { base: 0xfeed, count: 2, joining: "right" }, // waw
	0x0649: { base: 0xfeef, count: 2, joining: "right" }, // alef maksura
	0x064a: { base: 0xfef1, count: 4, joining: "dual" },  // yeh
}

/** Lam + Alef mandatory ligatures: [isolated, final]. */
const LAM_ALEF: Record<number, readonly [number, number]> = {
	0x0622: [0xfef5, 0xfef6],
	0x0623: [0xfef7, 0xfef8],
	0x0625: [0xfef9, 0xfefa],
	0x0627: [0xfefb, 0xfefc],
}

const TATWEEL = 0x0640

/** Transparent joining class: marks do not break a joining chain. */
function isTransparent(cp: number): boolean {
	return (
		(cp >= 0x064b && cp <= 0x065f) ||
		(cp >= 0x0610 && cp <= 0x061a) ||
		cp === 0x0670 ||
		(cp >= 0x06d6 && cp <= 0x06ed) ||
		cp === 0x200c ||
		cp === 0x200d
	)
}

function joiningOf(cp: number | undefined): Joining {
	if (cp === undefined) return "none"
	if (cp === TATWEEL) return "dual"
	return LETTERS[cp]?.joining ?? "none"
}

/**
 * Replace Arabic letters with their contextual presentation forms.
 * Non-Arabic code points, marks and controls pass through untouched.
 */
export function shapeArabic(input: string): string {
	const cps = [...input].map((c) => c.codePointAt(0)!)
	const out: string[] = []

	const prevJoiner = (i: number): Joining => {
		for (let j = i - 1; j >= 0; j--) {
			const cp = cps[j]!
			if (isTransparent(cp)) continue
			return joiningOf(cp)
		}
		return "none"
	}
	const nextCp = (i: number): number | undefined => {
		for (let j = i + 1; j < cps.length; j++) {
			const cp = cps[j]!
			if (isTransparent(cp)) continue
			return cp
		}
		return undefined
	}

	for (let i = 0; i < cps.length; i++) {
		const cp = cps[i]!
		const letter = LETTERS[cp]
		if (!letter) {
			out.push(String.fromCodePoint(cp))
			continue
		}

		// A previous dual-joining letter (or tatweel) means this letter is joined
		// on its right side, so it takes a final or medial form.
		const joinedBefore = prevJoiner(i) === "dual"
		const after = nextCp(i)

		// Lam + Alef is a required ligature and consumes both code points.
		if (cp === 0x0644 && after !== undefined && LAM_ALEF[after]) {
			const [iso, fin] = LAM_ALEF[after]!
			out.push(String.fromCodePoint(joinedBefore ? fin : iso))
			// Skip the alef, preserving any marks that sat between them.
			for (let j = i + 1; j < cps.length; j++) {
				if (cps[j] === after) {
					i = j
					break
				}
				out.push(String.fromCodePoint(cps[j]!))
			}
			continue
		}

		// The next letter can attach to its previous letter unless it is
		// non-joining (hamza) or not a letter at all.
		const joinedAfter = joiningOf(after) !== "none"
		const canTakeInitial = letter.count === 4

		let offset: number
		if (letter.count === 1) offset = 0
		else if (joinedBefore && joinedAfter && canTakeInitial) offset = 3 // medial
		else if (joinedBefore) offset = 1 // final
		else if (joinedAfter && canTakeInitial) offset = 2 // initial
		else offset = 0 // isolated

		out.push(String.fromCodePoint(letter.base + offset))
	}

	return out.join("")
}

/** True when the string contains any Arabic-script code point. */
export function hasArabic(text: string): boolean {
	for (const ch of text) {
		const cp = ch.codePointAt(0)!
		if (
			(cp >= 0x0600 && cp <= 0x06ff) ||
			(cp >= 0x0750 && cp <= 0x077f) ||
			(cp >= 0xfb50 && cp <= 0xfdff) ||
			(cp >= 0xfe70 && cp <= 0xfeff)
		)
			return true
	}
	return false
}
