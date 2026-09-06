import {
	ENTER_ALT_SCREEN,
	HIDE_CURSOR,
	LEAVE_ALT_SCREEN,
	RESET,
	SHOW_CURSOR,
} from "./ansi"
import { paintRoot, type Node } from "./layout"
import { Screen } from "./screen"

export type FrameRecord = {
	frame: number
	/** Whole frame: blit + paint + diff + write. */
	durationMs: number
	/** Typed-array copy of the visible frame into the drawing frame. */
	blitMs: number
	/** Layout plus every cell write, including shaping and reordering. */
	paintMs: number
	/** Difference scan, run merging and ANSI serialization. */
	diffMs: number
	/** Handing the patch to the output and swapping frames. */
	writeMs: number
	patched: number
	scanned: number
	bytes: number
	/** Rows carrying a real difference. */
	damagedRows: number
	/** Rows repainted with identical content and skipped without a read. */
	rowsSkipped: number
}

/**
 * Owns stdout, the frame loop and the frame telemetry.
 *
 * Every frame's cost is recorded per stage, not estimated. A single total hides
 * which stage is paying: on this repo a diff that went from 23636 scanned cells
 * to 1 left the total unchanged, which is only visible if the stages are timed
 * apart. Callers can stream these records into the session JSONL so any
 * performance claim stays traceable to a run on a specific machine.
 */
export class Terminal {
	readonly screen: Screen
	private frames = 0
	private readonly records: FrameRecord[] = []
	private readonly out: (chunk: string) => void
	private raw: boolean

	constructor(
		opts: {
			cols?: number
			rows?: number
			write?: (chunk: string) => void
			alternateScreen?: boolean
		} = {},
	) {
		const cols = opts.cols ?? process.stdout.columns ?? 80
		const rows = opts.rows ?? process.stdout.rows ?? 24
		this.screen = new Screen(cols, rows)
		this.out = opts.write ?? ((chunk) => process.stdout.write(chunk))
		this.raw = false
		if (opts.alternateScreen) {
			this.out(ENTER_ALT_SCREEN + HIDE_CURSOR)
			process.on("exit", () => this.out(SHOW_CURSOR + LEAVE_ALT_SCREEN + RESET))
		}
		process.stdout.on?.("resize", () => {
			this.screen.resize(process.stdout.columns ?? cols, process.stdout.rows ?? rows)
		})
	}

	/** Build, diff and flush one frame. Returns its per-stage telemetry record. */
	draw(tree: Node): FrameRecord {
		const t0 = performance.now()
		this.screen.beginFrame()
		const t1 = performance.now()
		paintRoot(tree, this.screen)
		const t2 = performance.now()
		const patch = this.screen.render()
		const t3 = performance.now()
		if (patch) this.out(patch)
		this.screen.commit()
		const t4 = performance.now()
		const stats = this.screen.lastStats
		const record: FrameRecord = {
			frame: this.frames++,
			durationMs: t4 - t0,
			blitMs: t1 - t0,
			paintMs: t2 - t1,
			diffMs: t3 - t2,
			writeMs: t4 - t3,
			patched: stats.patched,
			scanned: stats.scanned,
			bytes: stats.bytes,
			damagedRows: stats.damagedRows,
			rowsSkipped: stats.rowsSkipped,
		}
		this.records.push(record)
		if (this.records.length > 512) this.records.shift()
		return record
	}

	telemetry(): readonly FrameRecord[] {
		return this.records
	}
}
