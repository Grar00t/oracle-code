// Byte-preserving checkpoints with persisted undo and explicit failure states.
// A journal is single-writer. Stale instances fail instead of replacing history.
// This is local recovery, not an authenticated or adversary-proof backup system.
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"

export type CheckpointEntry = {
	seq: number
	path: string
	hash: string
	existed: boolean
	at: string
	tool: string
	mode?: number
}

const hashBytes = (data: Buffer): string => createHash("sha256").update(data).digest("hex")
const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === "ENOENT"
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024

async function atomicWrite(path: string, data: Buffer | string, mode = 0o600): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	const temp = `${path}.${randomUUID()}.tmp`
	try {
		await writeFile(temp, data, { flag: "wx", mode })
		await rename(temp, path)
	} finally {
		await rm(temp, { force: true })
	}
}

export class Checkpoints {
	private readonly root: string
	private log: CheckpointEntry[] = []
	private seq = 0
	private loaded = false
	private diskIndex = ""
	private queue: Promise<unknown> = Promise.resolve()

	constructor(sessionId: string, baseDir = ".oracle") {
		if (!sessionId || /[\\/\0]/.test(sessionId) || sessionId === "." || sessionId === "..")
			throw new Error("invalid checkpoint session id")
		const safeId = sessionId.replace(/[:*?"<>|]/g, "-")
		this.root = resolve(baseDir, "checkpoints", safeId)
	}

	private async index(): Promise<string> {
		try { return await readFile(join(this.root, "index.jsonl"), "utf8") }
		catch (error) { if (missing(error)) return ""; throw error }
	}

	private async load(): Promise<void> {
		if (this.loaded) return
		const text = await this.index()
		const entries: CheckpointEntry[] = []
		let seq = 0
		for (const line of text.trimEnd().split("\n")) {
			if (!line && !text) continue
			const e = JSON.parse(line) as CheckpointEntry
			if (!e || !Number.isSafeInteger(e.seq) || e.seq <= seq ||
				typeof e.path !== "string" || !isAbsolute(e.path) ||
				typeof e.hash !== "string" || !/^[0-9a-f]{64}$/.test(e.hash) ||
				typeof e.existed !== "boolean" || typeof e.tool !== "string" ||
				typeof e.at !== "string" || (e.mode !== undefined &&
				(!Number.isInteger(e.mode) || e.mode < 0 || e.mode > 0o777)))
				throw new Error("invalid checkpoint journal")
			seq = e.seq
			entries.push(e)
		}
		this.log = entries
		this.seq = seq
		this.diskIndex = text
		this.loaded = true
	}

	private serial<T>(run: () => Promise<T>): Promise<T> {
		const next = this.queue.then(async () => { await this.load(); return run() })
		this.queue = next.catch(() => undefined)
		return next
	}

	private async unchanged(): Promise<void> {
		if (await this.index() !== this.diskIndex)
			throw new Error("checkpoint journal changed; reopen this session before editing")
	}

	private async save(entries: CheckpointEntry[]): Promise<void> {
		await this.unchanged()
		const text = entries.length ? `${entries.map((e) => JSON.stringify(e)).join("\n")}\n` : ""
		await atomicWrite(join(this.root, "index.jsonl"), text)
		this.diskIndex = text
		this.log = entries
	}

	snapshot(filePath: string, tool: string): Promise<CheckpointEntry> {
		return this.serial(async () => {
			await this.unchanged()
			const path = resolve(filePath)
			let content: Buffer = Buffer.alloc(0)
			let existed = false
			let mode: number | undefined
			let info
			try { info = await lstat(path) }
			catch (error) { if (!missing(error)) throw error }
			if (info) {
				if (!info.isFile() || info.isSymbolicLink())
					throw new Error("checkpoints support regular files only; directories and symlinks are not recoverable")
				if (info.size > MAX_SNAPSHOT_BYTES) throw new Error("file exceeds 64 MiB checkpoint limit")
				content = await readFile(path)
				if (content.length > MAX_SNAPSHOT_BYTES) throw new Error("file grew beyond checkpoint limit")
				existed = true
				mode = info.mode & 0o777
			}
			const hash = hashBytes(content)
			const blob = join(this.root, "blobs", hash)
			let previous: Buffer | undefined
			try { previous = await readFile(blob) }
			catch (error) { if (!missing(error)) throw error }
			if (previous && hashBytes(previous) !== hash) throw new Error("checkpoint blob failed integrity check")
			if (!previous) await atomicWrite(blob, content)
			const entry: CheckpointEntry = { seq: this.seq + 1, path, hash, existed, at: new Date().toISOString(), tool, mode }
			await this.save([...this.log, entry])
			this.seq = entry.seq
			return { ...entry }
		})
	}

	undo(): Promise<string | null> {
		return this.serial(async () => {
			await this.unchanged()
			const entry = this.log[this.log.length - 1]
			if (!entry) return null
			let info
			try { info = await lstat(entry.path) }
			catch (error) { if (!missing(error)) throw error }
			if (info && (!info.isFile() || info.isSymbolicLink()))
				throw new Error("undo target is no longer a regular file")
			if (entry.existed) {
				const content = await readFile(join(this.root, "blobs", entry.hash))
				if (hashBytes(content) !== entry.hash) throw new Error("checkpoint blob failed integrity check")
				await atomicWrite(entry.path, content, entry.mode)
			} else {
				// Never recursive: a directory replacing a new file is not safe to remove.
				await rm(entry.path, { force: true })
			}
			// Keep the entry if the target restore or journal write fails.
			await this.save(this.log.slice(0, -1))
			return entry.path
		})
	}

	entries(): readonly CheckpointEntry[] { return this.log.map((entry) => ({ ...entry })) }

	async diskUsage(): Promise<number> {
		let files: string[]
		try { files = await readdir(join(this.root, "blobs")) }
		catch (error) { if (missing(error)) return 0; throw error }
		let total = 0
		for (const file of files) total += (await stat(join(this.root, "blobs", file))).size
		return total
	}
}
