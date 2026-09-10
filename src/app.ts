// Chat view. Plain functions returning nodes - no component framework, no
// hooks, no reconciler. One call per frame builds the whole tree.
//
// Every string that reaches the grid passes through the interface language
// first: t() for the wording, visual() for shaping and reordering. Two
// exceptions, both deliberate: code inside a fence renders byte-exact with no
// shaping, and the composer renders the raw edit buffer so the cursor index
// stays a character index.

import { box, spacer, spans, text, type Node } from "./tui/layout"
import { splitBlocks, tokenizeLine, type Segment } from "./tui/highlight"
import type { Palette } from "./theme/theme"
import type { Style } from "./tui/pools"
import { t, visual } from "./i18n/index"

export type ChatEntry =
	| { role: "user"; text: string }
	| { role: "assistant"; text: string }
	| { role: "tool"; name: string; ok: boolean; summary: string; durationMs: number; parallel: boolean; preview?: string }
	| { role: "notice"; text: string }

export type AppState = {
	entries: ChatEntry[]
	streaming: string
	input: string
	cursor: number
	multiline: boolean
	/** Entries hidden below the viewport; 0 means pinned to the newest. */
	scroll: number
	mode: string
	model: string
	lang: string
	busy: boolean
	/** Permission question awaiting a y/n keypress, or null. */
	question: string | null
	spinnerFrame: number
	checkpoints: number
	irreversibleEffects: number
	fillerHits: number
	lastFrameMs: number
	patchedCells: number
}

const SPINNER = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"]

/** How many trailing entries the history view will consider. */
const HISTORY_WINDOW = 200

/** Tallest the composer input area may grow in multiline mode. */
const COMPOSER_MAX_LINES = 6

function tokenStyle(segment: Segment, palette: Palette): Style {
	switch (segment.token) {
		case "keyword":
			return { fg: palette.accent, bg: palette.codeBackground }
		case "string":
			return { fg: palette.success, bg: palette.codeBackground }
		case "comment":
			return { fg: palette.muted, italic: true, bg: palette.codeBackground }
		default:
			return { fg: palette.text, bg: palette.codeBackground }
	}
}

/** Assistant text: prose wraps and shapes; fenced code renders exact and highlighted. */
function assistantNodes(message: string, palette: Palette): Node[] {
	const nodes: Node[] = []
	for (const block of splitBlocks(message)) {
		if (block.kind === "text") {
			const prose = block.lines.join("\n")
			if (prose.trim()) nodes.push(text(visual(prose), { fg: palette.text }))
			continue
		}
		const fill: Style = { bg: palette.codeBackground }
		for (const line of block.lines) {
			nodes.push(
				spans(
					tokenizeLine(line).map((segment) => ({ text: segment.text, style: tokenStyle(segment, palette) })),
					fill,
				),
			)
		}
	}
	return nodes
}

function entryNodes(entry: ChatEntry, palette: Palette): Node[] {
	switch (entry.role) {
		case "user":
			return [
				text(visual(`${t("prompt")} ${entry.text}`), {
					fg: palette.text,
					bg: palette.userMessageBackground,
				}),
			]
		case "assistant":
			return assistantNodes(entry.text, palette)
		case "notice":
			return [text(visual(entry.text), { fg: palette.muted, italic: true })]
		case "tool": {
			const mark = entry.ok ? "\u2713" : "\u2717"
			// Two lanes, one glyph each: an overlapped call carries the double bar.
			const lane = entry.parallel ? "\u2225" : "\u2192"
			// An empty summary used to leave a double space mid-line.
			const summary = entry.summary ? ` ${entry.summary}` : ""
			const nodes: Node[] = [
				text(visual(`${mark} ${lane} ${entry.name}${summary} ${entry.durationMs.toFixed(0)}ms`), {
					fg: entry.ok ? palette.success : palette.error,
				}),
			]
			// The first lines of what the call produced, not just that it ran.
			if (entry.preview) {
				for (const line of entry.preview.split("\n").slice(0, 2)) {
					nodes.push(text(`  ${line}`, { fg: palette.muted }, { wrap: false }))
				}
			}
			return nodes
		}
	}
}

/**
 * The status line. One separator, and nothing that reads the same on every
 * frame: a counter that never moves is decoration, not information, so the
 * irreversible count, the cell count, the filler count and the scroll depth
 * appear only once they are non-zero, and the language code appears only when
 * a pack replaced English.
 */
function statusLine(state: AppState): string {
	const parts = [state.mode, state.model, `${t("ckpt")} ${state.checkpoints}`]
	if (state.irreversibleEffects > 0) parts.push(`${t("irreversible")} ${state.irreversibleEffects}`)
	if (state.fillerHits > 0) parts.push(`${t("filler")} ${state.fillerHits}`)
	if (state.scroll > 0) parts.push(`\u2191${state.scroll}`)
	parts.push(`${state.lastFrameMs.toFixed(2)}ms`)
	if (state.patchedCells > 0) parts.push(`${state.patchedCells} ${t("cells")}`)
	if (state.lang !== "en") parts.push(state.lang)
	return parts.join("  \u00b7  ")
}

/**
 * Composer as styled runs with an inverse cell at the cursor. The buffer is
 * rendered raw — shaping would break the character-index-to-cell mapping the
 * cursor depends on.
 */
function composerLines(state: AppState, palette: Palette): Node[] {
	const base: Style = { fg: palette.text }
	const cursorStyle: Style = { fg: palette.text, inverse: true }
	const lines = state.input.split("\n")
	// Locate the cursor's line and column in the buffer.
	let column = state.cursor
	let cursorLine = 0
	for (let i = 0; i < lines.length; i++) {
		if (column <= lines[i]!.length) {
			cursorLine = i
			break
		}
		column -= lines[i]!.length + 1
		cursorLine = i + 1
	}
	const prefix = state.multiline ? "\u2502 " : `${t("prompt")} `
	// Keep the cursor's line visible: show the window of lines ending at it,
	// or the first lines when the cursor sits above the fold.
	const start = Math.max(0, cursorLine - COMPOSER_MAX_LINES + 1)
	const visible = lines.slice(start, start + COMPOSER_MAX_LINES)
	const nodes: Node[] = []
	visible.forEach((line, index) => {
		const absolute = start + index
		if (absolute === cursorLine) {
			const before = line.slice(0, column)
			const at = line.slice(column, column + 1) || " "
			const after = line.slice(column + 1)
			nodes.push(
				spans([
					{ text: prefix, style: { fg: palette.accent } },
					{ text: before, style: base },
					{ text: at, style: cursorStyle },
					{ text: after, style: base },
				]),
			)
		} else {
			nodes.push(spans([{ text: prefix, style: { fg: palette.accent } }, { text: line, style: base }]))
		}
	})
	return nodes
}

export function render(state: AppState, palette: Palette): Node {
	const history: Node[] = []
	// Scrollback: `scroll` newest entries are held below the viewport.
	const upper = Math.max(0, state.entries.length - state.scroll)
	const window = state.entries.slice(Math.max(0, upper - HISTORY_WINDOW), upper)
	for (const entry of window) history.push(...entryNodes(entry, palette))
	if (state.scroll === 0 && state.streaming) {
		history.push(...assistantNodes(state.streaming, { ...palette, text: palette.accentShimmer }))
	}

	let composer: Node[]
	if (state.question) {
		composer = [text(visual(`${state.question} [y/N]`), { fg: palette.warning }, { wrap: false })]
	} else if (state.busy) {
		composer = [
			text(
				visual(`${SPINNER[state.spinnerFrame % SPINNER.length]} ${t("working")} \u2014 ${t("undoHint")}`),
				{ fg: palette.accent },
				{ wrap: false },
			),
		]
	} else {
		composer = composerLines(state, palette)
	}

	return box(
		[
			box(history.length ? history : [text(visual(t("ready")), { fg: palette.muted })], { grow: true }),
			spacer(1),
			box(composer, {
				border: true,
				borderStyle: { fg: palette.border },
				height: Math.min(COMPOSER_MAX_LINES, Math.max(1, composer.length)) + 2,
				padding: 0,
			}),
			text(visual(statusLine(state)), { fg: palette.muted }, { wrap: false }),
		],
		{ padding: 0 },
	)
}
