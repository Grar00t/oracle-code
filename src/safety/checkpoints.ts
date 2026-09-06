// File checkpoints.
//
// FACT (reference tool): snapshot a file before each edit, undo independently of
// git, and keep working across session resume. Checkpoints cover files only.
//
// This implementation is content-addressed, so repeated edits of the same file
// cost one blob per distinct content, and a restore is a copy, never a patch
// replay. Hashing and file access go through src/rt so it runs under Node and
// on Windows as well as under Bun.

import { readdir, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { exists, readText, remove, sha256hex, writeText } from "../rt/index"

export type CheckpointEntry = {
	seq: number
	path: string
	hash: string
	/** False when the file did not exist before the edit. */
	existed: boolean
	at: string
	tool: string
}

export class Checkpoints {
	private readonly root: string
	private readonly log: CheckpointEntry[] = []
	private seq = 0

	constructor(sessionId: string, baseDir = ".oracle") {
		// Session ids carry a timestamp with colons; those are illegal in Windows
		// path components, so a raw id produced ENOENT on every snapshot there.
		const safeId = sessionId.replace(/[:*?"<>|]/g, "-")
		this.root = resolve(baseDir, "checkpoints", safeId)
	}

	async snapshot(filePath: string, tool: string): Promise<CheckpointEntry> {
		let content = ""
		let existed = true
		try {
			content = await readText(filePath)
		} catch {
			existed = false
		}
		const hash = sha256hex(content)
		const blob = join(this.root, "blobs", hash)
		if (!(await exists(blob))) await writeText(blob, content)

		const entry: CheckpointEntry = {
			seq: ++this.seq,
			path: resolve(filePath),
			hash,
			existed,
			at: new Date().toISOString(),
			tool,
		}
		this.log.push(entry)
		await writeText(join(this.root, "index.jsonl"), `${this.log.map((e) => JSON.stringify(e)).join("\n")}\n`)
		return entry
	}

	/** Restore the most recent snapshot. Returns the restored path, if any. */
	async undo(): Promise<string | null> {
		const entry = this.log.pop()
		if (!entry) return null
		const blob = join(this.root, "blobs", entry.hash)
		if (!entry.existed) {
			// The edit created the file; undo means removing it again.
			await remove(entry.path).catch(() => undefined)
			return entry.path
		}
		await writeText(entry.path, await readText(blob))
		return entry.path
	}

	entries(): readonly CheckpointEntry[] {
		return this.log
	}

	async diskUsage(): Promise<number> {
		try {
			const files = await readdir(join(this.root, "blobs"))
			let total = 0
			for (const f of files) total += (await stat(join(this.root, "blobs", f))).size
			return total
		} catch {
			return 0
		}
	}
}
