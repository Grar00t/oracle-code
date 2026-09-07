// Runtime layer: the only file that is allowed to know which engine and which
// operating system we are on.

import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { delimiter, dirname, join, resolve, sep } from "node:path"
import { createInterface, type Interface } from "node:readline"

export const isWindows = process.platform === "win32"

export function runtimeLabel(): string {
	const bunVersion = (globalThis as { Bun?: { version?: string } }).Bun?.version
	const engine = bunVersion ? `bun ${bunVersion}` : `node ${process.versions.node}`
	return `${engine} \u00b7 ${process.platform}-${process.arch}`
}

export function home(): string {
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

export async function writeTextAtomic(path: string, data: string): Promise<void> {
	const full = resolve(path)
	await mkdir(dirname(full), { recursive: true })
	const tmpPath = `${full}.${process.pid}.${Date.now()}.tmp`
	await writeFile(tmpPath, data, "utf8")
	try {
		await rename(tmpPath, full)
	} catch {
		await rm(full, { force: true })
		await rename(tmpPath, full)
	}
}

export const SCRUBBED_ENV_KEYS = [
	"ORACLE_API_KEY",
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"OPENROUTER_API_KEY",
	"GROQ_API_KEY",
	"TOGETHER_API_KEY",
] as const

export function isScrubbedEnvKey(key: string): boolean {
	if ((SCRUBBED_ENV_KEYS as readonly string[]).includes(key)) return true
	return /^(ORACLE|OPENAI|ANTHROPIC|OPENROUTER)_.*KEY$/i.test(key)
}

export function scrubEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {}
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue
		if (isScrubbedEnvKey(key)) continue
		out[key] = value
	}
	return out
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
	file: string
	args: string[]
	shell: string
}

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
	const login = /bash|zsh/.test(shell)
	return { file: shell, args: login ? ["-lc", command] : ["-c", command], shell }
}

export type CaptureResult = {
	code: number
	stdout: string
	stderr: string
	timedOut: boolean
}

export function spawnCapture(
	file: string,
	args: string[],
	opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CaptureResult> {
	return new Promise((resolvePromise) => {
		const child = spawn(file, args, {
			cwd: opts.cwd,
			env: scrubEnv(opts.env ?? process.env),
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

export function __pushLine(line: string): void {
	const waiter = waiting.shift()
	if (waiter) waiter(line)
	else queued.push(line)
}

export function __pendingReaders(): number {
	return waiting.length
}
