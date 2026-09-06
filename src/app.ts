// Chat view. Plain functions returning nodes - no component framework, no
// hooks, no reconciler. One call per frame builds the whole tree.
//
// Every string that reaches the grid passes through the interface language
// first: t() for the wording, visual() for shaping and reordering.

import { box, spacer, text, type Node } from "./tui/layout"
import type { Palette } from "./theme/theme"
import { t, visual } from "./i18n/index"

export type ChatEntry =
	| { role: "user"; text: string }
	| { role: "assistant"; text: string }
	| { role: "tool"; name: string; ok: boolean; summary: string; durationMs: number; parallel: boolean }
	| { role: "notice"; text: string }

export type AppState = {
	entries: ChatEntry[]
	streaming: string
	input: string
	mode: string
	model: string
	lang: string
	busy: boolean
	spinnerFrame: number
	checkpoints: number
	irreversibleEffects: number
	lastFrameMs: number
	patchedCells: number
}

const SPINNER = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"]

function entryNode(entry: ChatEntry, palette: Palette): Node {
	switch (entry.role) {
		case "user":
			return text(visual(`${t("prompt")} ${entry.text}`), {
				fg: palette.text,
				bg: palette.userMessageBackground,
			})
		case "assistant":
			return text(visual(entry.text), { fg: palette.text })
		case "notice":
			return text(visual(entry.text), { fg: palette.muted, italic: true })
		case "tool": {
			const mark = entry.ok ? "\u2713" : "\u2717"
			// Two lanes, one glyph each: an overlapped call carries the double bar.
			const lane = entry.parallel ? "\u2225" : "\u2192"
			// An empty summary used to leave a double space mid-line.
			const summary = entry.summary ? ` ${entry.summary}` : ""
			return text(visual(`${mark} ${lane} ${entry.name}${summary} ${entry.durationMs.toFixed(0)}ms`), {
				fg: entry.ok ? palette.success : palette.error,
			})
		}
	}
}

/**
 * The status line. One separator, and nothing that reads the same on every
 * frame: a counter that never moves is decoration, not information, so the
 * irreversible count and the cell count appear only once they are non-zero,
 * and the language code appears only when a pack replaced English.
 */
function statusLine(state: AppState): string {
	const parts = [state.mode, state.model, `${t("ckpt")} ${state.checkpoints}`]
	if (state.irreversibleEffects > 0) parts.push(`${t("irreversible")} ${state.irreversibleEffects}`)
	parts.push(`${state.lastFrameMs.toFixed(2)}ms`)
	if (state.patchedCells > 0) parts.push(`${state.patchedCells} ${t("cells")}`)
	if (state.lang !== "en") parts.push(state.lang)
	return parts.join("  \u00b7  ")
}

export function render(state: AppState, palette: Palette): Node {
	const history: Node[] = []
	for (const entry of state.entries.slice(-200)) history.push(entryNode(entry, palette))
	if (state.streaming) history.push(text(visual(state.streaming), { fg: palette.accentShimmer }))

	const composer = state.busy
		? `${SPINNER[state.spinnerFrame % SPINNER.length]} ${t("working")} \u2014 ${t("undoHint")}`
		: `${t("prompt")} ${state.input}\u2588`

	return box(
		[
			box(history.length ? history : [text(visual(t("ready")), { fg: palette.muted })], { grow: true }),
			spacer(1),
			box([text(visual(composer), { fg: state.busy ? palette.accent : palette.text }, { wrap: false })], {
				border: true,
				borderStyle: { fg: palette.border },
				height: 3,
				padding: 0,
			}),
			text(visual(statusLine(state)), { fg: palette.muted }, { wrap: false }),
		],
		{ padding: 0 },
	)
}
