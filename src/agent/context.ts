// Context assembly and compaction.
//
// FACT (reference tool): when the window fills, the oldest tool outputs are
// dropped first, then the transcript is summarized; a guard stops the loop if a
// single item is so large that compaction cannot make progress.
//
// That guard is implemented here as a hard error with a specific message,
// because silently spinning is the worst possible failure mode for an agent
// that has write permissions.

import type { Message, Model } from "./model"

export class ContextOverflowError extends Error {
	constructor(public readonly offender: string) {
		super(
			`context cannot be compacted further: ${offender} alone exceeds the budget. ` +
				"Read fewer lines, narrow the search, or raise ORACLE_CONTEXT.",
		)
		this.name = "ContextOverflowError"
	}
}

/** Cheap and deliberately pessimistic. Not a tokenizer; never quoted as one. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 3.5)
}

export function messagesTokens(messages: Message[]): number {
	let total = 0
	for (const m of messages) total += estimateTokens(m.content) + 8
	return total
}

export type CompactionResult = {
	messages: Message[]
	droppedToolOutputs: number
	summarized: boolean
	tokensBefore: number
	tokensAfter: number
}

export async function compact(
	messages: Message[],
	model: Model,
	budget: number,
): Promise<CompactionResult> {
	const tokensBefore = messagesTokens(messages)
	if (tokensBefore <= budget) {
		return {
			messages,
			droppedToolOutputs: 0,
			summarized: false,
			tokensBefore,
			tokensAfter: tokensBefore,
		}
	}

	const working = [...messages]
	let dropped = 0

	// Stage 1: shrink the oldest tool results, newest kept intact.
	for (let i = 0; i < working.length && messagesTokens(working) > budget; i++) {
		const m = working[i]!
		if (m.role !== "tool") continue
		if (m.content.startsWith("[elided")) continue
		working[i] = {
			...m,
			content: `[elided ${m.content.length} bytes of ${m.name} output; re-run the tool if needed]`,
		}
		dropped++
	}

	let summarized = false
	if (messagesTokens(working) > budget) {
		// Stage 2: summarize everything except the last exchange.
		const tail = working.slice(-4)
		const head = working.slice(0, -4)
		if (head.length > 0) {
			const transcript = head
				.map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 2000)}`)
				.join("\n")
			const { text } = await model.complete(
				[
					{
						role: "system",
						content:
							"Summarize this agent transcript for continuation. Keep file paths, decisions, " +
							"open questions and any unverified claims tagged UNKNOWN. No praise, no filler.",
					},
					{ role: "user", content: transcript },
				],
				[],
			)
			working.length = 0
			working.push({ role: "system", content: `Earlier context (summarized):\n${text}` }, ...tail)
			summarized = true
		}
	}

	const tokensAfter = messagesTokens(working)
	if (tokensAfter > budget) {
		// Anti-spin guard: find the single item that makes progress impossible.
		const biggest = working.reduce((a, b) => (estimateTokens(a.content) > estimateTokens(b.content) ? a : b))
		if (estimateTokens(biggest.content) > budget * 0.6) {
			throw new ContextOverflowError(
				biggest.role === "tool" ? `${biggest.name} output` : `${biggest.role} message`,
			)
		}
	}

	return { messages: working, droppedToolOutputs: dropped, summarized, tokensBefore, tokensAfter }
}
