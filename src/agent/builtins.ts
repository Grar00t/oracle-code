// Built-in tools: file operations, search, execution.
//
// Runtime-agnostic: every filesystem, process, hash and shell call goes through
// src/rt, so the same code runs under Bun and Node, on Linux and on Windows.
// Search prefers ripgrep when it is on PATH (PATHEXT included, which is how it
// is found on Windows at all) and falls back to a portable walk.

import { relative, resolve } from "node:path"
import {
	globFiles as rtGlob,
	listFiles,
	readText,
	remove,
	shellPlan,
	spawnCapture,
	toPosix,
	which,
	writeText,
} from "../rt/index"
import type { Tool } from "./tools"

const MAX_OUTPUT = 30_000

function clip(text: string): string {
	if (text.length <= MAX_OUTPUT) return text
	return `${text.slice(0, MAX_OUTPUT)}\n... [truncated ${text.length - MAX_OUTPUT} bytes]`
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
		const text = await readText(path)
		// Windows files arrive with CRLF; splitting on \n alone left a \r on every
		// line, which then reached the grid as a control character.
		const lines = text.split(/\r?\n/)
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
		const hits = await rtGlob(args.pattern, ctx.cwd)
		return clip(hits.join("\n") || "(no matches)")
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
		const rg = await which("rg")
		if (rg) {
			const res = await spawnCapture(
				rg,
				[
					"--line-number",
					"--no-heading",
					"--color=never",
					...(args.ignoreCase ? ["-i"] : []),
					args.pattern,
					target,
				],
				{ cwd: ctx.cwd, timeoutMs: 60_000 },
			)
			if (res.code > 1) return `ripgrep failed: ${res.stderr}`
			return clip(res.stdout || "(no matches)")
		}
		// Fallback: no native engine on this machine.
		const re = new RegExp(args.pattern, args.ignoreCase ? "i" : "")
		const files = await listFiles(target)
		const hits: string[] = []
		for (const file of files) {
			const text = await readText(file).catch(() => "")
			text.split(/\r?\n/).forEach((line, index) => {
				if (re.test(line)) hits.push(`${toPosix(relative(ctx.cwd, file))}:${index + 1}:${line}`)
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
		await writeText(path, args.content)
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
		const before = await readText(path)
		const occurrences = before.split(args.oldString).length - 1
		if (occurrences === 0) return "error: oldString not found"
		if (occurrences > 1 && !args.replaceAll)
			return `error: oldString appears ${occurrences} times; pass replaceAll or add context`
		const checkpoint = await ctx.checkpoints.snapshot(path, "edit")
		await ctx.session.append("checkpoint", checkpoint)
		const after = args.replaceAll
			? before.split(args.oldString).join(args.newString)
			: before.replace(args.oldString, args.newString)
		await writeText(path, after)
		return `edited ${args.path} (${occurrences} occurrence(s), checkpoint #${checkpoint.seq})`
	},
}

export const bash: Tool = {
	name: "bash",
	description:
		"Run a shell command in the working directory and return its combined output. Uses bash or sh on Linux and macOS, cmd.exe or PowerShell on Windows.",
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
		const plan = shellPlan(args.command)
		const res = await spawnCapture(plan.file, plan.args, {
			cwd: ctx.cwd,
			timeoutMs: args.timeoutMs ?? 120_000,
		})
		const head = `exit=${res.code} shell=${plan.shell}${res.timedOut ? " (timed out)" : ""}`
		return clip(`${head}\n${res.stdout}${res.stderr ? `\n[stderr]\n${res.stderr}` : ""}`)
	},
}

/** Delete a path. Present so undo has a counterpart the model can name. */
export const removePath: Tool = {
	name: "rm",
	description: "Delete a file or directory. Snapshots files first; directories are not recoverable.",
	readOnly: false,
	irreversible: true,
	parameters: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	},
	summarize: (a) => `rm ${a.path}`,
	async run(args, ctx) {
		const path = resolve(ctx.cwd, args.path)
		const checkpoint = await ctx.checkpoints.snapshot(path, "rm")
		await ctx.session.append("checkpoint", checkpoint)
		await remove(path)
		return `removed ${args.path} (checkpoint #${checkpoint.seq})`
	},
}

export const builtins: Tool[] = [readFile, globFiles, grepFiles, writeFile, editFile, bash, removePath]
