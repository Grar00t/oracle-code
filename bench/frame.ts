// Frame cost harness.
//
// This prints raw measurements from the machine it runs on. It does not print a
// verdict, and no number from this file may be quoted without the machine, the
// terminal size and the Bun version it was produced with.
//
// It reports each stage separately on purpose. A total alone already misled
// this repo once: the diff went from 23636 scanned cells to 1 with no change in
// total frame time.

import { Terminal } from "../src/tui/terminal"
import { box, text } from "../src/tui/layout"
import type { FrameRecord } from "../src/tui/terminal"

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
	text(`message ${i}: the pipeline is packed cells, damage spans, cell diff, one write.`),
)

const steady: FrameRecord[] = []
const streaming: FrameRecord[] = []

// Phase 1: steady state — only the spinner changes.
for (let f = 0; f < FRAMES; f++) {
	const tree = box([
		box(lorem, { grow: true }),
		text(`${SPINNER[f % SPINNER.length]} thinking`),
	])
	const rec = term.draw(tree)
	if (f > 5) steady.push(rec)
}

// Phase 2: token streaming — a growing line at the bottom.
let buffer = ""
for (let f = 0; f < FRAMES; f++) {
	buffer += "token "
	if (buffer.length > 4000) buffer = ""
	const tree = box([box(lorem, { grow: true }), text(buffer)])
	const rec = term.draw(tree)
	if (f > 5) streaming.push(rec)
}

function quantile(samples: number[], q: number): number {
	const sorted = [...samples].sort((a, b) => a - b)
	const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length))
	return sorted[idx] ?? 0
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000
}

function stage(records: FrameRecord[], pick: (r: FrameRecord) => number) {
	const samples = records.map(pick)
	return { p50: round(quantile(samples, 0.5)), p95: round(quantile(samples, 0.95)) }
}

function phase(records: FrameRecord[]) {
	return {
		total_ms: {
			...stage(records, (r) => r.durationMs),
			max: round(Math.max(...records.map((r) => r.durationMs))),
		},
		blit_ms: stage(records, (r) => r.blitMs),
		paint_ms: stage(records, (r) => r.paintMs),
		diff_ms: stage(records, (r) => r.diffMs),
		write_ms: stage(records, (r) => r.writeMs),
		last_frame: records.at(-1),
	}
}

const report = {
	grid: `${COLS}x${ROWS}`,
	frames: FRAMES,
	bun: Bun.version,
	platform: `${process.platform}-${process.arch}`,
	sunkBytes,
	steady: phase(steady),
	streaming: phase(streaming),
}

console.log(JSON.stringify(report, null, 2))
