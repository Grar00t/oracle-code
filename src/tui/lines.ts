// Line pipeline cache.
//
// MEASURED on the authoritative machine (200x120, 600 frames, bun 1.4.2,
// linux-x64), stage timers at 3ed3e74:
//
//   total p50 2.254 ms | blit 0.011 | paint 2.239 | diff 0.001 | write 0.000
//
// Four renderer fixes before this one reduced the diff from 23636 cells read
// to 1, and none of them moved the frame time. That was the answer, not a
// disappointment: the cell comparison was never the cost. Paint was, and paint
// was recomputing results it already had.
//
// What paint repeated every frame, for content that had not changed:
//   - wrapText twice per text node (once to measure height, once to draw)
//   - a full prefix re-measure for every word inside wrapText (quadratic)
//   - shaping, bidi reordering and clustering of identical text
//   - a Map lookup per cluster to intern a character already interned
//
// This module removes all four by keying on content. It changes no output
// byte: the ids it hands back are the same ids the uncached path would write.

import { layoutLine, type Direction } from "../text"
import { clusters, codePointWidth, stringWidth } from "../text/width"
import { CHAR_EMPTY, type CharPool } from "./pools"

/**
 * Interned cell ids for one visual line. Wide clusters already carry their
 * empty continuation cell, so ids.length is exactly the cells occupied.
 */
export type ShapedLine = {
	ids: Int32Array
	width: number
	direction: Direction
}

// A terminal session sees a bounded set of distinct lines, but streaming text
// produces a new string every frame, so the caches must be bounded. Maps keep
// insertion order, which makes the oldest keys the cheapest to drop.
const MAX_ENTRIES = 2048
const EVICT_BATCH = 512

function bound<V>(map: Map<string, V>): void {
	if (map.size <= MAX_ENTRIES) return
	let removed = 0
	for (const key of map.keys()) {
		map.delete(key)
		if (++removed >= EVICT_BATCH) break
	}
}

/**
 * Greedy word wrap on logical text. Shaping and reordering happen per line.
 *
 * stringWidth is a sum over code points, so widths add on concatenation. The
 * running width is therefore exact, and wrapping is linear instead of
 * re-measuring the whole prefix once per word.
 */
export function wrapText(text: string, width: number): string[] {
	if (width <= 0) return []
	const out: string[] = []
	for (const paragraph of text.split("\n")) {
		if (paragraph === "") {
			out.push("")
			continue
		}
		let line = ""
		let lineWidth = 0
		for (const word of paragraph.split(/(\s+)/)) {
			if (word === "") continue
			const wordWidth = stringWidth(word)
			if (lineWidth + wordWidth <= width) {
				line += word
				lineWidth += wordWidth
				continue
			}
			if (line.trim() !== "") out.push(line.trimEnd())
			if (wordWidth <= width) {
				line = word.trimStart()
				lineWidth = stringWidth(line)
				continue
			}
			// Hard break for a single oversized token.
			let chunk = ""
			let chunkWidth = 0
			for (const ch of word) {
				const w = codePointWidth(ch.codePointAt(0)!)
				if (chunkWidth + w > width) {
					out.push(chunk)
					chunk = ""
					chunkWidth = 0
				}
				chunk += ch
				chunkWidth += w
			}
			line = chunk
			lineWidth = chunkWidth
		}
		out.push(line.trimEnd())
	}
	return out
}

const wraps = new Map<string, readonly string[]>()
let wrapHits = 0
let wrapMisses = 0

/**
 * Wrapping keyed by width and text. Height measurement and painting ask the
 * same question about the same node in the same frame; the second ask is free.
 */
export function wrapCached(text: string, width: number): readonly string[] {
	const key = `${width}\u0000${text}`
	const hit = wraps.get(key)
	if (hit) {
		wrapHits++
		return hit
	}
	wrapMisses++
	const lines = wrapText(text, width)
	wraps.set(key, lines)
	bound(wraps)
	return lines
}

export function wrapCacheStats(): { hits: number; misses: number; size: number } {
	return { hits: wrapHits, misses: wrapMisses, size: wraps.size }
}

/** Tests need a clean slate; a process does not. */
export function clearWrapCache(): void {
	wraps.clear()
	wrapHits = 0
	wrapMisses = 0
}

/**
 * Shaped and interned lines, keyed by content. Pool ids are stable for the
 * life of the process and pools never shrink, so cached ids stay valid across
 * frames, across blits and across eviction.
 */
export class LineCache {
	private readonly shapes = new Map<string, ShapedLine>()
	private readonly runs = new Map<string, Int32Array>()
	hits = 0
	misses = 0

	constructor(private readonly chars: CharPool) {}

	/** Shape, reorder, cluster and intern one logical line. */
	shape(text: string, direction?: Direction): ShapedLine {
		const key = direction ? `${direction}\u0000${text}` : `\u0000${text}`
		const hit = this.shapes.get(key)
		if (hit) {
			this.hits++
			return hit
		}
		this.misses++
		const laid = layoutLine(text, direction)
		const packed = this.pack(laid.clusters)
		const record: ShapedLine = {
			ids: packed.ids,
			width: packed.width,
			direction: laid.direction,
		}
		this.shapes.set(key, record)
		bound(this.shapes)
		return record
	}

	/**
	 * Intern already-visual text with no shaping and no reordering, for runs the
	 * renderer builds itself such as box borders.
	 */
	run(text: string): Int32Array {
		const hit = this.runs.get(text)
		if (hit) {
			this.hits++
			return hit
		}
		this.misses++
		const ids = this.pack(clusters(text)).ids
		this.runs.set(text, ids)
		bound(this.runs)
		return ids
	}

	/**
	 * Clusters to cells: wide clusters take two, everything else takes one.
	 *
	 * A cluster whose leading code point is zero-width owns no cell of its own.
	 * Discarding it loses the character outright, which is what a line beginning
	 * with a haraka used to do. It is held and merged into the next cluster that
	 * does own a cell, or shown over a space if the run ends without one.
	 */
	private pack(cells: readonly string[]): { ids: Int32Array; width: number } {
		const scratch = new Int32Array(cells.length * 2 + 2)
		let n = 0
		let pending = ""
		for (const cluster of cells) {
			if (cluster === "") continue
			const w = codePointWidth(cluster.codePointAt(0)!)
			if (w === 0) {
				pending += cluster
				continue
			}
			scratch[n++] = this.chars.intern(pending ? pending + cluster : cluster)
			pending = ""
			if (w === 2) scratch[n++] = CHAR_EMPTY
		}
		if (pending) scratch[n++] = this.chars.intern(` ${pending}`)
		return { ids: n === scratch.length ? scratch : scratch.slice(0, n), width: n }
	}
}
