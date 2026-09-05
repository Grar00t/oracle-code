import { describe, expect, test } from "bun:test"
import { Registry, executeBatch, type Tool, type ToolContext } from "../src/agent/tools"
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
