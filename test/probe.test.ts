// The defects one doctor run exposed on Windows with node 24.
//
// D1 a refused connection arrived as "fetch failed" and fell through to the
//    generic advice, because the only place ECONNREFUSED appears is in
//    error.cause, which the classifier never read.
// D2 the classifier must not be fooled by a self-referential cause chain.
// D3 whatever the verdict, no abort timer may stay armed afterwards.

import { describe, expect, test } from "bun:test"
import { Model, describeFailure, errorSignature, liveAbortTimers } from "../src/agent/model"

const URL_BASE = "http://127.0.0.1:8080/v1"

/** How node 24 actually reports a dead local port through fetch. */
function nodeRefused(): Error {
	const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), {
		code: "ECONNREFUSED",
		errno: -4078,
	})
	return Object.assign(new TypeError("fetch failed"), { cause })
}

describe("P1 a network failure names its own cause", () => {
	test("a refused port is called refused, not just failed", () => {
		const { reason, hint } = describeFailure(nodeRefused(), URL_BASE)
		expect(reason).toContain("refused the connection")
		expect(hint).toContain("port")
		expect(reason).not.toContain("fetch failed")
		// Refused and dropped must not give the same advice.
		const dropped = describeFailure(
			Object.assign(new Error("the request timed out"), { name: "TimeoutError" }),
			URL_BASE,
		)
		expect(dropped.hint).not.toBe(hint)
	})

	test("a wrapped dns failure is told apart from a refusal", () => {
		const cause = Object.assign(new Error("getaddrinfo ENOTFOUND khz.local"), { code: "ENOTFOUND" })
		const wrapped = Object.assign(new TypeError("fetch failed"), { cause })
		expect(describeFailure(wrapped, URL_BASE).reason).toContain("did not resolve")
	})

	test("a timeout keeps its own branch", () => {
		const error = Object.assign(new Error("the request timed out"), { name: "TimeoutError" })
		expect(describeFailure(error, URL_BASE).reason).toContain("timed out")
	})

	test("an unrecognised failure still quotes what it said", () => {
		expect(describeFailure(new Error("disk on fire"), URL_BASE).reason).toContain("disk on fire")
	})
})

describe("P2 the cause chain cannot hang the classifier", () => {
	test("a cause that points at itself terminates", () => {
		const loop: { message: string; cause?: unknown } = { message: "outer" }
		loop.cause = loop
		expect(errorSignature(loop)).toBe("outer")
	})

	test("a deep chain is read but bounded", () => {
		let node: unknown = { message: "deepest ECONNREFUSED" }
		for (let i = 0; i < 4; i++) node = { message: `layer${i}`, cause: node }
		expect(errorSignature(node)).toContain("ECONNREFUSED")
		expect(describeFailure(node, URL_BASE).reason).toContain("refused")
	})

	test("a thrown non-object is not dropped", () => {
		expect(errorSignature("ECONNREFUSED")).toBe("ECONNREFUSED")
		expect(describeFailure("plain string", URL_BASE).reason).toContain("plain string")
	})
})

describe("P3 the probe verdict, end to end", () => {
	test("probe reports a refusal and leaves no timer armed", async () => {
		const model = new Model({
			baseUrl: URL_BASE,
			probeTimeoutMs: 50,
			fetchImpl: (async () => {
				throw nodeRefused()
			}) as unknown as typeof fetch,
		})
		const result = await model.probe()
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason).toContain("refused")
		expect(liveAbortTimers()).toBe(0)
	})

	test("a wrong path is reported as a path problem, not a dead server", async () => {
		const model = new Model({
			baseUrl: "http://127.0.0.1:8080",
			fetchImpl: (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch,
		})
		const result = await model.probe()
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.hint).toContain("/v1")
	})

	test("a live server reports what it serves", async () => {
		const model = new Model({
			baseUrl: URL_BASE,
			fetchImpl: (async () =>
				new Response(JSON.stringify({ data: [{ id: "Rawaseeng-14B-Oracle" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as unknown as typeof fetch,
		})
		const result = await model.probe()
		expect(result.ok).toBe(true)
		if (result.ok) expect(result.models).toEqual(["Rawaseeng-14B-Oracle"])
	})
})
