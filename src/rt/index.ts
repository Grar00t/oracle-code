// Runtime layer: the only file that is allowed to know which engine and which
// operating system we are on.
//
// FACT: the rest of the tree used Bun.file, Bun.write, Bun.spawn, Bun.which,
// Bun.Glob, Bun.CryptoHasher, Bun.randomUUIDv7 and `for await (const line of
// console)`. None of those exist under Node, and three of them (bash -lc,
// $HOME, PATH without PATHEXT) do not exist on Windows either. Everything is
// funnelled through here so one port covers both engines and both platforms.

import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { delimiter, dirname, join, resolve, sep } from "node:path"
import { createInterface, type Interface } from "node:readline"

export const isWindows = process.platform === "win32"

/** Engine identity, for the session header and the status line. */
export function runtimeLabel(): string {
	const bunVersion = (globalThis as { Bun?: { version?: string } }).Bun?.version
	const engine = bunVersion ? `bun ${bunVersion}` : `node ${process.versions.node}`
	return `${engine} \u00b7 ${process.platform}-${process.arch}`
}

export function home(): string {
	// $HOME is unset on Windows; USERPROFILE is what exists there.
	return homedir()
}

export function tmp(): string {
	return tmpdir()
}

export function toPosix(p: string): string {
	return p.split(sep).join("/").replace(/\\/g, "/")
}

export async function readText(path: string): Promise<string> {
	return readFile(path, "utf8")
}

export async function writeText(path: string, data: string): Promise<void> {
	const full = resolve(path)
	await mkdir(dirname(full), { recursive: true })
	await writeFile(full, data, "utf8")
}

export async function appendText(path: string, data: string): Promise<void> {
	const full = resolve(path)
	await mkdir(dirname(full), { recursive: true })
	await writeFile(full, data, { encoding: "utf8", flag: "a" })
}

export async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK)
		return true
	} catch {
		return false
	}
}

export async function remove(path: string): Promise<void> {
	await rm(path, { force: true, recursive: true })
}

export function sha256hex(data: string): string {
	return createHash("sha256").update(data, "utf8").digest("hex")
}

export function uuid(): string {
	return randomUUID()
}

/** Resolve an executable on PATH. Honours PATHEXT, which is why `rg` was never found on Windows. */
export async function which(bin: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
	const pathVar = env.PATH ?? env.Path ?? ""
	const exts = isWindows
		? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
		: [""]
	for (const raw of pathVar.split(delimiter)) {
		const dir = raw.replace(/^"|"$/g, "")
		if (!dir) continue
		for (const ext of exts) {
			const candidate = join(dir, bin + ext)
			if (await exists(candidate)) return candidate
		}
	}
	return null
}

export type ShellPlan = {
	/** Executable to spawn. */
	file: string
	/** Full argument vector, command included. */
	args: string[]
	/** Human-readable shell name for the tool output header. */
	shell: string
}

/**
 * Decide which shell runs a command. Pure, so both branches are testable from
 * either platform.
 *
 * Windows has no bash. `bash -lc` there either fails outright or silently
 * lands inside a WSL distribution with a different filesystem, which is worse
 * than failing.
 */
export function shellPlan(
	command: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): ShellPlan {
	const override = env.ORACLE_SHELL
	if (platform === "win32") {
		if (override && /pwsh|powershell/i.test(override)) {
			return { file: override, args: ["-NoLogo", "-NoProfile", "-Command", command], shell: "powershell" }
		}
		if (override) return { file: override, args: ["/d", "/s", "/c", command], shell: override }
		const comspec = env.ComSpec ?? env.COMSPEC ?? "cmd.exe"
		return { file: comspec, args: ["/d", "/s", "/c", command], shell: "cmd" }
	}
	if (override) return { file: override, args: ["-c", command], shell: override }
	const shell = env.SHELL ?? "/bin/sh"
	// Only bash and zsh accept -l with -c reliably; dash treats it differently.
	const login = /bash|zsh/.test(shell)
	return { file: shell, args: login ? ["-lc", command] : ["-c", command], shell }
}

export type CaptureResult = {
	code: number
	stdout: string
	stderr: string
	timedOut: boolean
}

/** Spawn, capture both streams, enforce a timeout. No shell interpolation. */
export function spawnCapture(
	file: string,
	args: string[],
	opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CaptureResult> {
	return new Promise((resolvePromise) => {
		const child = spawn(file, args, {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		})
		let stdout = ""
		let stderr = ""
		let timedOut = false
		const timer = opts.timeoutMs
			? setTimeout(() => {
					timedOut = true
					child.kill()
				}, opts.timeoutMs)
			: null
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8")
		})
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8")
		})
		const finish = (code: number) => {
			if (timer) clearTimeout(timer)
			resolvePromise({ code, stdout, stderr, timedOut })
		}
		child.on("error", (error) => {
			stderr += `${(error as Error).message}\n`
			finish(127)
		})
		child.on("close", (code) => finish(code ?? 0))
	})
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".oracle"])

/** Translate a glob into a regular expression over forward-slash paths. */
export function globToRegExp(pattern: string): RegExp {
	const p = pattern.replace(/\\/g, "/")
	let out = "^"
	for (let i = 0; i < p.length; i++) {
		const c = p[i]!
		if (c === "*") {
			if (p[i + 1] === "*") {
				i++
				if (p[i + 1] === "/") {
					i++
					out += "(?:[^/]*/)*"
				} else {
					out += ".*"
				}
			} else {
				out += "[^/]*"
			}
		} else if (c === "?") {
			out += "[^/]"
		} else if ("\\^$+.()|{}[]".includes(c)) {
			out += `\\${c}`
		} else {
			out += c
		}
	}
	return new RegExp(`${out}$`)
}

async function walk(dir: string, out: string[], limit: number): Promise<void> {
	let entries: string[] = []
	try {
		entries = await readdir(dir)
	} catch {
		return
	}
	for (const entry of entries) {
		if (out.length >= limit) return
		if (SKIP_DIRS.has(entry)) continue
		const full = join(dir, entry)
		const info = await stat(full).catch(() => null)
		if (!info) continue
		if (info.isDirectory()) await walk(full, out, limit)
		else out.push(full)
	}
}

/** Portable replacement for Bun.Glob. Returns forward-slash relative paths. */
export async function globFiles(pattern: string, cwd: string, limit = 2000): Promise<string[]> {
	const re = globToRegExp(pattern)
	const files: string[] = []
	await walk(resolve(cwd), files, 200_000)
	const hits: string[] = []
	for (const file of files) {
		const rel = toPosix(file.slice(resolve(cwd).length + 1))
		if (rel && !rel.startsWith(".") && re.test(rel)) hits.push(rel)
		if (hits.length >= limit) break
	}
	return hits.sort()
}

export async function listFiles(dir: string, limit = 200_000): Promise<string[]> {
	const out: string[] = []
	await walk(resolve(dir), out, limit)
	return out
}

// ---------------------------------------------------------------------------
// stdin
//
// One reader for the whole process. Two independent `for await (const line of
// console)` loops used to race: a permission prompt raised during a turn stole
// the next line from the main input loop, so the answer to "[y/N]" could be
// swallowed as a prompt, or a prompt could eat the user's next task.

let iface: Interface | null = null
let closed = false
const queued: string[] = []
const waiting: Array<(line: string | null) => void> = []

function ensureStdin(): Interface {
	if (iface) return iface
	iface = createInterface({ input: process.stdin, terminal: false })
	iface.on("line", (line) => {
		const waiter = waiting.shift()
		if (waiter) waiter(line)
		else queued.push(line)
	})
	iface.on("close", () => {
		closed = true
		while (waiting.length) waiting.shift()!(null)
	})
	return iface
}

/** Next line of stdin, or null at end of input. Safe to call from anywhere. */
export function nextLine(): Promise<string | null> {
	if (queued.length) return Promise.resolve(queued.shift()!)
	if (closed) return Promise.resolve(null)
	ensureStdin()
	return new Promise((resolvePromise) => waiting.push(resolvePromise))
}

export function closeStdin(): void {
	iface?.close()
	iface = null
}

/** Test seam: feed lines without a real terminal. */
export function __pushLine(line: string): void {
	const waiter = waiting.shift()
	if (waiter) waiter(line)
	else queued.push(line)
}

export function __pendingReaders(): number {
	return waiting.length
}
