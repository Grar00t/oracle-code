// Post-turn filler detection. The system prompt asks for no filler; this
// module measures whether the model complied. Detection is recorded in the
// session JSONL and counted on the status line — measurement, not decoration.
//
// The list is short and high-precision on purpose: a false accusation teaches
// the user to ignore the counter. Anything ambiguous is not filler here.

export type FillerHit = { pattern: string; excerpt: string }

// Anchored at the start of the reply (after whitespace), where filler lives.
// A "Great!" quoted mid-answer is not an offence.
const OPENERS: Array<{ name: string; re: RegExp }> = [
	{ name: "exclamation-opener", re: /^(great|awesome|perfect|excellent|wonderful|sure)[!.,]/i },
	{ name: "certainly", re: /^(certainly|absolutely|of course)[!.,:]?\s/i },
	{ name: "happy-to-help", re: /^(i('|\u2019)?d be (happy|glad) to|happy to help)/i },
	{ name: "great-question", re: /^(that('|\u2019)?s a )?(great|good|excellent) question/i },
	{ name: "announce-intent", re: /^(i('|\u2019)?ll now|i will now|let me (now )?(start|begin|go ahead))/i },
	{ name: "as-an-ai", re: /^as an ai\b/i },
]

// Anywhere in the reply: phrases that only ever pad.
const ANYWHERE: Array<{ name: string; re: RegExp }> = [
	{ name: "hope-this-helps", re: /\b(i )?hope (this|that) helps\b/i },
	{ name: "feel-free", re: /\bfeel free to (ask|reach out)\b/i },
	{ name: "let-me-know-questions", re: /\blet me know if you have any (other )?questions\b/i },
]

/** Scan one assistant reply. Empty array means no filler was detected. */
export function detectFiller(reply: string): FillerHit[] {
	const hits: FillerHit[] = []
	const head = reply.trimStart()
	for (const { name, re } of OPENERS) {
		const m = re.exec(head)
		if (m) hits.push({ pattern: name, excerpt: m[0].slice(0, 60) })
	}
	for (const { name, re } of ANYWHERE) {
		const m = re.exec(reply)
		if (m) hits.push({ pattern: name, excerpt: m[0].slice(0, 60) })
	}
	return hits
}

/**
 * Does the reply open by restating the question? Compared on significant
 * words: at least six words long and at least 80% of the first sentence's
 * words come from the question. Short echoes are legitimate confirmation.
 */
export function restatesQuestion(question: string, reply: string): boolean {
	const firstSentence = reply.trimStart().split(/[.\n?!]/, 1)[0] ?? ""
	const replyWords = firstSentence.toLowerCase().match(/[a-z\u0600-\u06ff0-9]+/g) ?? []
	if (replyWords.length < 6) return false
	const questionWords = new Set(question.toLowerCase().match(/[a-z\u0600-\u06ff0-9]+/g) ?? [])
	if (questionWords.size === 0) return false
	const overlap = replyWords.filter((w) => questionWords.has(w)).length
	return overlap / replyWords.length >= 0.8
}
