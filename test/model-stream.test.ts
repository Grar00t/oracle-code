import { describe, expect, test } from "bun:test"
import { Model } from "../src/agent/model"

const encoder = new TextEncoder()
const frame = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ delta }] })}

`
const request = (response: Response) => new Model({
	fetchImpl: (async () => response) as unknown as typeof fetch,
})

describe("completion stream lifecycle", () => {
	test("ignores content and tool calls after the protocol terminator", async () => {
		const response = new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(frame({ content: "before" }) + "data: [DONE]\n\n" +
					frame({ content: "after", tool_calls: [{ index: 0, id: "late", function: { name: "write", arguments: "{}" } }] })))
				controller.close()
			},
		}))
		const result = await request(response).complete([], [])
		expect(result.text).toBe("before")
		expect(result.toolCalls).toEqual([])
		expect(response.body!.locked).toBe(false)
	})

	test("finishes and cancels at DONE without waiting for HTTP EOF", async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>
		let cancelled = false
		const response = new Response(new ReadableStream<Uint8Array>({
			start(c) {
				controller = c
				c.enqueue(encoder.encode(frame({ content: "complete" }) + "data: [DO"))
				c.enqueue(encoder.encode("NE]\r\n\r\n"))
			},
			cancel() { cancelled = true },
		}))
		const completion = request(response).complete([], [])
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			const result = await Promise.race([completion, new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), 250)
			})])
			expect(result?.text).toBe("complete")
			expect(cancelled).toBe(true)
			expect(response.body!.locked).toBe(false)
		} finally {
			clearTimeout(timer)
			if (!cancelled) controller.close()
			await completion.catch(() => {})
		}
	})

	test("cancels the reader when a consumer callback throws", async () => {
		let cancelled = false
		const response = new Response(new ReadableStream<Uint8Array>({
			start(c) { c.enqueue(encoder.encode(frame({ content: "hello" }))) },
			cancel() { cancelled = true; throw new Error("cleanup failed") },
		}))
		await expect(request(response).complete([], [], () => {
			throw new Error("render failed")
		})).rejects.toThrow("render failed")
		expect(cancelled).toBe(true)
		expect(response.body!.locked).toBe(false)
	})

	test("releases a failed reader without hiding the transport error", async () => {
		const response = new Response(new ReadableStream<Uint8Array>({
			start(c) { c.error(new Error("stream failed")) },
		}))
		await expect(request(response).complete([], [])).rejects.toThrow("stream failed")
		expect(response.body!.locked).toBe(false)
	})

	test("releases the reader after ordinary EOF", async () => {
		const response = new Response(frame({ content: "hello" }))
		expect((await request(response).complete([], [])).text).toBe("hello")
		expect(response.body!.locked).toBe(false)
	})
})
