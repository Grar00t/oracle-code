// Key event parser. Pure: bytes in, key events out, no terminal access, so
// every escape sequence this file claims to understand is provable in a test.
//
// FACT: a terminal in raw mode delivers keystrokes as bytes. Printable text
// arrives as UTF-8; control keys arrive as C0 bytes (^A = 0x01); special keys
// arrive as ESC [ sequences (CSI). Shift+Enter is not distinguishable from
// Enter in most terminals — it sends the same 0x0d — which is why the
// multiline composer is toggled by `"""` instead.

export type Key =
	| { kind: "char"; char: string }
	| { kind: "enter" }
	| { kind: "backspace" }
	| { kind: "delete" }
	| { kind: "tab" }
	| { kind: "escape" }
	| { kind: "up" }
	| { kind: "down" }
	| { kind: "left" }
	| { kind: "right" }
	| { kind: "home" }
	| { kind: "end" }
	| { kind: "pageUp" }
	| { kind: "pageDown" }
	| { kind: "ctrl"; char: string }

const CSI_FINAL: Record<string, Key> = {
	A: { kind: "up" },
	B: { kind: "down" },
	C: { kind: "right" },
	D: { kind: "left" },
	H: { kind: "home" },
	F: { kind: "end" },
}

const CSI_TILDE: Record<string, Key> = {
	"1": { kind: "home" },
	"3": { kind: "delete" },
	"4": { kind: "end" },
	"5": { kind: "pageUp" },
	"6": { kind: "pageDown" },
	"7": { kind: "home" },
	"8": { kind: "end" },
}

/**
 * Parse one chunk of raw input into key events.
 *
 * A chunk boundary can split an escape sequence; the unconsumed tail is
 * returned so the caller can prepend it to the next chunk. A lone ESC with no
 * follow-up in the same chunk is held back for the same reason — the caller
 * flushes it as an escape key if nothing arrives.
 */
export function parseKeys(input: string): { keys: Key[]; rest: string } {
	const keys: Key[] = []
	let i = 0
	while (i < input.length) {
		const c = input[i]!
		const code = input.charCodeAt(i)

		if (c === "\u001b") {
			// Possible CSI or SS3 sequence.
			if (i + 1 >= input.length) return { keys, rest: input.slice(i) }
			const next = input[i + 1]!
			if (next === "[") {
				// CSI: ESC [ params final. Final byte is 0x40-0x7e.
				let j = i + 2
				while (j < input.length && !(input.charCodeAt(j) >= 0x40 && input.charCodeAt(j) <= 0x7e)) j++
				if (j >= input.length) return { keys, rest: input.slice(i) }
				const final = input[j]!
				const params = input.slice(i + 2, j)
				if (final === "~") {
					const key = CSI_TILDE[params.split(";")[0] ?? ""]
					if (key) keys.push(key)
				} else {
					const key = CSI_FINAL[final]
					if (key) keys.push(key)
				}
				i = j + 1
				continue
			}
			if (next === "O") {
				// SS3: ESC O final (application cursor mode).
				if (i + 2 >= input.length) return { keys, rest: input.slice(i) }
				const key = CSI_FINAL[input[i + 2]!]
				if (key) keys.push(key)
				i += 3
				continue
			}
			keys.push({ kind: "escape" })
			i++
			continue
		}

		if (c === "\r" || c === "\n") {
			keys.push({ kind: "enter" })
			// CRLF is one Enter, not two.
			if (c === "\r" && input[i + 1] === "\n") i++
			i++
			continue
		}
		if (code === 0x7f || code === 0x08) {
			keys.push({ kind: "backspace" })
			i++
			continue
		}
		if (c === "\t") {
			keys.push({ kind: "tab" })
			i++
			continue
		}
		if (code < 0x20) {
			// C0 control: ^A = 0x01 ... ^Z = 0x1a.
			keys.push({ kind: "ctrl", char: String.fromCharCode(code + 96) })
			i++
			continue
		}
		keys.push({ kind: "char", char: c })
		i++
	}
	return { keys, rest: "" }
}
