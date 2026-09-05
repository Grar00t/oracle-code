// Themes.
//
// FACT (reference tool): six built-in themes plus auto-detection from
// $COLORFGBG (format "foreground;background"; background 0-6 or 8 means dark,
// 7 or 9-15 means light), user themes as JSON with optional name, base and
// overrides, values accepted as #rrggbb, #rgb, rgb(r,g,b), ansi256(n) or
// ansi:<name>, unknown keys and invalid values ignored silently so a typo can
// never break rendering.
//
// Addition: parse results are returned instead of discarded, so `oc theme
// --lint` can tell the user which keys were ignored. Silent at render time,
// loud on request.

export type ThemeName = "dark" | "light" | "darkDaltonized" | "lightDaltonized" | "darkAnsi" | "lightAnsi"

export type Palette = {
	accent: string
	accentShimmer: string
	text: string
	muted: string
	success: string
	warning: string
	error: string
	planMode: string
	diffAdded: string
	diffRemoved: string
	userMessageBackground: string
	border: string
	/** Distinct colours for parallel sub-agent output. */
	subagents: string[]
	/** Seven stops used for gradient emphasis. */
	rainbow: string[]
}

const DARK: Palette = {
	accent: "#7c9cf5",
	accentShimmer: "#aebff9",
	text: "#e6e6e6",
	muted: "#8a8a8a",
	success: "#4ade80",
	warning: "#fbbf24",
	error: "#f87171",
	planMode: "#38bdf8",
	diffAdded: "#14532d",
	diffRemoved: "#7f1d1d",
	userMessageBackground: "#1e1b4b",
	border: "#3f3f46",
	subagents: ["#f472b6", "#facc15", "#4ade80", "#38bdf8", "#a78bfa", "#fb923c", "#2dd4bf", "#e879f9"],
	rainbow: ["#f87171", "#fb923c", "#facc15", "#4ade80", "#38bdf8", "#818cf8", "#c084fc"],
}

const LIGHT: Palette = {
	...DARK,
	accent: "#3b5bdb",
	accentShimmer: "#5c7cfa",
	text: "#1f2933",
	muted: "#6b7280",
	diffAdded: "#dcfce7",
	diffRemoved: "#fee2e2",
	userMessageBackground: "#eef2ff",
	border: "#d4d4d8",
}

const ANSI_DARK: Palette = {
	...DARK,
	accent: "ansi256(75)",
	accentShimmer: "ansi256(117)",
	text: "ansi256(252)",
	muted: "ansi256(244)",
	success: "ansi256(78)",
	warning: "ansi256(214)",
	error: "ansi256(203)",
	border: "ansi256(240)",
}

export const BUILT_IN: Record<ThemeName, Palette> = {
	dark: DARK,
	light: LIGHT,
	// Daltonized variants avoid red/green as the only signal.
	darkDaltonized: { ...DARK, success: "#38bdf8", error: "#f59e0b" },
	lightDaltonized: { ...LIGHT, success: "#0284c7", error: "#b45309" },
	darkAnsi: ANSI_DARK,
	lightAnsi: { ...LIGHT, accent: "ansi256(27)", text: "ansi256(235)", muted: "ansi256(242)" },
}

/** Detect light or dark from $COLORFGBG, which iTerm2 and Konsole set. */
export function detectBackground(env = process.env): "dark" | "light" {
	const raw = env.COLORFGBG
	if (!raw) return "dark"
	const parts = raw.split(";")
	const bg = Number(parts[parts.length - 1])
	if (!Number.isFinite(bg)) return "dark"
	if (bg === 7 || (bg >= 9 && bg <= 15)) return "light"
	return "dark"
}

const COLOR_RE = /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|ansi256\(\d{1,3}\)|ansi:[a-zA-Z]+)$/

export type UserTheme = { name?: string; base?: ThemeName; overrides?: Record<string, unknown> }

export type ResolvedTheme = {
	name: string
	palette: Palette
	/** Keys that were dropped, and why. Empty on a clean file. */
	ignored: Array<{ key: string; reason: "unknown key" | "invalid value" }>
}

export function resolveTheme(user: UserTheme | null, fallback?: ThemeName): ResolvedTheme {
	const baseName: ThemeName = user?.base ?? fallback ?? (detectBackground() === "light" ? "light" : "dark")
	const base = BUILT_IN[baseName] ?? DARK
	const palette: Palette = { ...base, subagents: [...base.subagents], rainbow: [...base.rainbow] }
	const ignored: ResolvedTheme["ignored"] = []

	for (const [key, value] of Object.entries(user?.overrides ?? {})) {
		if (!(key in palette) || key === "subagents" || key === "rainbow") {
			ignored.push({ key, reason: "unknown key" })
			continue
		}
		if (typeof value !== "string" || !COLOR_RE.test(value)) {
			ignored.push({ key, reason: "invalid value" })
			continue
		}
		;(palette as any)[key] = value
	}

	return { name: user?.name ?? baseName, palette, ignored }
}

/** Load a user theme file. A missing or malformed file is not an error. */
export async function loadUserTheme(path: string): Promise<UserTheme | null> {
	try {
		return JSON.parse(await Bun.file(path).text()) as UserTheme
	} catch {
		return null
	}
}
