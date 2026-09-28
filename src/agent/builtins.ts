// Built-in tools. Successful calls return text; failures throw so the scheduler
// cannot turn a failed edit or nonzero process exit into an ok:true outcome.
// File tools are workspace-scoped. Shell and MCP still require their own trust
// boundary and are not sandboxed by these filesystem checks.
import { relative } from "node:path"
import { globToRegExp, readText, shellPlan, spawnCapture, toPosix, which, writeText } from "../rt/index"
import { workspaceFiles, workspacePath } from "../safety/paths"
import type { Tool } from "./tools"

const MAX_OUTPUT = 30_000
function clip(text: string): string {
	return text.length <= MAX_OUTPUT ? text : `${text.slice(0, MAX_OUTPUT)}\n... [truncated ${text.length - MAX_OUTPUT} characters]`
}
function requireText(value: unknown, name: string): string {
	if (typeof value !== "string") throw new Error(`${name} must be a string`)
	return value
}

export const readFile: Tool = {
	name: "read",
	description: "Read a UTF-8 file inside the workspace. Optional 1-based lineStart and lineCount.",
	readOnly: true,
	parameters: { type: "object", properties: { path: { type: "string" }, lineStart: { type: "number" }, lineCount: { type: "number" } }, required: ["path"] },
	summarize: (a) => `read ${a.path}`,
	async run(args, ctx) {
		const path = await workspacePath(ctx.cwd, args.path)
		const lines = (await readText(path)).split(/\r?\n/)
		const start = Math.max(1, args.lineStart ?? 1)
		const count = args.lineCount ?? lines.length
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count < 0)
			throw new Error("line range must contain nonnegative integers")
		return clip(lines.slice(start - 1, start - 1 + count).map((line, i) => `${start + i}\t${line}`).join("\n"))
	},
}

export const globFiles: Tool = {
	name: "glob",
	description: "List workspace files matching a glob. Does not follow directory symlinks.",
	readOnly: true,
	parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
	summarize: (a) => `glob ${a.pattern}`,
	async run(args, ctx) {
		const re = globToRegExp(requireText(args.pattern, "pattern"))
		const root = await workspacePath(ctx.cwd, ".")
		const hits = (await workspaceFiles(ctx.cwd)).map((file) => toPosix(relative(root, file))).filter((file) => re.test(file))
		return clip(hits.sort().join("\n") || "(no matches)")
	},
}

export const grepFiles: Tool = {
	name: "grep",
	description: "Search workspace file contents with a regular expression. Uses ripgrep when available.",
	readOnly: true,
	parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, ignoreCase: { type: "boolean" } }, required: ["pattern"] },
	summarize: (a) => `grep ${a.pattern}`,
	async run(args, ctx) {
		const pattern = requireText(args.pattern, "pattern")
		const target = await workspacePath(ctx.cwd, args.path ?? ".")
		const rg = await which("rg")
		if (rg) {
			const res = await spawnCapture(rg, ["--line-number", "--no-heading", "--color=never", ...(args.ignoreCase ? ["-i"] : []), "--", pattern, target], { cwd: ctx.cwd, timeoutMs: 60_000 })
			if (res.timedOut || res.code !== 0 && res.code !== 1) throw new Error(`ripgrep failed: exit=${res.code} ${res.stderr}`)
			return clip(res.stdout || "(no matches)")
		}
		const re = new RegExp(pattern, args.ignoreCase ? "i" : "")
		const hits: string[] = []
		for (const file of await workspaceFiles(ctx.cwd, args.path ?? ".")) {
			const text = await readText(await workspacePath(ctx.cwd, file))
			text.split(/\r?\n/).forEach((line, i) => {
				if (re.test(line)) hits.push(`${toPosix(relative(ctx.cwd, file))}:${i + 1}:${line}`)
			})
			if (hits.length > 1000) { hits.push("... [search results truncated]"); break }
		}
		return clip(hits.join("\n") || "(no matches)")
	},
}

export const writeFile: Tool = {
	name: "write",
	description: "Write a workspace file, creating parent directories. Snapshot previous bytes first.",
	readOnly: false,
	parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
	summarize: (a) => `write ${a.path} (${String(a.content ?? "").length} characters)`,
	async run(args, ctx) {
		const content = requireText(args.content, "content")
		const path = await workspacePath(ctx.cwd, args.path, true)
		const checkpoint = await ctx.checkpoints.snapshot(path, "write")
		await ctx.session.append("checkpoint", checkpoint)
		if (await workspacePath(ctx.cwd, args.path, true) !== path) throw new Error("path changed during snapshot")
		await writeText(path, content)
		return `wrote ${args.path} (checkpoint #${checkpoint.seq})`
	},
}

export const editFile: Tool = {
	name: "edit",
	description: "Replace exact literal text inside a workspace file. A failed match is a failed tool call.",
	readOnly: false,
	parameters: { type: "object", properties: { path: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" }, replaceAll: { type: "boolean" } }, required: ["path", "oldString", "newString"] },
	summarize: (a) => `edit ${a.path}`,
	async run(args, ctx) {
		const oldString = requireText(args.oldString, "oldString")
		const newString = requireText(args.newString, "newString")
		if (!oldString) throw new Error("oldString must not be empty")
		const path = await workspacePath(ctx.cwd, args.path, true)
		const before = await readText(path)
		const occurrences = before.split(oldString).length - 1
		if (occurrences === 0) throw new Error("oldString not found")
		if (occurrences > 1 && !args.replaceAll) throw new Error(`oldString appears ${occurrences} times; pass replaceAll or add context`)
		const checkpoint = await ctx.checkpoints.snapshot(path, "edit")
		await ctx.session.append("checkpoint", checkpoint)
		if (await workspacePath(ctx.cwd, args.path, true) !== path || await readText(path) !== before)
			throw new Error("file changed during snapshot; refusing stale edit")
		const after = args.replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, () => newString)
		await writeText(path, after)
		return `edited ${args.path} (${args.replaceAll ? occurrences : 1} occurrence(s), checkpoint #${checkpoint.seq})`
	},
}

export const bash: Tool = {
	name: "bash",
	description: "Run a shell command. Nonzero exits and timeouts fail. Shell is NOT a filesystem sandbox.",
	readOnly: false,
	irreversible: true,
	parameters: { type: "object", properties: { command: { type: "string" }, timeoutMs: { type: "number" } }, required: ["command"] },
	summarize: (a) => `$ ${a.command}`,
	async run(args, ctx) {
		const timeoutMs = args.timeoutMs ?? 120_000
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
			throw new Error("timeoutMs must be between 1 and 120000")
		const plan = shellPlan(requireText(args.command, "command"))
		const res = await spawnCapture(plan.file, plan.args, { cwd: ctx.cwd, timeoutMs })
		const output = clip(`exit=${res.code} shell=${plan.shell}${res.timedOut ? " (timed out)" : ""}\n${res.stdout}${res.stderr ? `\n[stderr]\n${res.stderr}` : ""}`)
		if (res.code !== 0 || res.timedOut) throw new Error(output)
		return output
	},
}

export const removePath: Tool = {
	name: "rm",
	description: "Delete one workspace file after checkpointing. Directory deletion is refused.",
	readOnly: false,
	irreversible: true,
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	summarize: (a) => `rm ${a.path}`,
	async run(args, ctx) {
		const path = await workspacePath(ctx.cwd, args.path, true)
		const checkpoint = await ctx.checkpoints.snapshot(path, "rm")
		if (!checkpoint.existed) throw new Error("file does not exist")
		await ctx.session.append("checkpoint", checkpoint)
		if (await workspacePath(ctx.cwd, args.path, true) !== path) throw new Error("path changed during snapshot")
		// Explicitly non-recursive: do not let a concurrent directory replacement
		// turn a single-file operation into a recursive delete.
		const { unlink } = await import("node:fs/promises")
		await unlink(path)
		return `removed ${args.path} (checkpoint #${checkpoint.seq})`
	},
}

export const builtins: Tool[] = [readFile, globFiles, grepFiles, writeFile, editFile, bash, removePath]
