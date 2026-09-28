// A filesystem boundary for built-in file tools, not a sandbox for shell/MCP.
// Revalidate immediately before mutation. Concurrent hostile filesystem changes
// still require OS-level isolation; a realpath check alone cannot remove TOCTOU.
import { lstat, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"

function contained(root: string, path: string): boolean {
	const rel = relative(root, path)
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export async function workspacePath(cwd: string, input: unknown, mutation = false): Promise<string> {
	if (typeof input !== "string" || !input.trim() || input.includes("\0"))
		throw new Error("path must be a non-empty string without NUL")
	const lexicalRoot = resolve(cwd)
	const lexical = resolve(lexicalRoot, input)
	if (!contained(lexicalRoot, lexical)) throw new Error("path is outside the workspace")
	const root = await realpath(lexicalRoot)
	const target = resolve(root, relative(lexicalRoot, lexical))
	const tail: string[] = []
	let ancestor = target
	while (true) {
		try {
			await lstat(ancestor)
			break
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			const parent = dirname(ancestor)
			if (parent === ancestor) throw new Error("no existing path ancestor")
			tail.unshift(basename(ancestor))
			ancestor = parent
		}
	}
	// Dangling symlinks fail here rather than being treated as missing files.
	const canonical = resolve(await realpath(ancestor), ...tail)
	if (!contained(root, canonical)) throw new Error("symlink leaves the workspace")
	if (mutation) {
		const rel = relative(root, canonical)
		if (!rel) throw new Error("refusing to mutate the workspace root")
		if (rel.split(sep).some((part) => [".git", ".oracle"].includes(part.toLowerCase())))
			throw new Error("repository metadata and Oracle state are protected")
	}
	return canonical
}

// Do not recurse through symlinks, including links back to an ancestor.
export async function workspaceFiles(cwd: string, start = ".", limit = 20_000): Promise<string[]> {
	const { readdir } = await import("node:fs/promises")
	const files: string[] = []
	let visited = 0
	async function walk(path: string): Promise<void> {
		if (++visited > limit) throw new Error("workspace scan limit exceeded")
		const info = await lstat(path)
		if (info.isSymbolicLink()) return
		if (info.isFile()) { files.push(path); return }
		if (!info.isDirectory()) return
		for (const name of await readdir(path)) {
			if (["node_modules", ".git", "dist", ".oracle"].includes(name)) continue
			await walk(resolve(path, name))
		}
	}
	await walk(await workspacePath(cwd, start))
	return files
}
