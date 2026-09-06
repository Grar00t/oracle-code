import { layoutLine } from "../text"
import { codePointWidth } from "../text/width"
import type { Direction } from "../text/bidi"
import {
	CHAR_EMPTY,
	CHAR_SPACE,
	LINK_NONE,
	Pools,
	STYLE_DEFAULT,
	StylePool,
	type Style,
} from "./pools"
import { BSU, ESU, LINK_END, RESET, link, moveTo } from "./ansi"

export type Rect = { top: number; left: number; bottom: number; right: number }

export type FrameStats = {
	/** Cells actually inspected by the diff. */
	scanned: number
	/** Cells that differed and were patched. */
	patched: number
	/** Bytes handed to stdout, including BSU/ESU. */
	bytes: number
	/** Bounding box of all patched cells, or null when the frame was a no-op. */
	damage: Rect | null
	/** Rows that carried at least one real difference. */
	damagedRows: number
	/** Rows written this frame whose content ended up identical, skipped for free. */
	rowsSkipped: number
}

type Buffer = {
	chars: Int32Array
	styles: Int32Array
	links: Int32Array
}

function allocate(cells: number): Buffer {
	return {
		chars: new Int32Array(cells).fill(CHAR_SPACE),
		styles: new Int32Array(cells),
		links: new Int32Array(cells),
	}
}

/**
 * Packed cell store with two frames, per-row damage spans and per-row exact
 * difference counters.
 *
 * Pipeline per frame:
 *   beginFrame() -> blit  (typed-array copy of the previous frame)
 *   put()/fill() -> paint (packed int writes; each write keeps its row's count
 *                          of cells that differ from the visible frame)
 *   render()     -> diff + optimize + one synchronized write
 *   commit()     -> swap front/back
 *
 * MEASURED on the authoritative machine (200x120, 600 frames, bun 1.4.2,
 * linux-x64), each step forced by the previous measurement:
 *   one bounding rectangle   scanned 23636 to patch 5
 *   per-row spans            scanned  8127 to patch 5
 *   steady frame with spans  scanned  4560 to patch 1, over 61 damagedRows
 *
 * The 4560 was not a real difference. A widget tree blanks its box and repaints
 * the same text every frame; the blank differs from the visible frame and the
 * repaint restores it. Spans can only widen, so they kept the width of a change
 * that no longer existed. Counters can go back down, which is why the count is
 * authoritative here and the span is only a bound on where to look.
 *
 * Nothing here allocates per cell, and the interning pools are shared by both
 * frames so ids stay valid across the blit.
 */
export class Screen {
	readonly pools = new Pools()
	cols: number
	rows: number
	private front: Buffer
	private back: Buffer
	/** Inclusive row range that carries damage; dTop < 0 means none. */
	private dTop = -1
	private dBottom = -1
	/** Per row column span. rowMax < rowMin means nothing was touched. */
	private rowMin: Int32Array
	private rowMax: Int32Array
	/** Exact count per row of cells differing from the visible frame. */
	private rowDiff: Int32Array
	/** Rows touched this frame, so clearing costs one pass over them only. */
	private dirtyRows: Int32Array
	private dirtyCount = 0
	private pendingDiffs = 0
	lastStats: FrameStats = {
		scanned: 0,
		patched: 0,
		bytes: 0,
		damage: null,
		damagedRows: 0,
		rowsSkipped: 0,
	}

	constructor(cols: number, rows: number) {
		this.cols = Math.max(1, cols)
		this.rows = Math.max(1, rows)
		const cells = this.cols * this.rows
		this.front = allocate(cells)
		this.back = allocate(cells)
		this.rowMin = new Int32Array(this.rows).fill(this.cols)
		this.rowMax = new Int32Array(this.rows).fill(-1)
		this.rowDiff = new Int32Array(this.rows)
		this.dirtyRows = new Int32Array(this.rows)
	}

	/** Resize invalidates both frames; the next render repaints everything. */
	resize(cols: number, rows: number): void {
		this.cols = Math.max(1, cols)
		this.rows = Math.max(1, rows)
		const cells = this.cols * this.rows
		this.front = allocate(cells)
		// Force a full repaint by making the front frame impossible to match.
		this.front.chars.fill(-1)
		this.back = allocate(cells)
		this.rowMin = new Int32Array(this.rows).fill(this.cols)
		this.rowMax = new Int32Array(this.rows).fill(-1)
		this.rowDiff = new Int32Array(this.rows)
		this.dirtyRows = new Int32Array(this.rows)
		this.dirtyCount = 0
		this.pendingDiffs = 0
		this.dTop = -1
		this.dBottom = -1
	}

	beginFrame(): void {
		// Blit: bulk word copy, not a per-cell loop. Untouched regions are then
		// already identical to the front frame and diff for free.
		this.back.chars.set(this.front.chars)
		this.back.styles.set(this.front.styles)
		this.back.links.set(this.front.links)
		// Clear exactly the rows that were touched, not a range containing them.
		for (let i = 0; i < this.dirtyCount; i++) {
			const y = this.dirtyRows[i]!
			this.rowMin[y] = this.cols
			this.rowMax[y] = -1
			this.rowDiff[y] = 0
		}
		this.dirtyCount = 0
		this.pendingDiffs = 0
		this.dTop = -1
		this.dBottom = -1
	}

	private touch(x: number, y: number): void {
		if (this.rowMax[y]! < this.rowMin[y]!) {
			this.dirtyRows[this.dirtyCount++] = y
			this.rowMin[y] = x
			this.rowMax[y] = x
		} else {
			if (x < this.rowMin[y]!) this.rowMin[y] = x
			if (x > this.rowMax[y]!) this.rowMax[y] = x
		}
		if (this.dTop < 0) {
			this.dTop = y
			this.dBottom = y
			return
		}
		if (y < this.dTop) this.dTop = y
		if (y > this.dBottom) this.dBottom = y
	}

	private write(
		x: number,
		y: number,
		charId: number,
		styleId: number,
		linkId: number,
	): void {
		if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return
		const i = y * this.cols + x
		// Bit 0 of the style id says whether the style shows on a blank cell.
		// Invisible-on-space styles collapse to the default id, which makes blits
		// and diffs hit far more often.
		const effective =
			charId === CHAR_SPACE && !StylePool.visibleOnSpace(styleId)
				? STYLE_DEFAULT
				: styleId

		const frontChar = this.front.chars[i]!
		const frontStyle = this.front.styles[i]!
		const frontLink = this.front.links[i]!
		const wasDiff =
			this.back.chars[i] !== frontChar ||
			this.back.styles[i] !== frontStyle ||
			this.back.links[i] !== frontLink

		this.back.chars[i] = charId
		this.back.styles[i] = effective
		this.back.links[i] = linkId

		const isDiff = charId !== frontChar || effective !== frontStyle || linkId !== frontLink
		if (isDiff !== wasDiff) {
			const delta = isDiff ? 1 : -1
			this.rowDiff[y] = this.rowDiff[y]! + delta
			this.pendingDiffs += delta
		}
		// The span only bounds where to look. A reverted write leaves the span
		// wide but the row's counter back at zero, and a zero row is never read.
		if (isDiff) this.touch(x, y)
	}

	fill(rect: Rect, style: Style = {}): void {
		const styleId = this.pools.styles.intern(style)
		for (let y = Math.max(0, rect.top); y <= Math.min(this.rows - 1, rect.bottom); y++) {
			for (let x = Math.max(0, rect.left); x <= Math.min(this.cols - 1, rect.right); x++) {
				this.write(x, y, CHAR_SPACE, styleId, LINK_NONE)
			}
		}
	}

	/**
	 * Draw already-visual clusters starting at (x, y). Wide clusters occupy two
	 * cells: the glyph plus an empty continuation cell, so the grid never drifts.
	 */
	putClusters(
		x: number,
		y: number,
		cells: readonly string[],
		style: Style = {},
		url = "",
	): number {
		const styleId = this.pools.styles.intern(style)
		const linkId = this.pools.links.intern(url)
		let cursor = x
		for (const cluster of cells) {
			if (cursor >= this.cols) break
			const width = codePointWidth(cluster.codePointAt(0)!)
			if (width === 0) continue
			this.write(cursor, y, this.pools.chars.intern(cluster), styleId, linkId)
			cursor += 1
			if (width === 2) {
				this.write(cursor, y, CHAR_EMPTY, styleId, linkId)
				cursor += 1
			}
		}
		return cursor - x
	}

	/** Shape, reorder and draw one logical line of text. */
	putText(
		x: number,
		y: number,
		text: string,
		style: Style = {},
		opts: { url?: string; direction?: Direction } = {},
	): number {
		const laid = layoutLine(text, opts.direction)
		return this.putClusters(x, y, laid.clusters, style, opts.url ?? "")
	}

	/** Diff the rows that really changed, merge patches, and serialize one write. */
	render(): string {
		if (this.dTop < 0 || this.pendingDiffs === 0) {
			const rowsSkipped = this.dTop < 0 ? 0 : this.dirtyCount
			this.lastStats = {
				scanned: 0,
				patched: 0,
				bytes: 0,
				damage: null,
				damagedRows: 0,
				rowsSkipped,
			}
			return ""
		}

		// Merging tolerance: repositioning the cursor costs about this many bytes,
		// so shorter identical gaps are cheaper to redraw than to skip.
		const GAP_TOLERANCE = 6

		let out = ""
		let scanned = 0
		let patched = 0
		let damagedRows = 0
		let rowsSkipped = 0
		let activeStyle = -1
		let activeLink = LINK_NONE
		let boundLeft = this.cols
		let boundRight = -1
		let boundTop = -1
		let boundBottom = -1

		for (let y = this.dTop; y <= this.dBottom; y++) {
			const target = this.rowDiff[y]!
			const spanLeft = this.rowMin[y]!
			const spanRight = this.rowMax[y]!
			if (spanRight < spanLeft) continue
			// Written, then written back to what is already on screen: free.
			if (target === 0) {
				rowsSkipped++
				continue
			}
			damagedRows++
			if (boundTop < 0) boundTop = y
			boundBottom = y

			const rowBase = y * this.cols
			let found = 0
			let x = spanLeft
			while (x <= spanRight && found < target) {
				const i = rowBase + x
				scanned++
				if (
					this.back.chars[i] === this.front.chars[i] &&
					this.back.styles[i] === this.front.styles[i] &&
					this.back.links[i] === this.front.links[i]
				) {
					x++
					continue
				}

				// Extend the run, absorbing short identical gaps (optimize stage).
				let end = x
				let gap = 0
				let runDiffs = 0
				for (let probe = x; probe <= spanRight; probe++) {
					const j = rowBase + probe
					const same =
						this.back.chars[j] === this.front.chars[j] &&
						this.back.styles[j] === this.front.styles[j] &&
						this.back.links[j] === this.front.links[j]
					if (same) {
						gap++
						if (gap > GAP_TOLERANCE) break
					} else {
						gap = 0
						end = probe
						runDiffs++
						if (runDiffs === target - found) break
					}
				}
				found += runDiffs

				if (x < boundLeft) boundLeft = x
				if (end > boundRight) boundRight = end

				out += moveTo(y, x)
				for (let k = x; k <= end; k++) {
					const j = rowBase + k
					const styleId = this.back.styles[j]!
					const linkId = this.back.links[j]!
					if (styleId !== activeStyle) {
						out += RESET + this.pools.styles.sgr(styleId)
						activeStyle = styleId
					}
					if (linkId !== activeLink) {
						out += linkId === LINK_NONE ? LINK_END : link(this.pools.links.resolve(linkId))
						activeLink = linkId
					}
					const charId = this.back.chars[j]!
					out += charId === CHAR_EMPTY ? "" : this.pools.chars.resolve(charId)
					patched++
				}
				x = end + 1
			}
		}

		if (activeLink !== LINK_NONE) out += LINK_END
		if (out) out = BSU + out + RESET + ESU

		const damage: Rect | null =
			boundTop < 0
				? null
				: { top: boundTop, left: boundLeft, bottom: boundBottom, right: boundRight }

		this.lastStats = { scanned, patched, bytes: out.length, damage, damagedRows, rowsSkipped }
		return out
	}

	/** Promote the drawn frame to the visible one. */
	commit(): void {
		const tmp = this.front
		this.front = this.back
		this.back = tmp
	}

	/** Visible text of a row, for tests and snapshots. */
	rowText(y: number): string {
		let out = ""
		const base = y * this.cols
		for (let x = 0; x < this.cols; x++) {
			out += this.pools.chars.resolve(this.front.chars[base + x]!)
		}
		return out
	}

	/** Row of the frame currently being painted. */
	pendingRowText(y: number): string {
		let out = ""
		const base = y * this.cols
		for (let x = 0; x < this.cols; x++) {
			out += this.pools.chars.resolve(this.back.chars[base + x]!)
		}
		return out
	}
}
