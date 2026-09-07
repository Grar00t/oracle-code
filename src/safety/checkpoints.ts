// File checkpoints.
//
// FACT (reference tool): snapshot a file before each edit, undo independently of
// git, and keep working across session resume. Checkpoints cover files only.
//
// This implementation is content-addressed, so repeated edits of the same file
// cost one blob per distinct content, and a restore is a copy, never a patch
// replay. Hashing and file access go through src/rt so it runs under Node and
// on Windows as well as under Bun.
//
// Limits, stated so they stay limits:
// - A directory is recorded as kind "directory". Undo cannot recreate its
//   children; the row is kept so the history of what was snapshotted stays true.
// - The index is rewritten atomically (temp file + rename). A crash mid-write
//   must not leave a truncated history as the only copy.
// - The in-memory log is rehydrated from index.jsonl on first use, so a new
//   Checkpoints(sessionId) against an existing store can undo.

import { readdir, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { exists, readText, remove, sha256hex, writeTextAtomic } from "../rt/index"

export type CheckpointKind = "file" | "missing" | "directory"

export type CheckpointEntry = {
	seq: number
	path: string
	hash: string
	/** False when the path did not exist before the edit. */
	existed: boolean
	at: string
	tool: string
	kind: CheckpointKind
}

export class Checkpoints {
	private readonly root: string
	private readonly log: CheckpointEntry[] = []
	private seq = 0
	private hydrated = false

	constructor(sessionId: string, baseDir = ".oracle") {
		const safeId = sessionId.replace(/[:*?"<>|]/g, "-")
		this.root = resolve(baseDir, "checkpoints", safeId)
	}

	private indexPath(): string {
		return join(this.root, "index.jsonl")
	}

	async hydrate(): Promise<void> {
		if (this.hydrated) return
		this.hydrated = true
		const text = await readText(this.indexPath()).catch(() => "")
		if (!text) return
		const loaded: CheckpointEntry[] = []
		for (const line of text.split(/\r?\n/)) {
			if (!line) continue
			try {
				const entry = JSON.parse(line) as CheckpointEntry
				if (typeof entry.seq !== "number" || typeof entry.path !== "string") continue
				if (!entry.kind) entry.kind = entry.existed ? "file" : "missing"
				loaded.push(entry)
			} catch {
				// A truncated last line is dropped, not fatal.
			}
		}
		if (!this.log.length) {
			this.log.push(...loaded)
			this.seq = loaded.reduce((max, e) => Math.max(max, e.seq), 0)
		}
	}

	private async persist(): Promise<void> {
		const body = this.log.length ? `${this.log.map((e) => JSON.stringify(e)).join("\n")}\n` : ""
		await writeTextAtomic(this.indexPath(), body)
	}

	async snapshot(filePath: string, tool: string): Promise<CheckpointEntry> {
		await this.hydrate()
		const resolved = resolve(filePath)
		let content = ""
		let existed = true
		let kind: CheckpointKind = "file"
		try {
			const info = await stat(resolved)
			if (info.isDirectory()) {
				kind = "directory"
				existed = true
			} else {
				content = await readText(resolved)
			}
		} catch {
			existed = false
			kind = "missing"
		}
		const hash = kind === "file" ? sha256hex(content) : ""
		if (kind === "file") {
			const blob = join(this.root, "blobs", hash)
			if (!(await exists(blob))) await writeTextAtomic(blob, content)
		}

		const entry: CheckpointEntry = {
			seq: ++this.seq,
			path: resolved,
			hash,
			existed,
			at: new Date().toISOString(),
			tool,
			kind,
		}
		this.log.push(entry)
		await this.persist()
		return entry
	}

	async undo(): Promise<string | null> {
		await this.hydrate()
		const entry = this.log.pop()
		if (!entry) return null
		try {
			if (!entry.existed || entry.kind === "missing") {
				await remove(entry.path).catch(() => undefined)
			} else if (entry.kind === "directory") {
				// Checkpoints cover files only.
			} else {
				const blob = join(this.root, "blobs", entry.hash)
				await writeTextAtomic(entry.path, await readText(blob))
			}
		} finally {
			await this.persist()
		}
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
