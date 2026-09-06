// Tool registry and scheduler.
//
// FACT (reference tool): read-only tools run in parallel; state-mutating tools
// run serially to avoid conflicts, and third-party tools are serial until they
// declare a read-only hint.
//
// Addition — capability firewall: a tool is eligible for parallel execution only
// if it declares readOnly itself AND its source is trusted. An undeclared MCP
// tool is quarantined: it runs serially and always needs a permission decision,
// even in acceptEdits mode.
//
// The scheduler decides concurrency. It reports risk faithfully and never
// decides approval; Permissions.check owns that, so the firewall cannot be
// weakened by a caller that flattens quarantine into "not read-only".

import type { ToolCall, ToolSchema } from "./model"
import type { Checkpoints } from "../safety/checkpoints"
import type { EffectLedger } from "../safety/ledger"
import type { Permissions } from "../safety/permissions"
import type { Session } from "../session/jsonl"

export type ToolContext = {
	cwd: string
	permissions: Permissions
	checkpoints: Checkpoints
	ledger: EffectLedger
	session: Session
}

export type Tool = {
	name: string
	description: string
	parameters: Record<string, unknown>
	/** Declared by the tool author. Undeclared means false. */
	readOnly: boolean
	/** Touches systems no checkpoint can restore (network, deploys, databases). */
	irreversible?: boolean
	/** Untrusted origin: never parallel, always a permission decision. */
	quarantined?: boolean
	/** Short human summary of a specific call, used in permission prompts. */
	summarize?: (args: any) => string
	run: (args: any, ctx: ToolContext) => Promise<string>
}

export type ToolOutcome = {
	call: ToolCall
	ok: boolean
	output: string
	durationMs: number
	/**
	 * How the scheduler started this call: true when it was launched together
	 * with at least one other call, false when it ran on its own.
	 *
	 * The limit of this flag, stated so no reader infers more: it is the width of
	 * the group handed to Promise.all, not a wall-clock measurement of two calls
	 * executing in the same instant. Promise.all creates no concurrency; the
	 * calls to runOne do, and interleaving only begins at the first await inside
	 * one of them. Eligibility alone is not enough — a read-only call that
	 * arrived alone ran alone — but a group of two whose work is entirely
	 * synchronous would still be reported as parallel here. Observed interleaving
	 * is proved by the scheduler tests, not by this field.
	 */
	parallel: boolean
}

export class Registry {
	private readonly tools = new Map<string, Tool>()

	register(...tools: Tool[]): this {
		for (const tool of tools) this.tools.set(tool.name, tool)
		return this
	}

	get(name: string): Tool | undefined {
		return this.tools.get(name)
	}

	list(): Tool[] {
		return [...this.tools.values()]
	}

	/** Schemas for the model. Names and descriptions only for lazy tools. */
	schemas(): ToolSchema[] {
		return this.list().map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}))
	}
}

/**
 * The one eligibility test for concurrency. Exported so that anything reporting
 * a call — the view, the session record, a test — asks the scheduler instead of
 * restating the rule. A second copy would not widen the firewall, because
 * executeBatch is the only caller that starts work, but it would let the
 * interface claim a call ran in parallel when it did not.
 *
 * This answers "may it be scheduled with others", which is not the same
 * question as "was it". ToolOutcome.parallel answers the second one.
 */
export function canRunParallel(tool: Tool | undefined): boolean {
	return Boolean(tool?.readOnly) && !tool?.quarantined
}

async function runOneUnguarded(
	call: ToolCall,
	registry: Registry,
	ctx: ToolContext,
	parallel: boolean,
): Promise<ToolOutcome> {
	const started = performance.now()
	const tool = registry.get(call.name)
	if (!tool) {
		return {
			call,
			ok: false,
			output: `unknown tool: ${call.name}`,
			durationMs: performance.now() - started,
			parallel,
		}
	}

	let args: any = {}
	try {
		args = call.arguments ? JSON.parse(call.arguments) : {}
	} catch (error) {
		return {
			call,
			ok: false,
			output: `invalid JSON arguments: ${(error as Error).message}`,
			durationMs: performance.now() - started,
			parallel,
		}
	}

	const summary = tool.summarize?.(args) ?? JSON.stringify(args).slice(0, 160)
	const decision = await ctx.permissions.check(
		tool.name,
		{
			readOnly: Boolean(tool.readOnly),
			irreversible: Boolean(tool.irreversible),
			quarantined: Boolean(tool.quarantined),
		},
		summary,
	)
	await ctx.session.append("permission", { tool: tool.name, summary, decision })

	if (!decision.allowed) {
		return {
			call,
			ok: false,
			output: `denied: ${decision.reason}`,
			durationMs: performance.now() - started,
			parallel,
		}
	}

	try {
		const output = await tool.run(args, ctx)
		if (tool.irreversible) {
			await ctx.ledger.record({
				tool: tool.name,
				target: summary,
				reversible: false,
				decision,
				resultSummary: output.slice(0, 200),
			})
		}
		return { call, ok: true, output, durationMs: performance.now() - started, parallel }
	} catch (error) {
		return {
			call,
			ok: false,
			output: `error: ${(error as Error).message}`,
			durationMs: performance.now() - started,
			parallel,
		}
	}
}

/**
 * The guard above covers tool.run only. The scheduler's own bookkeeping —
 * permissions.check, session.append, ledger.record — is awaited outside it and
 * can throw. One throw rejected the whole Promise.all: every sibling outcome was
 * discarded, and a sibling that had already started kept running with nothing
 * recorded about it. A missing row is worse than a failed row, so a throw
 * becomes an outcome here and a batch always returns one row per call.
 */
async function runOne(
	call: ToolCall,
	registry: Registry,
	ctx: ToolContext,
	parallel: boolean,
): Promise<ToolOutcome> {
	const started = performance.now()
	try {
		return await runOneUnguarded(call, registry, ctx, parallel)
	} catch (error) {
		return {
			call,
			ok: false,
			output: `scheduler error: ${(error as Error).message}`,
			durationMs: performance.now() - started,
			parallel,
		}
	}
}

/**
 * Execute a batch of tool calls, preserving order in the results.
 * Contiguous read-only calls are executed together; anything else is serial.
 *
 * Promise.all does not create the concurrency. The runOne calls made by map do,
 * and it preserves call order in the results rather than completion order.
 */
export async function executeBatch(
	calls: ToolCall[],
	registry: Registry,
	ctx: ToolContext,
): Promise<ToolOutcome[]> {
	const results: ToolOutcome[] = []
	let i = 0
	while (i < calls.length) {
		const call = calls[i]!
		if (canRunParallel(registry.get(call.name))) {
			const group: ToolCall[] = []
			while (i < calls.length && canRunParallel(registry.get(calls[i]!.name))) {
				group.push(calls[i]!)
				i++
			}
			// An eligible call that arrived alone still ran alone.
			const startedTogether = group.length > 1
			const batch = await Promise.all(
				group.map((c) => runOne(c, registry, ctx, startedTogether)),
			)
			results.push(...batch)
			continue
		}
		results.push(await runOne(call, registry, ctx, false))
		i++
	}
	return results
}
