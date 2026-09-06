import { describe, expect, test } from "bun:test"
import { Registry, canRunParallel, executeBatch, type Tool, type ToolContext } from "../src/agent/tools"
import { Permissions } from "../src/safety/permissions"
import { estimateTokens, messagesTokens } from "../src/agent/context"
import { detectBackground, resolveTheme } from "../src/theme/theme"

function stubContext(permissions: Permissions): ToolContext {
	const appended: unknown[] = []
	return {
		cwd: process.cwd(),
		permissions,
		checkpoints: { snapshot: async () => ({ seq: 1 }), undo: async () => null, entries: () => [] } as any,
		ledger: { record: async (e: unknown) => e, irreversible: () => [], all: () => [] } as any,
		session: { append: async (kind: string, data: unknown) => appended.push([kind, data]) } as any,
	}
}

const tool = (name: string, opts: Partial<Tool>, order: string[]): Tool => ({
	name,
	description: name,
	parameters: { type: "object", properties: {} },
	readOnly: false,
	...opts,
	async run() {
		order.push(`start:${name}`)
		await new Promise((r) => setTimeout(r, 10))
		order.push(`end:${name}`)
		return name
	},
})

describe("tool scheduler", () => {
	test("read-only tools overlap", async () => {
		const order: string[] = []
		const registry = new Registry().register(
			tool("a", { readOnly: true }, order),
			tool("b", { readOnly: true }, order),
		)
		const outcomes = await executeBatch(
			[
				{ id: "1", name: "a", arguments: "{}" },
				{ id: "2", name: "b", arguments: "{}" },
			],
			registry,
			stubContext(new Permissions("manual")),
		)
		expect(outcomes.every((o) => o.ok)).toBe(true)
		expect(order.slice(0, 2)).toEqual(["start:a", "start:b"])
	})

	test("mutating tools are serialized", async () => {
		const order: string[] = []
		const registry = new Registry().register(
			tool("w1", {}, order),
			tool("w2", {}, order),
		)
		await executeBatch(
			[
				{ id: "1", name: "w1", arguments: "{}" },
				{ id: "2", name: "w2", arguments: "{}" },
			],
			registry,
			stubContext(new Permissions("full")),
		)
		expect(order).toEqual(["start:w1", "end:w1", "start:w2", "end:w2"])
	})

	test("quarantined tools never run in parallel and are always prompted", async () => {
		const order: string[] = []
		let prompts = 0
		const permissions = new Permissions("acceptEdits", async () => {
			prompts++
			return true
		})
		const registry = new Registry().register(
			tool("q1", { readOnly: true, quarantined: true }, order),
			tool("q2", { readOnly: true, quarantined: true }, order),
		)
		await executeBatch(
			[
				{ id: "1", name: "q1", arguments: "{}" },
				{ id: "2", name: "q2", arguments: "{}" },
			],
			registry,
			stubContext(permissions),
		)
		expect(order).toEqual(["start:q1", "end:q1", "start:q2", "end:q2"])
		expect(prompts).toBe(2)
	})

	test("plan mode blocks every side effect", async () => {
		const order: string[] = []
		const registry = new Registry().register(tool("write", {}, order))
		const outcomes = await executeBatch(
			[{ id: "1", name: "write", arguments: "{}" }],
			registry,
			stubContext(new Permissions("plan")),
		)
		expect(outcomes[0]!.ok).toBe(false)
		expect(order).toEqual([])
	})

	test("irreversible tools are prompted even in acceptEdits", async () => {
		let asked = ""
		const permissions = new Permissions("acceptEdits", async (q) => {
			asked = q
			return false
		})
		const decision = await permissions.check("bash", { readOnly: false, irreversible: true }, "$ rm -rf /tmp/x")
		expect(decision.allowed).toBe(false)
		expect(decision.prompted).toBe(true)
		expect(asked).toContain("IRREVERSIBLE")
	})

	// D9: eligibility is not evidence of overlap. The reported flag used to be a
	// constant true for every eligible group, so a lone read-only call claimed a
	// concurrency that never happened. Observed on the pre-fix code as
	// "expected false but got true".
	test("a lone eligible call is reported as serial, a pair as parallel", async () => {
		const order: string[] = []
		const registry = new Registry().register(
			tool("r1", { readOnly: true }, order),
			tool("r2", { readOnly: true }, order),
		)
		const ctx = () => stubContext(new Permissions("manual"))

		const alone = await executeBatch([{ id: "1", name: "r1", arguments: "{}" }], registry, ctx())
		expect(alone[0]!.ok).toBe(true)
		expect(canRunParallel(registry.get("r1"))).toBe(true)
		expect(alone[0]!.parallel).toBe(false)

		const pair = await executeBatch(
			[
				{ id: "1", name: "r1", arguments: "{}" },
				{ id: "2", name: "r2", arguments: "{}" },
			],
			registry,
			ctx(),
		)
		expect(pair.map((o) => o.parallel)).toEqual([true, true])
		// The flag says they were started together; this says they overlapped.
		expect(order.slice(-4)).toEqual(["start:r1", "start:r2", "end:r1", "end:r2"])
	})

	test("an ineligible call between two eligible ones splits the group", async () => {
		const order: string[] = []
		const registry = new Registry().register(
			tool("r1", { readOnly: true }, order),
			tool("w", {}, order),
			tool("r2", { readOnly: true }, order),
		)
		const outcomes = await executeBatch(
			[
				{ id: "1", name: "r1", arguments: "{}" },
				{ id: "2", name: "w", arguments: "{}" },
				{ id: "3", name: "r2", arguments: "{}" },
			],
			registry,
			stubContext(new Permissions("full")),
		)
		expect(outcomes.map((o) => o.call.name)).toEqual(["r1", "w", "r2"])
		// Two eligible calls, neither of which was ever started with another.
		expect(outcomes.map((o) => o.parallel)).toEqual([false, false, false])
		expect(order).toEqual([
			"start:r1",
			"end:r1",
			"start:w",
			"end:w",
			"start:r2",
			"end:r2",
		])
	})
})

// D10: runOne swallows a tool's own error, but permissions.check,
// session.append and ledger.record are awaited outside that guard. One throw
// rejected Promise.all, discarding every sibling outcome while a sibling that
// had already started kept running unrecorded. Observed on the pre-fix code as
// the raw "disk full" and "prompt closed" errors escaping executeBatch.
describe("D10 a broken journal loses no outcome", () => {
	function ctxThatThrowsOn(match: string, permissions: Permissions, order: string[]): ToolContext {
		return {
			cwd: process.cwd(),
			permissions,
			checkpoints: { snapshot: async () => ({ seq: 1 }), undo: async () => null, entries: () => [] } as any,
			ledger: { record: async (e: unknown) => e, irreversible: () => [], all: () => [] } as any,
			session: {
				append: async (kind: string, data: unknown) => {
					if (JSON.stringify(data).includes(match)) {
						order.push(`journal-throw:${match}`)
						throw new Error("disk full")
					}
				},
			} as any,
		}
	}

	test("a throw while recording one call still returns an outcome per call", async () => {
		const order: string[] = []
		const registry = new Registry().register(
			tool("r1", { readOnly: true }, order),
			tool("r2", { readOnly: true }, order),
		)
		const outcomes = await executeBatch(
			[
				{ id: "1", name: "r1", arguments: "{}" },
				{ id: "2", name: "r2", arguments: "{}" },
			],
			registry,
			ctxThatThrowsOn("r1", new Permissions("manual"), order),
		)

		expect(outcomes).toHaveLength(2)
		expect(outcomes.map((o) => o.call.name)).toEqual(["r1", "r2"])
		expect(outcomes[0]!.ok).toBe(false)
		expect(outcomes[0]!.output).toContain("disk full")
		// The sibling that ran anyway is accounted for, not silently dropped.
		expect(outcomes[1]!.ok).toBe(true)
		expect(order).toContain("end:r2")
	})

	test("a throw from the permission gate is a denial, not a lost batch", async () => {
		const order: string[] = []
		const registry = new Registry().register(tool("r1", { readOnly: true }, order))
		const permissions = {
			check: async () => {
				throw new Error("prompt closed")
			},
		} as any
		const outcomes = await executeBatch([{ id: "1", name: "r1", arguments: "{}" }], registry, {
			cwd: process.cwd(),
			permissions,
			checkpoints: { snapshot: async () => ({ seq: 1 }), undo: async () => null, entries: () => [] } as any,
			ledger: { record: async (e: unknown) => e, irreversible: () => [], all: () => [] } as any,
			session: { append: async () => {} } as any,
		})
		expect(outcomes).toHaveLength(1)
		expect(outcomes[0]!.ok).toBe(false)
		expect(outcomes[0]!.output).toContain("prompt closed")
		// The gate threw before approval, so the tool must never have run.
		expect(order).toEqual([])
	})
})

describe("context and theme", () => {
	test("token estimate is monotonic", () => {
		expect(estimateTokens("abc")).toBeGreaterThan(0)
		expect(messagesTokens([{ role: "user", content: "hello" }])).toBeGreaterThan(1)
	})

	test("COLORFGBG background code selects light or dark", () => {
		expect(detectBackground({ COLORFGBG: "0;15" } as any)).toBe("light")
		expect(detectBackground({ COLORFGBG: "15;0" } as any)).toBe("dark")
		expect(detectBackground({} as any)).toBe("dark")
	})

	test("bad theme keys are ignored but reported", () => {
		const resolved = resolveTheme({
			name: "Midnight",
			base: "dark",
			overrides: { accent: "#a78bfa", planMode: "not-a-color", nonsense: "#fff" },
		})
		expect(resolved.palette.accent).toBe("#a78bfa")
		expect(resolved.palette.planMode).toBe("#38bdf8")
		expect(resolved.ignored).toEqual([
			{ key: "planMode", reason: "invalid value" },
			{ key: "nonsense", reason: "unknown key" },
		])
	})
})
