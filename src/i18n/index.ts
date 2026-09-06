// Interface language. Two tables, one switch, no library.
//
// The point is not translation for its own sake. A terminal agent that draws
// Arabic wrong is worse than one that refuses to: unshaped letters and
// reversed digits look like corruption, and the user cannot tell whether the
// tool broke or the text did. So the language is explicit, the default is
// English, and every Arabic line goes through shaping and reordering before it
// touches the grid.
//
// Nothing here guesses. If ORACLE_LANG is set to something unsupported the
// interface stays English rather than half-translating.

import { hasArabic, shapeArabic } from "../text/arabic"
import { paragraphDirection, reorderLine, type Direction } from "../text/bidi"

export type Lang = "en" | "ar"

export const LANGS: readonly Lang[] = ["en", "ar"] as const

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
	footer: "enter send \u00b7 tab mode \u00b7 ^r receipts \u00b7 ^g gates \u00b7 ^z undo",
	startupHint: "type a task, /mode to cycle permissions, /lang to switch language, /undo to restore, /quit to exit",
	runtime: "runtime",
	endpointUnreachable: "endpoint unreachable",
	serving: "serving",
	permissionMode: "permission mode",
	restored: "restored",
	nothingToUndo: "nothing to undo",
	contextCompacted: "context compacted",
	error: "error",
	language: "language",
	noSessions: "no sessions yet",
}

const AR: Record<StringKey, string> = {
	ready: "جاهز.",
	working: "يعمل",
	undoHint: "اضغط esc مرتين للتراجع",
	ckpt: "نقاط",
	irreversible: "غير قابل للتراجع",
	cells: "خلية",
	prompt: "\u276f",
	askLabel: "اكتب",
	footer: "enter إرسال \u00b7 tab الوضع \u00b7 ^r السجل \u00b7 ^g البوابات \u00b7 ^z تراجع",
	startupHint: "اكتب المهمة، /mode لتغيير الصلاحيات، /lang لتغيير اللغة، /undo للتراجع، /quit للخروج",
	runtime: "المحرك",
	endpointUnreachable: "الخدمة غير متاحة",
	serving: "يشغّل",
	permissionMode: "وضع الصلاحيات",
	restored: "استُرجع",
	nothingToUndo: "لا شيء للتراجع عنه",
	contextCompacted: "تم ضغط السياق",
	error: "خطأ",
	language: "اللغة",
	noSessions: "لا توجد جلسات بعد",
}

const TABLES: Record<Lang, Record<StringKey, string>> = { en: EN, ar: AR }

/** Every key in the English table. Used by the test that keeps the tables equal. */
export function keys(): StringKey[] {
	return Object.keys(EN) as StringKey[]
}

/**
 * Which language the interface should use.
 *
 * ORACLE_LANG wins. After that a POSIX locale is read, so a machine already
 * set to Arabic gets an Arabic interface without extra configuration. Anything
 * unrecognised falls back to English instead of a partly translated screen.
 */
export function resolveLang(env: Record<string, string | undefined> = process.env): Lang {
	const explicit = (env.ORACLE_LANG ?? "").trim().toLowerCase()
	if (explicit) {
		if (explicit === "ar" || explicit.startsWith("ar-") || explicit.startsWith("ar_")) return "ar"
		return "en"
	}
	const locale = (env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? "").trim().toLowerCase()
	if (locale.startsWith("ar")) return "ar"
	return "en"
}

export function t(key: StringKey, lang: Lang): string {
	return TABLES[lang][key]
}

export function direction(lang: Lang): Direction {
	return lang === "ar" ? "rtl" : "ltr"
}

/** Cycle for the /lang command. */
export function nextLang(lang: Lang): Lang {
	const i = LANGS.indexOf(lang)
	return LANGS[(i + 1) % LANGS.length]!
}

/**
 * Turn one logical line into what the terminal should actually print.
 *
 * A terminal has no bidi engine and no shaper: it prints code points left to
 * right in the order it receives them. So Arabic has to arrive already shaped
 * and already reordered, and the base direction has to come from the interface
 * language rather than from the first strong character, otherwise a line that
 * starts with an English tool name flips the whole Arabic sentence after it.
 *
 * Lines with no Arabic are returned untouched: the common case costs one scan
 * and no allocation.
 */
export function visual(line: string, lang: Lang): string {
	if (!hasArabic(line)) return line
	return reorderLine(shapeArabic(line), direction(lang))
}

/** Base direction actually used for a line, for tests and for the doctor output. */
export function lineDirection(line: string, lang: Lang): Direction {
	if (!hasArabic(line)) return paragraphDirection(line)
	return direction(lang)
}
