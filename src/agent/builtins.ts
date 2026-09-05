// Built-in tools: file operations, search, execution.
//
// Search prefers ripgrep when it is on PATH and falls back to a pure-Bun walk,
// so the tool never silently disappears on a machine without rg.

import { readdir, stat } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import type { Tool } from "./tools"

const MAX_OUTPUT = 30_000

function clip(text: string): string {
	if (text.length <= MAX_OUTPUT) return text
	return `${text.slice(0, MAX_OUTPUT)}\n... [truncated ${text.length - MAX_OUTPUT} bytes]`
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
	let entries: string[] = []
	try {
		entries = await readdir(dir)
	} catch {
		return out
	}
	for (const entry of entries) {
		if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === ".oracle") continue
		const full = join(dir, entry)
		const info = await stat(full).catch(() => null)
		if (!info) continue
		if (info.isDirectory()) await walk(full, out)
		else out.push(full)
	}
	return out
}

export const readFile: Tool = {
	name: "read",
	description: "Read a UTF-8 file. Optionally start at a 1-based line and limit the line count.",
	readOnly: true,
	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
			lineStart: { type: "number" },
			lineCount: { type: "number" },
		},
		required: ["path"],
	},
	summarize: (a) => `read ${a.path}`,
	async run(args, ctx) {
		const path = resolve(ctx.cwd, args.path)
		const text = await Bun.file(path).text()
		const lines = text.split("\n")
		const start = Math.max(1, args.lineStart ?? 1)
		const count = args.lineCount ?? lines.length
		const slice = lines.slice(start - 1, start - 1 + count)
		return clip(slice.map((l, i) => `${start + i}\t${l}`).join("\n"))
	},
}

export const globFiles: Tool = {
	name: "glob",
	description: "List files matching a glob pattern, relative to the working directory.",
	readOnly: true,
	parameters: {
		type: "object",
		properties: { pattern: { type: "string" } },
		required: ["pattern"],
	},
	summarize: (a) => `glob ${a.pattern}`,
	async run(args, ctx) {
		const glob = new Bun.Glob(args.pattern)
		const hits: string[] = []
		for await (const file of glob.scan({ cwd: ctx.cwd, dot: false })) {
			hits.push(file)
			if (hits.length >= 2000) break
		}
		return clip(hits.sort().join("\n") || "(no matches)")
	},
}

export const grepFiles: Tool = {
	name: "grep",
	description: "Search file contents with a regular expression. Uses ripgrep when available.",
	readOnly: true,
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string" },
			path: { type: "string" },
			ignoreCase: { type: "boolean" },
		},
		required: ["pattern"],
	},
	summarize: (a) => `grep ${a.pattern}`,
	async run(args, ctx) {
		const target = resolve(ctx.cwd, args.path ?? ".")
		const rg = Bun.which("rg")
		if (rg) {
			const proc = Bun.spawn(
				[rg, "--line-number", "--no-heading", "--color=never", ...(args.ignoreCase ? ["-i"] : []), args.pattern, target],
				{ stdout: "pipe", stderr: "pipe" },
			)
			const out = await new Response(proc.stdout).text()
			const code = await proc.exited
			if (code > 1) return `ripgrep failed: ${await new Response(proc.stderr).text()}`
			return clip(out || "(no matches)")
		}
		// Fallback: no native engine on this machine.
		const re = new RegExp(args.pattern, args.ignoreCase ? "i" : "")
		const files = await walk(target)
		const hits: string[] = []
		for (const file of files) {
			const text = await Bun.file(file).text().catch(() => "")
			text.split("\n").forEach((line, index) => {
				if (re.test(line)) hits.push(`${relative(ctx.cwd, file)}:${index + 1}:${line}`)
			})
			if (hits.length > 1000) break
		}
		return clip(hits.join("\n") || "(no matches)")
	},
}

export const writeFile: Tool = {
	name: "write",
	description: "Write a file, creating parent directories. Snapshots the previous content first.",
	readOnly: false,
	parameters: {
		type: "object",
		properties: { path: { type: "string" }, content: { type: "string" } },
		required: ["path", "content"],
	},
	summarize: (a) => `write ${a.path} (${String(a.content ?? "").length} bytes)`,
	async run(args, ctx) {
		const path = resolve(ctx.cwd, args.path)
		const checkpoint = await ctx.checkpoints.snapshot(path, "write")
		await ctx.session.append("checkpoint", checkpoint)
		await Bun.write(path, args.content)
		return `wrote ${args.path} (checkpoint #${checkpoint.seq})`
	},
}

export const editFile: Tool = {
	name: "edit",
	description: "Replace an exact string in a file. The old string must appear exactly once.",
	readOnly: false,
	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
			oldString: { type: "string" },
			newString: { type: "string" },
			replaceAll: { type: "boolean" },
		},
		required: ["path", "oldString", "newString"],
	},
	summarize: (a) => `edit ${a.path}`,
	async run(args, ctx) {
		const path = resolve(ctx.cwd, args.path)
		const before = await Bun.file(path).text()
		const occurrences = before.split(args.oldString).length - 1
		if (occurrences === 0) return "error: oldString not found"
		if (occurrences > 1 && !args.replaceAll)
			return `error: oldString appears ${occurrences} times; pass replaceAll or add context`
		const checkpoint = await ctx.checkpoints.snapshot(path, "edit")
		await ctx.session.append("checkpoint", checkpoint)
		const after = args.replaceAll
			? before.split(args.oldString).join(args.newString)
			: before.replace(args.oldString, args.newString)
		await Bun.write(path, after)
		return `edited ${args.path} (${occurrences} occurrence(s), checkpoint #${checkpoint.seq})`
	},
}

export const bash: Tool = {
	name: "bash",
	description: "Run a shell command in the working directory and return its combined output.",
	readOnly: false,
	// A command can reach anything: network, package registries, deploys.
	irreversible: true,
	parameters: {
		type: "object",
		properties: { command: { type: "string" }, timeoutMs: { type: "number" } },
		required: ["command"],
	},
	summarize: (a) => `$ ${a.command}`,
	async run(args, ctx) {
		const proc = Bun.spawn(["bash", "-lc", args.command], {
			cwd: ctx.cwd,
			stdout: "pipe",
			stderr: "pipe",
		})
		const timeout = args.timeoutMs ?? 120_000
		const timer = setTimeout(() => proc.kill(), timeout)
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		])
		clearTimeout(timer)
		return clip(`exit=${code}\n${out}${err ? `\n[stderr]\n${err}` : ""}`)
	},
}

export const builtins: Tool[] = [readFile, globFiles, grepFiles, writeFile, editFile, bash]
