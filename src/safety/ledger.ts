// Effect ledger.
//
// The file is append-only JSONL at <baseDir>/effects.jsonl. irreversible()
// returns this process's view after hydrate(), filtered to this session id.
// A truncated last line is skipped, not treated as a complete effect.

import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { Decision } from "./permissions"

export type Effect = {
	at: string
	sessionId: string
	tool: string
	target: string
	reversible: boolean
	decision: Decision
	resultSummary: string
}

function parseEffects(text: string): Effect[] {
	const out: Effect[] = []
	for (const line of text.split(/\r?\n/)) {
		if (!line) continue
		try {
			const row = JSON.parse(line) as Effect
			if (!row || typeof row.tool !== "string" || typeof row.sessionId !== "string") continue
			out.push(row)
		} catch {
			// Partial write: drop the broken line.
		}
	}
	return out
}

export class EffectLedger {
	private readonly file: string
	private readonly memory: Effect[] = []
	private hydrated = false

	constructor(
		private readonly sessionId: string,
		baseDir = ".oracle",
	) {
		this.file = resolve(baseDir, "effects.jsonl")
	}

	path(): string {
		return this.file
	}

	async hydrate(): Promise<void> {
		if (this.hydrated) return
		this.hydrated = true
		let text = ""
		try {
			text = await readFile(this.file, "utf8")
		} catch {
			return
		}
		if (this.memory.length) return
		for (const row of parseEffects(text)) {
			if (row.sessionId === this.sessionId) this.memory.push(row)
		}
	}

	async record(
		input: Omit<Effect, "at" | "sessionId">,
	): Promise<Effect> {
		await this.hydrate()
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

	static async readAll(baseDir = ".oracle"): Promise<Effect[]> {
		try {
			return parseEffects(await readFile(resolve(baseDir, "effects.jsonl"), "utf8"))
		} catch {
			return []
		}
	}
}
