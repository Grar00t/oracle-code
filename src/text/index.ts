import { hasArabic, shapeArabic } from "./arabic"
import { type Direction, paragraphDirection, reorderLine } from "./bidi"
import { clusters, stringWidth } from "./width"

export { shapeArabic, hasArabic } from "./arabic"
export { reorderLine, paragraphDirection, type Direction } from "./bidi"
export { clusters, stringWidth, codePointWidth } from "./width"

/**
 * Turn logical text into the exact cell clusters the grid should hold.
 *
 * Order matters: shape first (joining is a logical-order property), reorder
 * second (visual order), cluster last (so combining marks stay attached to the
 * base they were reordered with).
 *
 * ASCII-only input takes a fast path and is never touched by the bidi code.
 */
export function layoutLine(
	text: string,
	base?: Direction,
): { clusters: string[]; width: number; direction: Direction } {
	let ascii = true
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) > 0x7e) {
			ascii = false
			break
		}
	}
	if (ascii) {
		return { clusters: text.split(""), width: text.length, direction: "ltr" }
	}

	const direction = base ?? paragraphDirection(text)
	const shaped = hasArabic(text) ? shapeArabic(text) : text
	const visual = reorderLine(shaped, direction)
	const cells = clusters(visual)
	return { clusters: cells, width: stringWidth(visual), direction }
}
