// Interface language.
//
// The program ships exactly one language table: English. It does not ship a
// translation that cannot be verified, because a wrong string in a tool that
// reports facts is worse than an untranslated one.
//
// What it does ship is the machinery, and that part is verifiable: a terminal
// has no shaper and no bidi engine, it prints code points in the order it
// receives them, so a right-to-left line has to arrive already shaped and
// already reordered. Any language pack the user supplies gets that treatment
// for free.
//
// A pack is a JSON file at ~/.oracle/lang/<code>.json. It is rejected unless it
// carries every key, and the missing keys are named rather than silently
// filled, because a half-loaded interface is a lie about which language it is
// speaking.

import { hasArabic, shapeArabic } from "../text/arabic"
import { reorderLine, type Direction } from "../text/bidi"
import { exists, home, readText } from "../rt/index"
import { join } from "node:path"

export type StringKey =
	| "ready"
	| "working"
	| "undoHint"
	| "ckpt"
	| "irreversible"
	| "cells"
	| "prompt"
	| "askLabel"
	| "footer"
	| "startupHint"
	| "runtime"
	| "endpointUnreachable"
	| "serving"
	| "permissionMode"
	| "restored"
	| "nothingToUndo"
	| "contextCompacted"
	| "filler"
	| "error"
	| "language"
	| "noSessions"

const EN: Record<StringKey, string> = {
	ready: "ready.",
	working: "working",
	undoHint: "esc esc to undo",
	ckpt: "ckpt",
	irreversible: "irreversible",
	cells: "cells",
	prompt: "\u276f",
	askLabel: "ask",
	footer: "enter send \u00b7 tab mode \u00b7 ^z undo",
	startupHint: "type a task, /mode to cycle permissions, /lang to reload the language pack, /undo to restore, /quit to exit",
	runtime: "runtime",
	endpointUnreachable: "endpoint unreachable",
	serving: "serving",
	permissionMode: "permission mode",
	restored: "restored",
	nothingToUndo: "nothing to undo",
	contextCompacted: "context compacted",
	filler: "filler",
	error: "error",
	language: "language",
	noSessions: "no sessions yet",
}

export type LanguagePack = {
	code: string
	direction: Direction
	strings: Record<StringKey, string>
}

export const ENGLISH: LanguagePack = { code: "en", direction: "ltr", strings: EN }

let active: LanguagePack = ENGLISH

/** Every key a pack must carry. */
export function keys(): StringKey[] {
	return Object.keys(EN) as StringKey[]
}

export function activeLanguage(): LanguagePack {
	return active
}

export function setLanguage(pack: LanguagePack): void {
	active = pack
}

export function resetLanguage(): void {
	active = ENGLISH
}

/** Which pack the user asked for. English unless they said otherwise. */
export function resolveLangCode(env: Record<string, string | undefined> = process.env): string {
	const explicit = (env.ORACLE_LANG ?? "").trim().toLowerCase()
	if (explicit) return explicit
	const locale = (env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? "").trim().toLowerCase()
	if (!locale || locale === "c" || locale.startsWith("posix")) return "en"
	const code = locale.split(".")[0]!.split("_")[0]!
	return code || "en"
}

export function langPath(code: string): string {
	return join(home(), ".oracle", "lang", `${code}.json`)
}

export type PackReport = {
	code: string
	path: string
	loaded: boolean
	direction: Direction
	missing: StringKey[]
	ignored: string[]
	reason?: string
}

/**
 * Check a parsed pack without touching the filesystem.
 *
 * Missing keys are named and the pack is refused. Unknown keys are reported
 * and dropped: they are usually a typo in a key name, and silently ignoring
 * them is how a user ends up staring at an English word they thought they had
 * translated.
 */
export function validatePack(
	code: string,
	data: unknown,
): { pack: LanguagePack | null; missing: StringKey[]; ignored: string[]; reason?: string } {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return { pack: null, missing: keys(), ignored: [], reason: "pack is not a json object" }
	}
	const raw = data as Record<string, unknown>
	const dirValue = raw.direction
	if (dirValue !== undefined && dirValue !== "ltr" && dirValue !== "rtl") {
		return { pack: null, missing: [], ignored: [], reason: 'direction must be "ltr" or "rtl"' }
	}
	const source = (typeof raw.strings === "object" && raw.strings !== null ? raw.strings : raw) as Record<
		string,
		unknown
	>
	const strings = {} as Record<StringKey, string>
	const missing: StringKey[] = []
	for (const key of keys()) {
		const value = source[key]
		if (typeof value !== "string" || value.trim() === "") {
			missing.push(key)
			continue
		}
		strings[key] = value
	}
	const known = new Set<string>([...keys(), "direction", "strings", "code"])
	const ignored = Object.keys(source).filter((key) => !known.has(key))
	if (missing.length) return { pack: null, missing, ignored, reason: "pack is incomplete" }
	return { pack: { code, direction: (dirValue as Direction) ?? "ltr", strings }, missing, ignored }
}

/**
 * Load and activate a language pack. Anything short of a complete pack leaves
 * the interface in English and says why.
 */
export async function loadLanguage(code: string): Promise<PackReport> {
	const path = langPath(code)
	if (code === "en") {
		active = ENGLISH
		return { code, path, loaded: true, direction: "ltr", missing: [], ignored: [] }
	}
	if (!(await exists(path))) {
		active = ENGLISH
		return {
			code,
			path,
			loaded: false,
			direction: "ltr",
			missing: keys(),
			ignored: [],
			reason: "no pack at this path",
		}
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(await readText(path))
	} catch (error) {
		active = ENGLISH
		return {
			code,
			path,
			loaded: false,
			direction: "ltr",
			missing: [],
			ignored: [],
			reason: (error as Error).message,
		}
	}
	const result = validatePack(code, parsed)
	if (!result.pack) {
		active = ENGLISH
		return {
			code,
			path,
			loaded: false,
			direction: "ltr",
			missing: result.missing,
			ignored: result.ignored,
			...(result.reason ? { reason: result.reason } : {}),
		}
	}
	active = result.pack
	return {
		code,
		path,
		loaded: true,
		direction: result.pack.direction,
		missing: [],
		ignored: result.ignored,
	}
}

export function t(key: StringKey): string {
	return active.strings[key]
}

export function direction(): Direction {
	return active.direction
}

/**
 * Turn one logical line into what the terminal should actually print.
 *
 * Left-to-right packs pay nothing: the line is returned as it came. A
 * right-to-left pack gets Arabic shaping and a bidi reorder with the base
 * direction taken from the pack, not from whichever character happens to come
 * first, so an English tool name at the start of a line cannot flip the rest
 * of it.
 *
 * Note: shaping is not width preserving. A lam-alef pair collapses into one
 * ligature and the line needs one cell less. test/i18n.test.ts asserts this.
 */
export function visual(line: string): string {
	if (active.direction === "ltr" && !hasArabic(line)) return line
	const shaped = hasArabic(line) ? shapeArabic(line) : line
	if (active.direction === "ltr") return shaped
	return reorderLine(shaped, "rtl")
}
