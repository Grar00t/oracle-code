// Interning pools. The point is zero per-cell allocation: the screen stores
// integers only, and every integer keeps its meaning across frames so the blit
// can copy packed words from the previous frame without re-interning.

/** Index 0 is always a single space. */
export const CHAR_SPACE = 0
/** Index 1 is always the empty string (continuation cell of a wide char). */
export const CHAR_EMPTY = 1

export class CharPool {
	/** ASCII fast path: code point -> id, no Map lookup, no hashing. */
	private readonly ascii = new Int32Array(128).fill(-1)
	private readonly wide = new Map<string, number>()
	private readonly values: string[] = [" ", ""]

	constructor() {
		this.ascii[32] = CHAR_SPACE
	}

	intern(cluster: string): number {
		if (cluster === "") return CHAR_EMPTY
		if (cluster.length === 1) {
			const code = cluster.charCodeAt(0)
			if (code < 128) {
				const hit = this.ascii[code]!
				if (hit >= 0) return hit
				const id = this.values.push(cluster) - 1
				this.ascii[code] = id
				return id
			}
		}
		const hit = this.wide.get(cluster)
		if (hit !== undefined) return hit
		const id = this.values.push(cluster) - 1
		this.wide.set(cluster, id)
		return id
	}

	resolve(id: number): string {
		return this.values[id] ?? " "
	}

	get size(): number {
		return this.values.length
	}
}

export type Style = {
	fg?: string
	bg?: string
	bold?: boolean
	dim?: boolean
	italic?: boolean
	underline?: boolean
	inverse?: boolean
	strike?: boolean
}

export const STYLE_DEFAULT = 0

function sgrColor(color: string, background: boolean): string {
	const base = background ? 48 : 38
	const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)
	if (m) {
		const hex = m[1]!
		const full =
			hex.length === 3
				? hex
						.split("")
						.map((c) => c + c)
						.join("")
				: hex
		const r = Number.parseInt(full.slice(0, 2), 16)
		const g = Number.parseInt(full.slice(2, 4), 16)
		const b = Number.parseInt(full.slice(4, 6), 16)
		return `${base};2;${r};${g};${b}`
	}
	const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color)
	if (rgb) return `${base};2;${rgb[1]};${rgb[2]};${rgb[3]}`
	const ansi256 = /^ansi256\((\d+)\)$/.exec(color)
	if (ansi256) return `${base};5;${ansi256[1]}`
	return ""
}

/**
 * StylePool encodes "is this style visible on a space" in bit 0 of the id:
 * foreground-only styles get even ids, styles with a background, inverse,
 * underline or strike get odd ids. Skipping an invisible space then costs one
 * mask test instead of a property read:
 *
 *   if (!(styleId & 1) && charId === CHAR_SPACE) continue
 */
export class StylePool {
	private readonly byKey = new Map<string, number>()
	private readonly byId = new Map<number, { style: Style; sgr: string }>()
	private nextEven = 2
	private nextOdd = 1

	constructor() {
		this.byId.set(STYLE_DEFAULT, { style: {}, sgr: "" })
		this.byKey.set("{}", STYLE_DEFAULT)
	}

	intern(style: Style): number {
		const key = JSON.stringify({
			fg: style.fg ?? null,
			bg: style.bg ?? null,
			b: style.bold ? 1 : 0,
			d: style.dim ? 1 : 0,
			i: style.italic ? 1 : 0,
			u: style.underline ? 1 : 0,
			v: style.inverse ? 1 : 0,
			s: style.strike ? 1 : 0,
		})
		const hit = this.byKey.get(key)
		if (hit !== undefined) return hit

		const visibleOnSpace = Boolean(
			style.bg || style.inverse || style.underline || style.strike,
		)
		const id = visibleOnSpace ? (this.nextOdd += 2) - 2 : (this.nextEven += 2) - 2

		// Pre-serialize the SGR string once; frames only concatenate cached strings.
		const parts: string[] = []
		if (style.bold) parts.push("1")
		if (style.dim) parts.push("2")
		if (style.italic) parts.push("3")
		if (style.underline) parts.push("4")
		if (style.inverse) parts.push("7")
		if (style.strike) parts.push("9")
		if (style.fg) {
			const c = sgrColor(style.fg, false)
			if (c) parts.push(c)
		}
		if (style.bg) {
			const c = sgrColor(style.bg, true)
			if (c) parts.push(c)
		}
		const sgr = parts.length ? `\u001b[${parts.join(";")}m` : ""

		this.byKey.set(key, id)
		this.byId.set(id, { style, sgr })
		return id
	}

	sgr(id: number): string {
		return this.byId.get(id)?.sgr ?? ""
	}

	style(id: number): Style {
		return this.byId.get(id)?.style ?? {}
	}

	static visibleOnSpace(id: number): boolean {
		return (id & 1) === 1
	}
}

export const LINK_NONE = 0

export class HyperlinkPool {
	private readonly byUrl = new Map<string, number>()
	private readonly urls: string[] = [""]

	intern(url: string): number {
		if (!url) return LINK_NONE
		const hit = this.byUrl.get(url)
		if (hit !== undefined) return hit
		const id = this.urls.push(url) - 1
		this.byUrl.set(url, id)
		return id
	}

	resolve(id: number): string {
		return this.urls[id] ?? ""
	}
}

/** Pools are shared between the front and back frames on purpose. */
export class Pools {
	readonly chars = new CharPool()
	readonly styles = new StylePool()
	readonly links = new HyperlinkPool()
}
