// The loop: gather context -> execute -> verify. It ends when the model returns
// a turn with no tool calls.

import { compact, messagesTokens } from "./context"
import { detectFiller, restatesQuestion, type FillerHit } from "./filler"
import { Model, type Message } from "./model"
import { canRunParallel, executeBatch, type Registry, type ToolContext } from "./tools"

export type LoopEvent =
	| { type: "token"; text: string }
	// `parallel` here is the scheduler's eligibility test, asked before the work
	// starts. It is a prediction, and tool.end carries what actually happened.
	| { type: "tool.start"; name: string; summary: string; parallel: boolean }
	// `parallel` reports whether this call actually overlapped another. It used
	// to be missing here, so the view had nothing to read and hard-coded false.
	// `preview` carries the first lines of output so the interface can show what
	// a call produced, not just that it ran.
	| { type: "tool.end"; name: string; ok: boolean; durationMs: number; parallel: boolean; preview: string }
	| { type: "compaction"; droppedToolOutputs: number; summarized: boolean }
	// The filler detector's verdict on the reply that just ended. Recorded in
	// the session JSONL either way; emitted only when something was found.
	| { type: "filler"; hits: FillerHit[] }
	| { type: "turn.end"; text: string }

export type LoopOptions = {
	systemPrompt?: string
	maxIterations?: number
	onEvent?: (event: LoopEvent) => void
}

export const DEFAULT_SYSTEM_PROMPT = [
	"You are a terminal coding agent operating on a real filesystem.",
	"Rules:",
	"- Read before you write. Never guess a file's contents.",
	"- Prefer the smallest change that satisfies the request.",
	"- Tag claims: FACT when verified from a file or command output, DERIVED when inferred, UNKNOWN when unverified. Never present UNKNOWN as FACT.",
	"- Never state a performance number you did not measure in this session.",
	"- Stop and report when a step needs a decision you cannot verify.",
	"No filler:",
	"- Start every reply with the content. No preamble, no greeting, no 'Certainly'.",
	"- Never restate the question or announce what you are about to do; do it.",
	"- Never repeat tool output the user already saw; reference it.",
	"- No closing pleasantries: no 'hope this helps', no 'let me know'.",
	"- One-line answers for one-line questions. Length must follow content, not habit.",
].join("\n")

export class Agent {
	private messages: Message[] = []

	constructor(
		private readonly model: Model,
		private readonly registry: Registry,
		private readonly ctx: ToolContext,
		private readonly options: LoopOptions = {},
	) {
		this.messages.push({
			role: "system",
			content: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
		})
	}

	transcript(): readonly Message[] {
		return this.messages
	}

	async run(userInput: string): Promise<string> {
		const emit = this.options.onEvent ?? (() => {})
		this.messages.push({ role: "user", content: userInput })
		await this.ctx.session.append("user", { text: userInput })

		const maxIterations = this.options.maxIterations ?? 24
		let finalText = ""

		for (let iteration = 0; iteration < maxIterations; iteration++) {
			// Gather: keep the window inside budget before every model call.
			const budget = Math.floor(this.model.contextTokens * 0.8)
			if (messagesTokens(this.messages) > budget) {
				const result = await compact(this.messages, this.model, budget)
				this.messages = result.messages
				await this.ctx.session.append("compaction", result)
				emit({
					type: "compaction",
					droppedToolOutputs: result.droppedToolOutputs,
					summarized: result.summarized,
				})
			}

			const completion = await this.model.complete(
				this.messages,
				this.registry.schemas(),
				(delta) => emit({ type: "token", text: delta }),
			)

			this.messages.push({
				role: "assistant",
				content: completion.text,
				...(completion.toolCalls.length ? { toolCalls: completion.toolCalls } : {}),
			})
			await this.ctx.session.append("assistant", {
				text: completion.text,
				toolCalls: completion.toolCalls,
			})

			// Verify: no tool calls means the turn is finished.
			if (completion.toolCalls.length === 0) {
				finalText = completion.text
				// Measure the reply against the no-filler contract and record the
				// verdict. A hit is a data point in the transcript, not a retry.
				const hits = detectFiller(finalText)
				if (restatesQuestion(userInput, finalText)) {
					hits.push({ pattern: "restates-question", excerpt: finalText.trimStart().slice(0, 60) })
				}
				await this.ctx.session.append("filler", { hits })
				if (hits.length) emit({ type: "filler", hits })
				emit({ type: "turn.end", text: finalText })
				return finalText
			}

			// Execute: read-only calls in parallel, mutations serially.
			for (const call of completion.toolCalls) {
				emit({
					type: "tool.start",
					name: call.name,
					summary: call.arguments.slice(0, 120),
					// Ask the scheduler. Restating the rule here let the view drift.
					parallel: canRunParallel(this.registry.get(call.name)),
				})
				await this.ctx.session.append("tool.call", call)
			}

			const outcomes = await executeBatch(completion.toolCalls, this.registry, this.ctx)
			for (const outcome of outcomes) {
				await this.ctx.session.append("tool.result", outcome)
				emit({
					type: "tool.end",
					name: outcome.call.name,
					ok: outcome.ok,
					durationMs: outcome.durationMs,
					// Taken from the scheduler's own record of how it ran the call.
					parallel: outcome.parallel,
					preview: outcome.output.split("\n").slice(0, 2).join("\n").slice(0, 200),
				})
				this.messages.push({
					role: "tool",
					name: outcome.call.name,
					toolCallId: outcome.call.id,
					content: outcome.output,
				})
			}
		}

		finalText = `stopped after ${maxIterations} iterations without a final answer`
		await this.ctx.session.append("error", { text: finalText })
		return finalText
	}
}
