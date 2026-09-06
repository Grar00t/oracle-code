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
	durationMs: number
	patched: number
	scanned: number
	bytes: number
	/** Rows carrying a real difference. scanned/damagedRows is the span walked. */
	damagedRows: number
	/** Rows repainted with identical content and skipped without a read. */
	rowsSkipped: number
}

/**
 * Owns stdout, the frame loop and the frame telemetry.
 *
 * Every frame's cost is recorded, not estimated. Callers can stream these
 * records into the session JSONL so any performance claim is traceable to a run
 * on a specific machine.
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

	/** Build, diff and flush one frame. Returns its telemetry record. */
	draw(tree: Node): FrameRecord {
		const started = performance.now()
		this.screen.beginFrame()
		paintRoot(tree, this.screen)
		const patch = this.screen.render()
		if (patch) this.out(patch)
		this.screen.commit()
		const stats = this.screen.lastStats
		const record: FrameRecord = {
			frame: this.frames++,
			durationMs: performance.now() - started,
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
