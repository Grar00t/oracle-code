// Sessions as plain JSONL.
//
// FACT (reference tool): a text JSONL file per session holds every message, tool
// call and result; resume, history and forking all come from it.
//
// Addition: payloads above a threshold are content-addressed into a blob store
// and referenced by hash. The transcript stays small enough to inspect with jq
// even after a session reads a 200k-line file, and replay is still exact.

import { appendFile, mkdir, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"

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
	/** Inline payload, or { blob: "<sha256>", bytes: n } when externalized. */
	data: unknown
}

const INLINE_LIMIT = 4096

export class Session {
	readonly id: string
	readonly dir: string
	readonly file: string
	/** The store root this session was opened under: <baseDir>. */
	readonly baseDir: string
	private seq = 0

	constructor(opts: { id?: string; baseDir?: string; project?: string } = {}) {
		this.id = opts.id ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-${Bun.randomUUIDv7().slice(0, 8)}`
		const project = opts.project ?? resolve(process.cwd()).replace(/[^a-zA-Z0-9]+/g, "-")
		this.baseDir = resolve(opts.baseDir ?? ".oracle")
		this.dir = resolve(this.baseDir, "sessions", project)
		this.file = join(this.dir, `${this.id}.jsonl`)
	}

	async append(kind: RecordKind, data: unknown): Promise<SessionRecord> {
		await mkdir(join(this.dir, "blobs"), { recursive: true })
		let payload = data
		const serialized = JSON.stringify(data)
		if (serialized.length > INLINE_LIMIT) {
			const hasher = new Bun.CryptoHasher("sha256")
			hasher.update(serialized)
			const hash = hasher.digest("hex")
			const blobPath = join(this.dir, "blobs", hash)
			if (!(await Bun.file(blobPath).exists())) await Bun.write(blobPath, serialized)
			payload = { blob: hash, bytes: serialized.length }
		}
		const record: SessionRecord = {
			seq: ++this.seq,
			at: new Date().toISOString(),
			kind,
			data: payload,
		}
		await appendFile(this.file, `${JSON.stringify(record)}\n`)
		return record
	}

	/** Resolve a record's payload, reading the blob store when needed. */
	async resolve(record: SessionRecord): Promise<unknown> {
		const data = record.data as { blob?: string }
		if (data && typeof data === "object" && typeof data.blob === "string") {
			return JSON.parse(await Bun.file(join(this.dir, "blobs", data.blob)).text())
		}
		return record.data
	}

	async read(): Promise<SessionRecord[]> {
		const text = await Bun.file(this.file).text().catch(() => "")
		return text
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as SessionRecord)
	}

	/**
	 * Fork the transcript up to and including `throughSeq` into a new session.
	 *
	 * The child must open the SAME store root. this.dir is
	 * <baseDir>/sessions/<project>, so the root is two levels up, not three;
	 * going three levels up wrote forks into the parent of the store, where
	 * Session.list() could never find them again.
	 */
	async fork(throughSeq: number): Promise<Session> {
		const records = (await this.read()).filter((r) => r.seq <= throughSeq)
		const child = new Session({ baseDir: this.baseDir })
		await mkdir(child.dir, { recursive: true })
		await Bun.write(child.file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`)
		return child
	}

	static async list(baseDir = ".oracle"): Promise<string[]> {
		try {
			const projects = await readdir(resolve(baseDir, "sessions"))
			const out: string[] = []
			for (const project of projects) {
				for (const file of await readdir(resolve(baseDir, "sessions", project))) {
					if (file.endsWith(".jsonl")) out.push(join(project, file))
				}
			}
			return out.sort().reverse()
		} catch {
			return []
		}
	}
}
