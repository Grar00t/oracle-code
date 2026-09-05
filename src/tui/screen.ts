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
	/** Cells inside the damage rectangle that were scanned. */
	scanned: number
	/** Cells that actually differed and were patched. */
	patched: number
	/** Bytes handed to stdout, including BSU/ESU. */
	bytes: number
	/** Damage rectangle, or null when the frame was a no-op. */
	damage: Rect | null
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
 * Packed cell store with two frames and a damage rectangle.
 *
 * Pipeline per frame:
 *   beginFrame() -> blit  (typed-array copy of the previous frame)
 *   put()/fill() -> paint (writes packed ints, expands the damage rectangle
 *                          only when a value genuinely changed)
 *   render()     -> diff + optimize + one synchronized write
 *   commit()     -> swap front/back
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
	private dTop = -1
	private dLeft = -1
	private dBottom = -1
	private dRight = -1
	lastStats: FrameStats = { scanned: 0, patched: 0, bytes: 0, damage: null }

	constructor(cols: number, rows: number) {
		this.cols = Math.max(1, cols)
		this.rows = Math.max(1, rows)
		const cells = this.cols * this.rows
		this.front = allocate(cells)
		this.back = allocate(cells)
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
		this.dTop = 0
		this.dLeft = 0
		this.dBottom = this.rows - 1
		this.dRight = this.cols - 1
	}

	beginFrame(): void {
		// Blit: bulk word copy, not a per-cell loop. Untouched regions are then
		// already identical to the front frame and diff for free.
		this.back.chars.set(this.front.chars)
		this.back.styles.set(this.front.styles)
		this.back.links.set(this.front.links)
		this.dTop = -1
		this.dLeft = -1
		this.dBottom = -1
		this.dRight = -1
	}

	private touch(x: number, y: number): void {
		if (this.dTop < 0) {
			this.dTop = y
			this.dBottom = y
			this.dLeft = x
			this.dRight = x
			return
		}
		if (y < this.dTop) this.dTop = y
		if (y > this.dBottom) this.dBottom = y
		if (x < this.dLeft) this.dLeft = x
		if (x > this.dRight) this.dRight = x
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
		const changed =
			this.back.chars[i] !== charId ||
			this.back.styles[i] !== effective ||
			this.back.links[i] !== linkId
		this.back.chars[i] = charId
		this.back.styles[i] = effective
		this.back.links[i] = linkId
		if (
			changed ||
			this.front.chars[i] !== charId ||
			this.front.styles[i] !== effective ||
			this.front.links[i] !== linkId
		)
			this.touch(x, y)
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

	/** Diff the damage rectangle, merge patches, and serialize one write. */
	render(): string {
		if (this.dTop < 0) {
			this.lastStats = { scanned: 0, patched: 0, bytes: 0, damage: null }
			return ""
		}

		const damage: Rect = {
			top: this.dTop,
			left: this.dLeft,
			bottom: this.dBottom,
			right: this.dRight,
		}

		// Merging tolerance: repositioning the cursor costs about this many bytes,
		// so shorter identical gaps are cheaper to redraw than to skip.
		const GAP_TOLERANCE = 6

		let out = ""
		let scanned = 0
		let patched = 0
		let activeStyle = -1
		let activeLink = LINK_NONE

		for (let y = damage.top; y <= damage.bottom; y++) {
			const rowBase = y * this.cols
			let x = damage.left
			while (x <= damage.right) {
				const i = rowBase + x
				scanned++
				// Two Int32 comparisons per cell, plus the link word.
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
				for (let probe = x; probe <= damage.right; probe++) {
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
					}
				}

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

		this.lastStats = { scanned, patched, bytes: out.length, damage }
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
