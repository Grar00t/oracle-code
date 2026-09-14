// Line editor state machine. Pure: key events in, state out. The interactive
// loop feeds it keys and reads {text, cursor}; the composer draws that state.
//
// Multiline: a line consisting of exactly `"""` toggles multiline mode. In
// multiline mode Enter inserts a newline and a second `"""` line submits.
// Shift+Enter cannot be used — most terminals send plain 0x0d for it, so the
// editor would have no way to tell the two apart.

import type { Key } from "./keys"

export type EditorAction =
	| { kind: "none" }
	| { kind: "submit"; text: string }
	| { kind: "cancel" }
	| { kind: "scroll"; direction: "up" | "down" }

export class LineEditor {
	private buffer = ""
	private cursor = 0
	private multiline = false
	private readonly history: string[] = []
	/** history.length means "editing a fresh line". */
	private historyIndex = 0
	/** What was being typed before history browsing started. */
	private pending = ""

	get text(): string {
		return this.buffer
	}

	get cursorPosition(): number {
		return this.cursor
	}

	get isMultiline(): boolean {
		return this.multiline
	}

	/** Seed history, oldest first — from the session transcript on resume. */
	seedHistory(lines: string[]): void {
		for (const line of lines) if (line.trim()) this.history.push(line)
		this.historyIndex = this.history.length
	}

	historyEntries(): readonly string[] {
		return this.history
	}

	private set(text: string, cursor = text.length): void {
		this.buffer = text
		this.cursor = Math.max(0, Math.min(cursor, text.length))
	}

	private insert(text: string): void {
		this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor)
		this.cursor += text.length
	}

	/** Start of the line the cursor is on (multiline buffers only). */
	private lineStart(): number {
		return this.buffer.lastIndexOf("\n", this.cursor - 1) + 1
	}

	private lineEnd(): number {
		const idx = this.buffer.indexOf("\n", this.cursor)
		return idx === -1 ? this.buffer.length : idx
	}

	private submit(): EditorAction {
		const text = this.buffer
		if (text.trim()) {
			this.history.push(text)
		}
		this.historyIndex = this.history.length
		this.pending = ""
		this.multiline = false
		this.set("")
		return { kind: "submit", text }
	}

	feed(key: Key): EditorAction {
		switch (key.kind) {
			case "char":
				this.insert(key.char)
				return { kind: "none" }

			case "enter": {
				if (this.multiline) {
					// A `"""` line alone closes the block and submits everything above it.
					const start = this.lineStart()
					const lastLine = this.buffer.slice(start, this.lineEnd())
					if (lastLine.trim() === '"""' && this.cursor === this.buffer.length) {
						this.set(this.buffer.slice(0, Math.max(0, start - 1)))
						return this.submit()
					}
					this.insert("\n")
					return { kind: "none" }
				}
				if (this.buffer.trim() === '"""') {
					this.multiline = true
					this.set("")
					return { kind: "none" }
				}
				return this.submit()
			}

			case "backspace":
				if (this.cursor > 0) {
					this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor)
					this.cursor--
				}
				return { kind: "none" }

			case "delete":
				if (this.cursor < this.buffer.length) {
					this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1)
				}
				return { kind: "none" }

			case "left":
				if (this.cursor > 0) this.cursor--
				return { kind: "none" }

			case "right":
				if (this.cursor < this.buffer.length) this.cursor++
				return { kind: "none" }

			case "home":
				this.cursor = this.multiline ? this.lineStart() : 0
				return { kind: "none" }

			case "end":
				this.cursor = this.multiline ? this.lineEnd() : this.buffer.length
				return { kind: "none" }

			case "up": {
				if (this.multiline) return { kind: "none" }
				if (this.historyIndex === 0 || this.history.length === 0) return { kind: "none" }
				if (this.historyIndex === this.history.length) this.pending = this.buffer
				this.historyIndex--
				this.set(this.history[this.historyIndex]!)
				return { kind: "none" }
			}

			case "down": {
				if (this.multiline) return { kind: "none" }
				if (this.historyIndex >= this.history.length) return { kind: "none" }
				this.historyIndex++
				this.set(this.historyIndex === this.history.length ? this.pending : this.history[this.historyIndex]!)
				return { kind: "none" }
			}

			case "pageUp":
				return { kind: "scroll", direction: "up" }

			case "pageDown":
				return { kind: "scroll", direction: "down" }

			case "escape":
				if (this.multiline) {
					this.multiline = false
					this.set("")
				}
				return { kind: "none" }

			case "tab":
				return { kind: "none" }

			case "ctrl":
				switch (key.char) {
					case "a":
						this.cursor = this.multiline ? this.lineStart() : 0
						return { kind: "none" }
					case "e":
						this.cursor = this.multiline ? this.lineEnd() : this.buffer.length
						return { kind: "none" }
					case "u":
						this.set(this.buffer.slice(this.cursor), 0)
						return { kind: "none" }
					case "k":
						this.set(this.buffer.slice(0, this.cursor), this.cursor)
						return { kind: "none" }
					case "w": {
						// Delete the word before the cursor.
						let start = this.cursor
						while (start > 0 && this.buffer[start - 1] === " ") start--
						while (start > 0 && this.buffer[start - 1] !== " " && this.buffer[start - 1] !== "\n") start--
						this.buffer = this.buffer.slice(0, start) + this.buffer.slice(this.cursor)
						this.cursor = start
						return { kind: "none" }
					}
					case "c":
					case "d":
						return { kind: "cancel" }
					default:
						return { kind: "none" }
				}
		}
	}
}
