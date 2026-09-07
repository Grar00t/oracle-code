// Sessions as plain JSONL.
//
// Payloads above a threshold are content-addressed into a blob store.
// A truncated last line is skipped on read. Resume continues seq from disk.

import { readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { appendText, exists, readText, sha256hex, uuid, writeText } from "../rt/index"

export type RecordKind =
	| "session.start"
	| "user"
	| "assistant"
	| "tool.call"
	| "tool.result"
	| "compaction"
	| "permission"
	| "checkpoint"
	| "frame"
	| "error"

export type SessionRecord = {
	seq: number
	at: string
	kind: RecordKind
	data: unknown
}

const INLINE_LIMIT = 4096

export function sessionIdFor(now = new Date(), token = uuid()): string {
	return `${now.toISOString().replace(/[:.]/g, "-")}-${token.replace(/-/g, "").slice(0, 8)}`
}

export function projectKey(cwd = process.cwd()): string {
	return resolve(cwd).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

export class Session {
	readonly id: string
	readonly dir: string
	readonly file: string
	readonly baseDir: string
	readonly project: string
	private seq = 0
	private seqHydrated = false

	constructor(opts: { id?: string; baseDir?: string; project?: string } = {}) {
		this.id = opts.id ?? sessionIdFor()
		this.project = opts.project ?? projectKey()
		this.baseDir = resolve(opts.baseDir ?? ".oracle")
		this.dir = resolve(this.baseDir, "sessions", this.project)
		this.file = join(this.dir, `${this.id}.jsonl`)
	}

	private async hydrateSeq(): Promise<void> {
		if (this.seqHydrated) return
		this.seqHydrated = true
		const records = await this.read()
		this.seq = records.reduce((max, r) => Math.max(max, r.seq), 0)
	}

	async append(kind: RecordKind, data: unknown): Promise<SessionRecord> {
		await this.hydrateSeq()
		let payload = data
		const serialized = JSON.stringify(data)
		if (serialized.length > INLINE_LIMIT) {
			const hash = sha256hex(serialized)
			const blobPath = join(this.dir, "blobs", hash)
			if (!(await exists(blobPath))) await writeText(blobPath, serialized)
			payload = { blob: hash, bytes: serialized.length }
		}
		const record: SessionRecord = {
			seq: ++this.seq,
			at: new Date().toISOString(),
			kind,
			data: payload,
		}
		await appendText(this.file, `${JSON.stringify(record)}\n`)
		return record
	}

	async resolve(record: SessionRecord): Promise<unknown> {
		const data = record.data as { blob?: string }
		if (data && typeof data === "object" && typeof data.blob === "string") {
			return JSON.parse(await readText(join(this.dir, "blobs", data.blob)))
		}
		return record.data
	}

	async read(): Promise<SessionRecord[]> {
		const text = await readText(this.file).catch(() => "")
		const records: SessionRecord[] = []
		for (const line of text.split(/\r?\n/)) {
			if (!line) continue
			try {
				const record = JSON.parse(line) as SessionRecord
				if (typeof record.seq === "number" && typeof record.kind === "string") records.push(record)
			} catch {
				// A truncated last line from a killed process is not a session.
			}
		}
		return records
	}

	async fork(throughSeq: number): Promise<Session> {
		const records = (await this.read()).filter((r) => r.seq <= throughSeq)
		const child = new Session({ baseDir: this.baseDir, project: this.project })
		await writeText(child.file, records.length ? `${records.map((r) => JSON.stringify(r)).join("\n")}\n` : "")
		child.seq = records.reduce((max, r) => Math.max(max, r.seq), 0)
		child.seqHydrated = true
		return child
	}

	static async list(baseDir = ".oracle"): Promise<string[]> {
		try {
			const projects = await readdir(resolve(baseDir, "sessions"))
			const out: string[] = []
			for (const project of projects) {
				for (const file of await readdir(resolve(baseDir, "sessions", project))) {
					if (file.endsWith(".jsonl")) out.push(`${project}/${file}`)
				}
			}
			return out.sort().reverse()
		} catch {
			return []
		}
	}
}
