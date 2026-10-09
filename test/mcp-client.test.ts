// Falsifiers for the MCP client transport. Each behaviour tested here was
// broken in an earlier revision of this branch: Number()-coerced id keys only
// matched plain numeric echoes, every fire-and-forget request left an unhandled
// rejection that could kill the process, and stop() on a stub transport threw.

import { describe, expect, test } from "bun:test"
import { McpClient } from "../src/mcp/client"

/** A client with a fake transport attached — no subprocess is spawned;
 *  responses are delivered straight to consume(), which is the unit under test. */
function makeClient(): { client: McpClient; written: string[] } {
	const client = new McpClient("test", ["true"])
	const written: string[] = []
	client.setProcForTest({ stdin: { write: (s: string) => written.push(s) } })
	return { client, written }
}

function firstPendingId(client: McpClient): string {
	return client.pendingKeysForTest()[0]!
}

describe("JSON-RPC id handling", () => {
	test("a server that echoes a string id resolves the numeric request", async () => {
		const { client } = makeClient()
		const p = client.request("tools/list", {})
		client.consume(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { ok: 1 } }) + "\n")
		await expect(p).resolves.toEqual({ ok: 1 })
		expect(client.inFlight()).toBe(0)
	})

	test("numeric ids still match", async () => {
		const { client } = makeClient()
		const p = client.request("tools/list", {})
		client.consume(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }) + "\n")
		await expect(p).resolves.toEqual({ tools: [] })
		expect(client.inFlight()).toBe(0)
	})

	test("an unmatched id does not settle other requests", async () => {
		const { client } = makeClient()
		let settled = false
		void client
			.request("tools/list", {})
			.then(() => (settled = true))
			.catch(() => (settled = true)) // stop() below rejects it; that is not the signal
		client.consume(JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }) + "\n")
		await new Promise((r) => setTimeout(r, 10))
		expect(settled).toBe(false)
		expect(client.inFlight()).toBe(1) // timer stays armed for the real response
		client.stop()
	})

	test("a JSON-RPC error response rejects the pending call", async () => {
		const { client } = makeClient()
		const p = client.request("tools/call", {})
		client.consume(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "bad args" } }) + "\n")
		await expect(p).rejects.toThrow(/bad args/)
		expect(client.inFlight()).toBe(0)
	})

	test("ids are never reused after stop, so stale echoes cannot resolve fresh calls", async () => {
		const { client } = makeClient()
		const p1 = client.request("tools/list", {})
		client.stop()
		await expect(p1).rejects.toThrow(/client stopped/)
		const p2 = client.request("tools/list", {})
		// The echoed id of the second request must differ from the first ("1").
		const id = firstPendingId(client)
		expect(id).not.toBe("1")
		client.consume(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [1] } }) + "\n")
		await expect(p2).resolves.toEqual({ tools: [1] })
	})
})

describe("tool execution errors surface as failures", () => {
	test("isError:true rejects the call instead of returning ok text", async () => {
		const { client } = makeClient()
		const callPromise = client.call("boom", {})
		client.consume(
			JSON.stringify({
				jsonrpc: "2.0",
				id: firstPendingId(client),
				result: { isError: true, content: [{ type: "text", text: "disk full" }] },
			}) + "\n",
		)
		await expect(callPromise).rejects.toThrow(/boom failed: disk full/)
	})

	test("isError absent resolves normally", async () => {
		const { client } = makeClient()
		const callPromise = client.call("fine", {})
		client.consume(
			JSON.stringify({
				jsonrpc: "2.0",
				id: firstPendingId(client),
				result: { content: [{ type: "text", text: "hi" }] },
			}) + "\n",
		)
		await expect(callPromise).resolves.toBe("hi")
	})
})

describe("transport robustness", () => {
	test("CRLF-delimited messages parse (servers may write \\r\\n)", async () => {
		const { client } = makeClient()
		const p = client.request("tools/list", {})
		client.consume(`{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\r\n`)
		await expect(p).resolves.toEqual({ tools: [] })
	})

	test("oversized stdout lines fail the pending call rather than buffering forever", async () => {
		const { client } = makeClient()
		let rejected: Error | null = null
		const p = client.request("tools/list", {}).catch((e: Error) => (rejected = e))
		// One line larger than the 8 MiB cap, delivered in chunks with no newline.
		const huge = "x".repeat(9 * 1024 * 1024)
		for (let i = 0; i < huge.length; i += 1024 * 1024) client.consume(huge.slice(i, i + 1024 * 1024))
		await p
		expect(rejected).toBeInstanceOf(Error)
		expect(String(rejected?.message)).toContain("line limit exceeded")
		expect(client.inFlight()).toBe(0)
	})

	test("malformed JSON is ignored, valid frames around it still resolve", async () => {
		const { client } = makeClient()
		const p = client.request("tools/list", {})
		client.consume("{not json\n")
		client.consume(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }) + "\n")
		await expect(p).resolves.toEqual({ tools: [] })
	})

	test("split frames across chunks reassemble", async () => {
		const { client } = makeClient()
		const p = client.request("tools/list", {})
		const frame = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }) + "\n"
		client.consume(frame.slice(0, 12))
		client.consume(frame.slice(12))
		await expect(p).resolves.toEqual({ tools: [] })
	})

	test("requests are written as single newline-terminated JSON lines", () => {
		const { client, written } = makeClient()
		void client.request("tools/list", { a: 1 })
		expect(written.length).toBe(1)
		expect(written[0]!.endsWith("\n")).toBe(true)
		expect(JSON.parse(written[0]!).jsonrpc).toBe("2.0")
		client.stop()
	})

	test("stop() on a stub transport neither throws nor crashes the process", () => {
		const { client } = makeClient()
		void client.request("tools/list", {})
		expect(() => client.stop()).not.toThrow()
		expect(client.inFlight()).toBe(0)
	})
})

describe("no unhandled rejections", () => {
	test("fire-and-forget requests whose rejection nobody awaits do not emit unhandledRejection", async () => {
		const seen: unknown[] = []
		const listener = (reason: unknown) => seen.push(reason)
		process.on("unhandledRejection", listener)
		try {
			const { client } = makeClient()
			// Three abandoned requests: never awaited, then failed by stop().
			void client.request("tools/list", {})
			void client.request("tools/call", {})
			void client.request("ping", {})
			client.stop()
			// Let any unhandled-rejection event fire.
			await new Promise((r) => setTimeout(r, 50))
			expect(seen).toEqual([])
		} finally {
			process.off("unhandledRejection", listener)
		}
	})
})
