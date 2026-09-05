// Effect ledger.
//
// The reference tool draws the right line — files are undoable, remote effects
// are not — but it leaves the second half implicit. Here it is explicit: every
// non-undoable action is appended to a durable ledger together with the exact
// permission decision that allowed it. After the fact you can answer "what did
// this agent do that I cannot take back, and who said yes".

import { appendFile, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { Decision } from "./permissions"

export type Effect = {
	at: string
	sessionId: string
	tool: string
	/** Human-readable target: URL, host, command, table name. */
	target: string
	reversible: boolean
	decision: Decision
	resultSummary: string
}

export class EffectLedger {
	private readonly file: string
	private readonly memory: Effect[] = []

	constructor(
		private readonly sessionId: string,
		baseDir = ".oracle",
	) {
		this.file = resolve(baseDir, "effects.jsonl")
	}

	async record(
		input: Omit<Effect, "at" | "sessionId">,
	): Promise<Effect> {
		const effect: Effect = { ...input, at: new Date().toISOString(), sessionId: this.sessionId }
		this.memory.push(effect)
		await mkdir(dirname(this.file), { recursive: true })
		await appendFile(this.file, `${JSON.stringify(effect)}\n`)
		return effect
	}

	irreversible(): Effect[] {
		return this.memory.filter((e) => !e.reversible)
	}

	all(): readonly Effect[] {
		return this.memory
	}
}
