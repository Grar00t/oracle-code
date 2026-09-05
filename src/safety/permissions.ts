// Permission modes.
//
// FACT (reference tool): read-only by default; every mutation or command needs a
// human decision in manual mode. Modes cycle with Shift+Tab.
//
// Addition here: a decision is a value that gets recorded. Nothing mutates the
// world without a Decision object that the effect ledger can point at later.

export type PermissionMode =
	| "plan" // no side effects at all, not even file writes
	| "manual" // ask for every mutation and every command
	| "acceptEdits" // file edits auto-approved, commands still asked
	| "full" // everything auto-approved; still fully logged

export const MODE_CYCLE: PermissionMode[] = ["manual", "acceptEdits", "plan", "full"]

export type Decision = {
	allowed: boolean
	mode: PermissionMode
	reason: string
	/** True when a human answered a prompt for this specific call. */
	prompted: boolean
	at: string
}

export type ToolRisk = {
	readOnly: boolean
	/** Effects outside the working tree that no snapshot can undo. */
	irreversible: boolean
}

export type Prompter = (question: string) => Promise<boolean>

export class Permissions {
	mode: PermissionMode
	private readonly prompt: Prompter
	private readonly allowlist = new Set<string>()

	constructor(mode: PermissionMode = "manual", prompt?: Prompter) {
		this.mode = mode
		this.prompt = prompt ?? (async () => false)
	}

	cycle(): PermissionMode {
		const i = MODE_CYCLE.indexOf(this.mode)
		this.mode = MODE_CYCLE[(i + 1) % MODE_CYCLE.length]!
		return this.mode
	}

	/** Remember "always allow" answers for the rest of the session. */
	alwaysAllow(key: string): void {
		this.allowlist.add(key)
	}

	async check(tool: string, risk: ToolRisk, summary: string): Promise<Decision> {
		const at = new Date().toISOString()
		const base = { mode: this.mode, prompted: false, at }

		if (risk.readOnly) return { ...base, allowed: true, reason: "read-only tool" }

		if (this.mode === "plan")
			return { ...base, allowed: false, reason: "plan mode forbids side effects" }

		const key = `${tool}:${summary}`
		if (this.allowlist.has(key)) return { ...base, allowed: true, reason: "session allowlist" }

		if (this.mode === "full") return { ...base, allowed: true, reason: "full-access mode" }

		if (this.mode === "acceptEdits" && !risk.irreversible)
			return { ...base, allowed: true, reason: "reversible file edit auto-approved" }

		// Irreversible effects are always prompted, in every mode except full.
		const label = risk.irreversible
			? `IRREVERSIBLE \u2014 ${tool}: ${summary}. No checkpoint can undo this. Allow?`
			: `${tool}: ${summary}. Allow?`
		const allowed = await this.prompt(label)
		return {
			...base,
			allowed,
			prompted: true,
			reason: allowed ? "approved by human" : "denied by human",
		}
	}
}
