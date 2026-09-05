// The loop: gather context -> execute -> verify. It ends when the model returns
// a turn with no tool calls.

import { compact, messagesTokens } from "./context"
import { Model, type Message } from "./model"
import { executeBatch, type Registry, type ToolContext } from "./tools"

export type LoopEvent =
	| { type: "token"; text: string }
	| { type: "tool.start"; name: string; summary: string; parallel: boolean }
	| { type: "tool.end"; name: string; ok: boolean; durationMs: number }
	| { type: "compaction"; droppedToolOutputs: number; summarized: boolean }
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
				emit({ type: "turn.end", text: finalText })
				return finalText
			}

			// Execute: read-only calls in parallel, mutations serially.
			for (const call of completion.toolCalls) {
				const tool = this.registry.get(call.name)
				emit({
					type: "tool.start",
					name: call.name,
					summary: call.arguments.slice(0, 120),
					parallel: Boolean(tool?.readOnly && !tool?.quarantined),
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
