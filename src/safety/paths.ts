// Working-directory confinement for file tools.
//
// Shell remains the escape hatch and stays behind the irreversible gate.
// File tools (read, write, edit, rm, grep path) must not walk out of cwd
// via `..` or an absolute path on another root. A resolved path that is
// not the cwd itself and is not inside it is refused before any I/O.

import { isAbsolute, relative, resolve, sep } from "node:path"

export function pathEscapes(cwd: string, input: string): boolean {
	const root = resolve(cwd)
	const full = resolve(root, input)
	if (full === root) return false
	const rel = relative(root, full)
	if (!rel) return false
	if (isAbsolute(rel)) return true
	const first = rel.split(/[\\/]/)[0]
	return first === ".."
}

export function confinedPath(cwd: string, input: string): string {
	const root = resolve(cwd)
	const full = resolve(root, input)
	if (pathEscapes(root, input)) {
		throw new Error(`path escapes working directory: ${input}`)
	}
	if (full !== root && (full.endsWith(sep) || full.endsWith("/"))) {
		return full.replace(/[\\/]+$/, "")
	}
	return full
}
