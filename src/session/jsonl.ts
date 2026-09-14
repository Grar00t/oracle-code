// Sessions as plain JSONL.
//
// FACT (reference tool): a text JSONL file per session holds every message, tool
// call and result; resume, history and forking all come from it.
//
// Addition: payloads above a threshold are content-addressed into a blob store
// and referenced by hash. The transcript stays small enough to inspect with jq
// even after a session reads a 200k-line file, and replay is still exact.
//
// Runtime-agnostic: hashing, ids and file access go through src/rt.

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
	| "filler"
	| "frame"
	| "error"

export type SessionRecord = {
	seq: number
	at: string
	kind: RecordKind
	/** Inline payload, or { blob: "<sha256>", bytes: n } when externalized. */
	data: unknown
}

const INLINE_LIMIT = 4096

/** Session ids become path components, so they must be legal on Windows too. */
export function sessionIdFor(now = new Date(), token = uuid()): string {
	return `${now.toISOString().replace(/[:.]/g, "-")}-${token.replace(/-/g, "").slice(0, 8)}`
}

/** Turn an absolute working directory into one safe path component. */
export function projectKey(cwd = process.cwd()): string {
	return resolve(cwd).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

export class Session {
	readonly id: string
	readonly dir: string
	readonly file: string
	/** The store root this session was opened under: <baseDir>. */
	readonly baseDir: string
	private seq = 0

	constructor(opts: { id?: string; baseDir?: string; project?: string } = {}) {
		this.id = opts.id ?? sessionIdFor()
		const project = opts.project ?? projectKey()
		this.baseDir = resolve(opts.baseDir ?? ".oracle")
		this.dir = resolve(this.baseDir, "sessions", project)
		this.file = join(this.dir, `${this.id}.jsonl`)
	}

	async append(kind: RecordKind, data: unknown): Promise<SessionRecord> {
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

	/** Resolve a record's payload, reading the blob store when needed. */
	async resolve(record: SessionRecord): Promise<unknown> {
		const data = record.data as { blob?: string }
		if (data && typeof data === "object" && typeof data.blob === "string") {
			return JSON.parse(await readText(join(this.dir, "blobs", data.blob)))
		}
		return record.data
	}

	async read(): Promise<SessionRecord[]> {
		const text = await readText(this.file).catch(() => "")
		return text
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line) as SessionRecord)
	}

	/**
	 * Fork the transcript up to and including `throughSeq` into a new session.
	 *
	 * The child must open the SAME store root, so it is passed explicitly.
	 */
	async fork(throughSeq: number): Promise<Session> {
		const records = (await this.read()).filter((r) => r.seq <= throughSeq)
		const child = new Session({ baseDir: this.baseDir })
		await writeText(child.file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`)
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
