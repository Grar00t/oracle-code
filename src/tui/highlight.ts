// Code block detection and a small tokenizer. No dependency, no grammar files:
// three token classes (keyword, string, comment) cover what a human scans for
// in a diff-sized snippet, and anything the tokenizer is unsure about is left
// as plain text rather than guessed.

export type Segment = { text: string; token: "plain" | "keyword" | "string" | "comment" }

export type Block =
	| { kind: "text"; lines: string[] }
	| { kind: "code"; lang: string; lines: string[] }

/** Split a message into prose and fenced code blocks. An unclosed fence runs to the end. */
export function splitBlocks(message: string): Block[] {
	const out: Block[] = []
	let current: Block = { kind: "text", lines: [] }
	for (const line of message.split("\n")) {
		const fence = /^\s*```(\S*)\s*$/.exec(line)
		if (fence) {
			if (current.kind === "code") {
				out.push(current)
				current = { kind: "text", lines: [] }
			} else {
				if (current.lines.length) out.push(current)
				current = { kind: "code", lang: fence[1] ?? "", lines: [] }
			}
			continue
		}
		current.lines.push(line)
	}
	if (current.lines.length || current.kind === "code") out.push(current)
	return out
}

// One shared keyword set. Perfect per-language keyword lists buy little at
// terminal reading distance; wrong colours on a rare keyword cost nothing.
const KEYWORDS = new Set([
	"abstract", "as", "async", "await", "break", "case", "catch", "class", "const",
	"continue", "def", "default", "defer", "del", "do", "elif", "else", "enum",
	"except", "export", "extends", "false", "final", "finally", "fn", "for", "from",
	"func", "function", "go", "if", "impl", "implements", "import", "in", "interface",
	"lambda", "let", "loop", "match", "mod", "mut", "new", "nil", "none", "not",
	"null", "of", "or", "and", "package", "pass", "private", "public", "pub", "raise",
	"return", "self", "static", "struct", "switch", "then", "this", "throw", "trait",
	"true", "try", "type", "typeof", "undefined", "use", "var", "void", "when",
	"while", "with", "yield",
])

const LINE_COMMENT = /^(\/\/|#|--|;;)/

/**
 * Tokenize one code line into contiguous segments. Line-local only: block
 * comments and multi-line strings are not tracked, so a line inside one is
 * rendered plain — an honest miss, never a wrong colour.
 */
export function tokenizeLine(line: string): Segment[] {
	const segments: Segment[] = []
	let plain = ""
	const flush = () => {
		if (plain) {
			segments.push({ text: plain, token: "plain" })
			plain = ""
		}
	}
	let i = 0
	while (i < line.length) {
		const c = line[i]!
		const rest = line.slice(i)

		const comment = LINE_COMMENT.exec(rest)
		if (comment && (i === 0 || /[\s;{}()]/.test(line[i - 1]!))) {
			// `//` inside a url (`http://`) must not start a comment.
			if (!(comment[1] === "//" && i >= 1 && line[i - 1] === ":")) {
				flush()
				segments.push({ text: rest, token: "comment" })
				return segments
			}
		}

		if (c === '"' || c === "'" || c === "`") {
			let j = i + 1
			while (j < line.length && line[j] !== c) {
				if (line[j] === "\\") j++
				j++
			}
			const end = j < line.length ? j + 1 : line.length
			flush()
			segments.push({ text: line.slice(i, end), token: "string" })
			i = end
			continue
		}

		if (/[A-Za-z_]/.test(c)) {
			let j = i
			while (j < line.length && /[A-Za-z0-9_]/.test(line[j]!)) j++
			const word = line.slice(i, j)
			if (KEYWORDS.has(word)) {
				flush()
				segments.push({ text: word, token: "keyword" })
			} else {
				plain += word
			}
			i = j
			continue
		}

		plain += c
		i++
	}
	flush()
	return segments
}
