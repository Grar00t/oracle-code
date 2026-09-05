// Chat view. Plain functions returning nodes — no component framework, no
// hooks, no reconciler. One call per frame builds the whole tree.

import { box, spacer, text, type Node } from "./tui/layout"
import type { Palette } from "./theme/theme"

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
			return text(`\u276f ${entry.text}`, {
				fg: palette.text,
				bg: palette.userMessageBackground,
			})
		case "assistant":
			return text(entry.text, { fg: palette.text })
		case "notice":
			return text(entry.text, { fg: palette.muted, italic: true })
		case "tool": {
			const mark = entry.ok ? "\u2713" : "\u2717"
			const lane = entry.parallel ? "\u2225" : "\u2192"
			return text(
				`${mark} ${lane} ${entry.name} ${entry.summary} (${entry.durationMs.toFixed(0)}ms)`,
				{ fg: entry.ok ? palette.success : palette.error },
			)
		}
	}
}

export function render(state: AppState, palette: Palette): Node {
	const history: Node[] = []
	for (const entry of state.entries.slice(-200)) history.push(entryNode(entry, palette))
	if (state.streaming) history.push(text(state.streaming, { fg: palette.accentShimmer }))

	const status = [
		`${state.mode}`,
		`${state.model}`,
		`ckpt ${state.checkpoints}`,
		state.irreversibleEffects > 0 ? `irreversible ${state.irreversibleEffects}` : "",
		`${state.lastFrameMs.toFixed(2)}ms / ${state.patchedCells} cells`,
	]
		.filter(Boolean)
		.join("  \u00b7  ")

	return box(
		[
			box(history.length ? history : [text("ready.", { fg: palette.muted })], { grow: true }),
			spacer(1),
			box(
				[
					text(
						state.busy
							? `${SPINNER[state.spinnerFrame % SPINNER.length]} working \u2014 esc esc to undo`
							: `\u276f ${state.input}\u2588`,
						{ fg: state.busy ? palette.accent : palette.text },
						{ wrap: false },
					),
				],
				{ border: true, borderStyle: { fg: palette.border }, height: 3, padding: 0 },
			),
			text(status, { fg: palette.muted }, { wrap: false }),
		],
		{ padding: 0 },
	)
}
