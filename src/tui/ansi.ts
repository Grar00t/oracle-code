// Raw terminal control sequences used by the writer.
//
// FACT: DEC private mode 2026 (Synchronized Output, BSU/ESU) is honoured by
// modern terminals; wrapping one frame in it makes the update atomic and is the
// single cheapest fix for tearing during token streaming. Terminals that do not
// support it ignore the sequence.

export const ESC = "\u001b"
export const CSI = `${ESC}[`

/** Begin Synchronized Update. */
export const BSU = `${CSI}?2026h`
/** End Synchronized Update. */
export const ESU = `${CSI}?2026l`

export const RESET = `${CSI}0m`
export const HIDE_CURSOR = `${CSI}?25l`
export const SHOW_CURSOR = `${CSI}?25h`
export const ENTER_ALT_SCREEN = `${CSI}?1049h`
export const LEAVE_ALT_SCREEN = `${CSI}?1049l`
export const CLEAR_SCREEN = `${CSI}2J${CSI}H`

/** 1-based cursor position. */
export function moveTo(row: number, col: number): string {
	return `${CSI}${row + 1};${col + 1}H`
}

/** OSC 8 hyperlink open / close. */
export function link(url: string): string {
	return `${ESC}]8;;${url}${ESC}\\`
}
export const LINK_END = `${ESC}]8;;${ESC}\\`
