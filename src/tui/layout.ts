// Retained node tree and layout.
//
// No React, no reconciler, no Yoga. Widgets build a plain tree once per frame;
// layout is a single measure pass plus a single paint pass. The tree is cheap
// enough to rebuild that diffing it would cost more than it saves — the diffing
// that matters happens on the cell grid, not on the node tree.

import { layoutLine } from "../text"
import type { Direction } from "../text/bidi"
import { stringWidth } from "../text/width"
import type { Screen } from "./screen"
import type { Style } from "./pools"

export type TextNode = {
	kind: "text"
	text: string
	style?: Style
	wrap?: boolean
	/** Forces base direction; omitted means first-strong detection per line. */
	direction?: Direction
	url?: string
}

export type BoxNode = {
	kind: "box"
	direction?: "column" | "row"
	children: Node[]
	width?: number
	height?: number
	grow?: boolean
	padding?: number
	gap?: number
	background?: Style
	border?: boolean
	borderStyle?: Style
	title?: string
}

export type SpacerNode = { kind: "spacer"; size?: number; grow?: boolean }

export type Node = TextNode | BoxNode | SpacerNode

export const text = (t: string, style?: Style, extra?: Partial<TextNode>): TextNode => ({
	kind: "text",
	text: t,
	style,
	wrap: true,
	...extra,
})

export const box = (children: Node[], props: Omit<BoxNode, "kind" | "children"> = {}): BoxNode => ({
	kind: "box",
	children,
	...props,
})

export const spacer = (size = 1): SpacerNode => ({ kind: "spacer", size })

/** Greedy word wrap on logical text. Shaping and reordering happen per line. */
export function wrapText(text: string, width: number): string[] {
	if (width <= 0) return []
	const out: string[] = []
	for (const paragraph of text.split("\n")) {
		if (paragraph === "") {
			out.push("")
			continue
		}
		let line = ""
		for (const word of paragraph.split(/(\s+)/)) {
			if (word === "") continue
			const candidate = line + word
			if (stringWidth(candidate) <= width) {
				line = candidate
				continue
			}
			if (line.trim() !== "") out.push(line.trimEnd())
			if (stringWidth(word) <= width) {
				line = word.trimStart()
				continue
			}
			// Hard break for a single oversized token.
			let chunk = ""
			for (const ch of word) {
				if (stringWidth(chunk + ch) > width) {
					out.push(chunk)
					chunk = ""
				}
				chunk += ch
			}
			line = chunk
		}
		out.push(line.trimEnd())
	}
	return out
}

function measureHeight(node: Node, width: number): number {
	switch (node.kind) {
		case "text": {
			if (node.wrap === false) return 1
			return Math.max(1, wrapText(node.text, width).length)
		}
		case "spacer":
			return node.size ?? 1
		case "box": {
			if (node.height !== undefined) return node.height
			const pad = (node.padding ?? 0) + (node.border ? 1 : 0)
			const inner = Math.max(0, width - pad * 2)
			const gap = node.gap ?? 0
			if ((node.direction ?? "column") === "row") {
				let tallest = 0
				const per = node.children.length
					? Math.floor((inner - gap * (node.children.length - 1)) / node.children.length)
					: inner
				for (const child of node.children) {
					tallest = Math.max(tallest, measureHeight(child, child.kind === "box" && child.width ? child.width : per))
				}
				return tallest + pad * 2
			}
			let total = 0
			node.children.forEach((child, index) => {
				total += measureHeight(child, inner)
				if (index < node.children.length - 1) total += gap
			})
			return total + pad * 2
		}
	}
}

export function paint(
	node: Node,
	screen: Screen,
	x: number,
	y: number,
	width: number,
	height: number,
): void {
	if (width <= 0 || height <= 0) return

	switch (node.kind) {
		case "spacer":
			return

		case "text": {
			const lines = node.wrap === false ? [node.text] : wrapText(node.text, width)
			for (let i = 0; i < Math.min(lines.length, height); i++) {
				const laid = layoutLine(lines[i]!, node.direction)
				// Right-to-left paragraphs are flushed to the right edge of the box,
				// which is what makes mixed Arabic and Latin output readable in a grid.
				const offset = laid.direction === "rtl" ? Math.max(0, width - laid.width) : 0
				const drawn = screen.putClusters(x + offset, y + i, laid.clusters, node.style, node.url ?? "")
				// Blank the rest of the line so stale glyphs cannot survive a blit.
				const usedStart = x + offset
				if (offset > 0) {
					screen.fill({ top: y + i, bottom: y + i, left: x, right: usedStart - 1 }, node.style ?? {})
				}
				const tail = usedStart + drawn
				if (tail <= x + width - 1) {
					screen.fill({ top: y + i, bottom: y + i, left: tail, right: x + width - 1 }, node.style ?? {})
				}
			}
			for (let i = lines.length; i < height; i++) {
				screen.fill({ top: y + i, bottom: y + i, left: x, right: x + width - 1 })
			}
			return
		}

		case "box": {
			if (node.background) {
				screen.fill({ top: y, left: x, bottom: y + height - 1, right: x + width - 1 }, node.background)
			} else {
				screen.fill({ top: y, left: x, bottom: y + height - 1, right: x + width - 1 })
			}

			let innerX = x
			let innerY = y
			let innerW = width
			let innerH = height

			if (node.border) {
				drawBorder(screen, x, y, width, height, node.borderStyle, node.title)
				innerX += 1
				innerY += 1
				innerW -= 2
				innerH -= 2
			}
			const pad = node.padding ?? 0
			innerX += pad
			innerY += pad
			innerW -= pad * 2
			innerH -= pad * 2
			if (innerW <= 0 || innerH <= 0) return

			const gap = node.gap ?? 0
			if ((node.direction ?? "column") === "row") {
				const count = node.children.length
				const fixed = node.children.reduce((sum, c) => sum + (c.kind === "box" && c.width ? c.width : 0), 0)
				const flexible = node.children.filter((c) => !(c.kind === "box" && c.width)).length
				const free = innerW - fixed - gap * Math.max(0, count - 1)
				const per = flexible > 0 ? Math.floor(free / flexible) : 0
				let cursor = innerX
				for (const child of node.children) {
					const w = child.kind === "box" && child.width ? child.width : per
					paint(child, screen, cursor, innerY, w, innerH)
					cursor += w + gap
				}
				return
			}

			// Column: measure children, then let the last grow child absorb slack.
			const heights = node.children.map((child) =>
				child.kind === "box" && child.height !== undefined
					? child.height
					: measureHeight(child, innerW),
			)
			const used = heights.reduce((a, b) => a + b, 0) + gap * Math.max(0, node.children.length - 1)
			const slack = innerH - used
			if (slack !== 0) {
				const growIndex = node.children.findIndex(
					(c) => (c.kind === "box" || c.kind === "spacer") && c.grow,
				)
				if (growIndex >= 0) heights[growIndex] = Math.max(0, heights[growIndex]! + slack)
			}

			let cursorY = innerY
			node.children.forEach((child, index) => {
				const h = Math.min(heights[index]!, Math.max(0, innerY + innerH - cursorY))
				paint(child, screen, innerX, cursorY, innerW, h)
				cursorY += h + gap
			})
			return
		}
	}
}

function drawBorder(
	screen: Screen,
	x: number,
	y: number,
	width: number,
	height: number,
	style: Style | undefined,
	title: string | undefined,
): void {
	const s = style ?? {}
	const top = ["\u256d", ...Array(Math.max(0, width - 2)).fill("\u2500"), "\u256e"]
	const bottom = ["\u2570", ...Array(Math.max(0, width - 2)).fill("\u2500"), "\u256f"]
	screen.putClusters(x, y, top, s)
	screen.putClusters(x, y + height - 1, bottom, s)
	for (let row = y + 1; row < y + height - 1; row++) {
		screen.putClusters(x, row, ["\u2502"], s)
		screen.putClusters(x + width - 1, row, ["\u2502"], s)
	}
	if (title) screen.putText(x + 2, y, ` ${title} `, s)
}

/** Paint a root node across the whole screen. */
export function paintRoot(node: Node, screen: Screen): void {
	paint(node, screen, 0, 0, screen.cols, screen.rows)
}
