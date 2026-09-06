// The transport's failure paths, which are the ones that actually get hit on a
// fresh machine. Every test here would have failed before the probe existed.

import { describe, expect, test } from "bun:test"
import { liveAbortTimers, Model } from "../src/agent/model"

function sse(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`
}

function streamOf(chunks: string[]): Response {
	const encoder = new TextEncoder()
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
			controller.close()
		},
	})
	return new Response(stream, { status: 200 })
}

type Call = { url: string; body: any }

function recorder(respond: () => Response): { calls: Call[]; fetchImpl: typeof fetch } {
	const calls: Call[] = []
	const fetchImpl = (async (input: any, init?: any) => {
		calls.push({
			url: String(input),
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		})
		return respond()
	}) as unknown as typeof fetch
	return { calls, fetchImpl }
}

function thrower(error: unknown): typeof fetch {
	return (async () => {
		throw error
	}) as unknown as typeof fetch
}

const STOP = [sse({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }), "data: [DONE]\n\n"]

describe("model transport", () => {
	test("a probe names what the endpoint is serving, and normalizes the base url", async () => {
		const { calls, fetchImpl } = recorder(
			() => new Response(JSON.stringify({ data: [{ id: "gpt-oss-20b" }, { id: "" }] }), { status: 200 }),
		)
		const model = new Model({ baseUrl: "http://172.24.208.1:8080/v1/", fetchImpl })

		const probe = await model.probe()

		expect(probe.ok).toBe(true)
		if (probe.ok) expect(probe.models).toEqual(["gpt-oss-20b"])
		expect(calls[0]?.url).toBe("http://172.24.208.1:8080/v1/models")
	})

	// A timer that outlives its request holds the event loop. The symptom is a
	// suite, or a one-shot run, that idles for the length of the timeout after
	// all the work is already done.
	test("a finished request leaves no timer armed behind it", async () => {
		const { fetchImpl } = recorder(() => new Response(JSON.stringify({ data: [] }), { status: 200 }))
		const model = new Model({ baseUrl: "http://127.0.0.1:8080/v1", probeTimeoutMs: 600000, fetchImpl })

		await model.probe()
		await new Model({ fetchImpl: recorder(() => streamOf(STOP)).fetchImpl, requestTimeoutMs: 600000 }).complete(
			[{ role: "user", content: "x" }],
			[],
		)

		expect(liveAbortTimers()).toBe(0)
	})

	test("a refused connection blames the port and names the address", async () => {
		const model = new Model({
			baseUrl: "http://172.24.208.1:8080/v1",
			fetchImpl: thrower(Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" })),
		})

		const probe = await model.probe()

		expect(probe.ok).toBe(false)
		if (!probe.ok) {
			expect(probe.reason).toContain("172.24.208.1:8080")
			expect(probe.hint).toContain("listening")
			expect(probe.hint).not.toContain("0.0.0.0")
		}
	})

	test("a silent drop blames the bind address instead of the port", async () => {
		const model = new Model({
			baseUrl: "http://172.24.208.1:8080/v1",
			probeTimeoutMs: 5,
			fetchImpl: thrower(Object.assign(new Error("the operation timed out"), { name: "TimeoutError" })),
		})

		const probe = await model.probe()

		expect(probe.ok).toBe(false)
		if (!probe.ok) expect(probe.hint).toContain("0.0.0.0")
	})

	test("a 404 blames the path, not the host", async () => {
		const { fetchImpl } = recorder(() => new Response("not found", { status: 404 }))
		const model = new Model({ baseUrl: "http://127.0.0.1:8080", fetchImpl })

		const probe = await model.probe()

		expect(probe.ok).toBe(false)
		if (!probe.ok) expect(probe.hint).toContain("/v1")
	})

	test("template kwargs are sent only when configured", async () => {
		const bare = recorder(() => streamOf(STOP))
		await new Model({ fetchImpl: bare.fetchImpl }).complete([{ role: "user", content: "x" }], [])
		expect(bare.calls[0]?.body.chat_template_kwargs).toBeUndefined()

		const tuned = recorder(() => streamOf(STOP))
		await new Model({
			fetchImpl: tuned.fetchImpl,
			chatTemplateKwargs: { reasoning_effort: "low" },
		}).complete([{ role: "user", content: "x" }], [])
		expect(tuned.calls[0]?.body.chat_template_kwargs).toEqual({ reasoning_effort: "low" })
	})

	test("tool call deltas assemble by index across chunk boundaries", async () => {
		const { fetchImpl } = recorder(() =>
			streamOf([
				sse({
					choices: [
						{
							delta: {
								tool_calls: [
									{ index: 0, id: "call_a", function: { name: "read_", arguments: '{"path":' } },
								],
							},
						},
					],
				}),
				sse({
					choices: [
						{ delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: '"README.md"}' } }] } },
					],
				}),
				sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
				"data: [DONE]\n\n",
			]),
		)

		const out = await new Model({ fetchImpl }).complete(
			[{ role: "user", content: "read it" }],
			[{ name: "read_file", description: "read a file", parameters: { type: "object" } }],
		)

		expect(out.stopReason).toBe("tool_calls")
		expect(out.toolCalls).toEqual([
			{ id: "call_a", name: "read_file", arguments: '{"path":"README.md"}' },
		])
	})

	test("a transport failure during a completion still names the endpoint", async () => {
		const model = new Model({
			baseUrl: "http://172.24.208.1:8080/v1",
			fetchImpl: thrower(Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" })),
		})

		await expect(model.complete([{ role: "user", content: "x" }], [])).rejects.toThrow("172.24.208.1:8080")
	})
})
