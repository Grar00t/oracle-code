// Frame cost harness.
//
// This prints raw measurements from the machine it runs on. It does not print a
// verdict, and no number from this file may be quoted without the machine, the
// terminal size and the Bun version it was produced with.

import { Terminal } from "../src/tui/terminal"
import { box, text } from "../src/tui/layout"

const COLS = Number(process.env.BENCH_COLS ?? 200)
const ROWS = Number(process.env.BENCH_ROWS ?? 120)
const FRAMES = Number(process.env.BENCH_FRAMES ?? 600)

// Write to a sink so the measurement excludes terminal I/O jitter.
let sunkBytes = 0
const term = new Terminal({
	cols: COLS,
	rows: ROWS,
	write: (chunk) => {
		sunkBytes += chunk.length
	},
})

const SPINNER = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"]

const lorem = Array.from({ length: 60 }, (_, i) =>
	text(`message ${i}: the pipeline is packed cells, damage rect, cell diff, one write.`),
)

const steady: number[] = []
const streaming: number[] = []

// Phase 1: steady state — only the spinner changes.
for (let f = 0; f < FRAMES; f++) {
	const tree = box([
		box(lorem, { grow: true }),
		text(`${SPINNER[f % SPINNER.length]} thinking`),
	])
	const rec = term.draw(tree)
	if (f > 5) steady.push(rec.durationMs)
}

// Phase 2: token streaming — a growing line at the bottom.
let buffer = ""
for (let f = 0; f < FRAMES; f++) {
	buffer += "token "
	if (buffer.length > 4000) buffer = ""
	const tree = box([box(lorem, { grow: true }), text(buffer)])
	const rec = term.draw(tree)
	if (f > 5) streaming.push(rec.durationMs)
}

function quantile(samples: number[], q: number): number {
	const sorted = [...samples].sort((a, b) => a - b)
	const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length))
	return sorted[idx] ?? 0
}

const report = {
	grid: `${COLS}x${ROWS}`,
	frames: FRAMES,
	bun: Bun.version,
	platform: `${process.platform}-${process.arch}`,
	sunkBytes,
	steady_ms: {
		p50: quantile(steady, 0.5),
		p95: quantile(steady, 0.95),
		max: Math.max(...steady),
	},
	streaming_ms: {
		p50: quantile(streaming, 0.5),
		p95: quantile(streaming, 0.95),
		max: Math.max(...streaming),
	},
	last_frame: term.telemetry().at(-1),
}

console.log(JSON.stringify(report, null, 2))
