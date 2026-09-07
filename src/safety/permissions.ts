// Permission modes.
//
// The order of the gates is the whole contract. The session allowlist and
// full-access mode are conveniences for repeated, recoverable work; they must
// never rank above the two gates that exist precisely because the action cannot
// be taken back. An "always allow" answered once for an rm -rf used to make
// every later rm -rf with the same summary silent, which is the opposite of
// what the human agreed to.

export type PermissionMode = "plan" | "manual" | "acceptEdits" | "full"

export const MODE_CYCLE: PermissionMode[] = ["manual", "acceptEdits", "plan", "full"]

export type Decision = {
	allowed: boolean
	mode: PermissionMode
	reason: string
	prompted: boolean
	at: string
}

export type ToolRisk = {
	readOnly: boolean
	irreversible: boolean
	quarantined?: boolean
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

	alwaysAllow(key: string): void {
		this.allowlist.add(key)
	}

	async check(tool: string, risk: ToolRisk, summary: string): Promise<Decision> {
		const at = new Date().toISOString()
		const base = { mode: this.mode, prompted: false, at }
		const quarantined = Boolean(risk.quarantined)

		if (risk.readOnly && !quarantined)
			return { ...base, allowed: true, reason: "read-only tool" }

		if (this.mode === "plan")
			return { ...base, allowed: false, reason: "plan mode forbids side effects" }

		if (risk.irreversible || quarantined) return await this.ask(tool, risk, summary, base)

		const key = `${tool}:${summary}`
		if (this.allowlist.has(key)) return { ...base, allowed: true, reason: "session allowlist" }

		if (this.mode === "full") return { ...base, allowed: true, reason: "full-access mode" }

		// acceptEdits names file edits, not every reversible tool.
		if (this.mode === "acceptEdits" && (tool === "write" || tool === "edit"))
			return { ...base, allowed: true, reason: "reversible file edit auto-approved" }

		return await this.ask(tool, risk, summary, base)
	}

	private async ask(
		tool: string,
		risk: ToolRisk,
		summary: string,
		base: { mode: PermissionMode; prompted: boolean; at: string },
	): Promise<Decision> {
		const label = risk.irreversible
			? `IRREVERSIBLE \u2014 ${tool}: ${summary}. No checkpoint can undo this. Allow?`
			: risk.quarantined
				? `QUARANTINED \u2014 ${tool}: ${summary}. Untrusted origin, its read-only hint is not trusted. Allow?`
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
