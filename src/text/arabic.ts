// Contextual Arabic shaping.
//
// FACT (Unicode 15, Arabic Presentation Forms-B, U+FE70..U+FEFC and
// Presentation Forms-A, U+FB50..U+FBFF): every joining Arabic letter has either
// 2 forms (isolated, final) or 4 forms (isolated, final, initial, medial), laid
// out contiguously in that order. Lam + Alef forms a mandatory ligature at
// U+FEF5..U+FEFC.
//
// FACT (ArabicShaping.txt): ZWNJ (U+200C) has joining type NON_JOINING and ZWJ
// (U+200D) has joining type JOIN_CAUSING. Neither is TRANSPARENT. Treating
// them as transparent makes ZWNJ do nothing at all, which silently breaks
// Persian and Urdu orthography.
//
// A fixed-width cell grid does no joining by itself. Terminals render whatever
// code point they are handed, so shaping must happen before the grid, not after.

type Joining = "dual" | "right" | "none"

type LetterForms = {
	/** First code point of the letter's run in the Presentation Forms tables. */
	base: number
	/** 1, 2 or 4 available forms. */
	count: 1 | 2 | 4
	joining: Joining
}

const ZWNJ = 0x200c
const ZWJ = 0x200d
const TATWEEL = 0x0640

// prettier-ignore
const LETTERS: Record<number, LetterForms> = {
	// --- Arabic (U+0600 block), Presentation Forms-B ---
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

	// --- Persian, Urdu, Sindhi, Uyghur, Kurdish; Presentation Forms-A ---
	// Without these, joiningOf() returns "none" and the letters on BOTH sides
	// lose their medial and initial forms, so the whole word comes apart.
	0x0671: { base: 0xfb50, count: 2, joining: "right" }, // alef wasla
	0x0679: { base: 0xfb66, count: 4, joining: "dual" },  // tteh
	0x067a: { base: 0xfb5e, count: 4, joining: "dual" },  // tteheh
	0x067b: { base: 0xfb52, count: 4, joining: "dual" },  // beeh
	0x067e: { base: 0xfb56, count: 4, joining: "dual" },  // peh
	0x067f: { base: 0xfb62, count: 4, joining: "dual" },  // teheh
	0x0680: { base: 0xfb5a, count: 4, joining: "dual" },  // beheh
	0x0683: { base: 0xfb76, count: 4, joining: "dual" },  // nyeh
	0x0684: { base: 0xfb72, count: 4, joining: "dual" },  // dyeh
	0x0686: { base: 0xfb7a, count: 4, joining: "dual" },  // tcheh
	0x0687: { base: 0xfb7e, count: 4, joining: "dual" },  // tcheheh
	0x0688: { base: 0xfb88, count: 2, joining: "right" }, // ddal
	0x068c: { base: 0xfb84, count: 2, joining: "right" }, // dahal
	0x068d: { base: 0xfb82, count: 2, joining: "right" }, // ddahal
	0x068e: { base: 0xfb86, count: 2, joining: "right" }, // dul
	0x0691: { base: 0xfb8c, count: 2, joining: "right" }, // rreh
	0x0698: { base: 0xfb8a, count: 2, joining: "right" }, // jeh
	0x06a4: { base: 0xfb6a, count: 4, joining: "dual" },  // veh
	0x06a6: { base: 0xfb6e, count: 4, joining: "dual" },  // peheh
	0x06a9: { base: 0xfb8e, count: 4, joining: "dual" },  // keheh
	0x06ad: { base: 0xfbd3, count: 4, joining: "dual" },  // ng
	0x06af: { base: 0xfb92, count: 4, joining: "dual" },  // gaf
	0x06b1: { base: 0xfb9a, count: 4, joining: "dual" },  // ngoeh
	0x06b3: { base: 0xfb96, count: 4, joining: "dual" },  // gueh
	0x06ba: { base: 0xfb9e, count: 2, joining: "right" }, // noon ghunna
	0x06bb: { base: 0xfba0, count: 4, joining: "dual" },  // rnoon
	0x06be: { base: 0xfbaa, count: 4, joining: "dual" },  // heh doachashmee
	0x06c0: { base: 0xfba4, count: 2, joining: "right" }, // heh with yeh above
	0x06c1: { base: 0xfba6, count: 4, joining: "dual" },  // heh goal
	0x06c5: { base: 0xfbe0, count: 2, joining: "right" }, // kirghiz oe
	0x06c6: { base: 0xfbd9, count: 2, joining: "right" }, // oe
	0x06c7: { base: 0xfbd7, count: 2, joining: "right" }, // u
	0x06c8: { base: 0xfbdb, count: 2, joining: "right" }, // yu
	0x06c9: { base: 0xfbe2, count: 2, joining: "right" }, // kirghiz yu
	0x06cb: { base: 0xfbde, count: 2, joining: "right" }, // ve
	0x06cc: { base: 0xfbfc, count: 4, joining: "dual" },  // farsi yeh
	0x06d0: { base: 0xfbe4, count: 4, joining: "dual" },  // e
	0x06d2: { base: 0xfbae, count: 2, joining: "right" }, // yeh barree
	0x06d3: { base: 0xfbb0, count: 2, joining: "right" }, // yeh barree with hamza
}

/** Lam + Alef mandatory ligatures: [isolated, final]. */
const LAM_ALEF: Record<number, readonly [number, number]> = {
	0x0622: [0xfef5, 0xfef6],
	0x0623: [0xfef7, 0xfef8],
	0x0625: [0xfef9, 0xfefa],
	0x0627: [0xfefb, 0xfefc],
}

/**
 * Transparent joining class: marks do not break a joining chain.
 *
 * ZWNJ and ZWJ are deliberately NOT here. ZWNJ must break a join and ZWJ must
 * force one; if either is skipped as transparent it has no effect at all.
 */
function isTransparent(cp: number): boolean {
	return (
		(cp >= 0x064b && cp <= 0x065f) ||
		(cp >= 0x0610 && cp <= 0x061a) ||
		cp === 0x0670 ||
		(cp >= 0x06d6 && cp <= 0x06ed)
	)
}

function joiningOf(cp: number | undefined): Joining {
	if (cp === undefined) return "none"
	if (cp === TATWEEL || cp === ZWJ) return "dual" // JOIN_CAUSING
	if (cp === ZWNJ) return "none" // NON_JOINING
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

		// A previous dual-joining letter, tatweel or ZWJ means this letter is
		// joined on its right side, so it takes a final or medial form.
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
		// non-joining (hamza, ZWNJ) or not a letter at all.
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
