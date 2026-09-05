// File checkpoints.
//
// FACT (reference tool): snapshot a file before each edit, undo independently of
// git, and keep working across session resume. Checkpoints cover files only.
//
// This implementation is content-addressed, so repeated edits of the same file
// cost one blob per distinct content, and a restore is a copy, never a patch
// replay.

import { mkdir, readdir, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

export type CheckpointEntry = {
	seq: number
	path: string
	hash: string
	/** Null when the file did not exist before the edit. */
	existed: boolean
	at: string
	tool: string
}

async function sha256(data: string): Promise<string> {
	const digest = new Bun.CryptoHasher("sha256")
	digest.update(data)
	return digest.digest("hex")
}

export class Checkpoints {
	private readonly root: string
	private readonly log: CheckpointEntry[] = []
	private seq = 0

	constructor(sessionId: string, baseDir = ".oracle") {
		this.root = resolve(baseDir, "checkpoints", sessionId)
	}

	async snapshot(filePath: string, tool: string): Promise<CheckpointEntry> {
		await mkdir(join(this.root, "blobs"), { recursive: true })
		let content = ""
		let existed = true
		try {
			content = await Bun.file(filePath).text()
		} catch {
			existed = false
		}
		const hash = await sha256(content)
		const blob = join(this.root, "blobs", hash)
		if (!(await Bun.file(blob).exists())) await Bun.write(blob, content)

		const entry: CheckpointEntry = {
			seq: ++this.seq,
			path: resolve(filePath),
			hash,
			existed,
			at: new Date().toISOString(),
			tool,
		}
		this.log.push(entry)
		await Bun.write(join(this.root, "index.jsonl"), `${this.log.map((e) => JSON.stringify(e)).join("\n")}\n`)
		return entry
	}

	/** Restore the most recent snapshot. Returns the restored path, if any. */
	async undo(): Promise<string | null> {
		const entry = this.log.pop()
		if (!entry) return null
		const blob = join(this.root, "blobs", entry.hash)
		if (!entry.existed) {
			// The edit created the file; undo means removing it again.
			try {
				await Bun.file(entry.path).delete()
			} catch {
				// already gone
			}
			return entry.path
		}
		await mkdir(dirname(entry.path), { recursive: true })
		await Bun.write(entry.path, await Bun.file(blob).text())
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
