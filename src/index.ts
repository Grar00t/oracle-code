#!/usr/bin/env node
// Oracle Code entry point.
//
//   oc "prompt"           one-shot, prints the final answer
//   oc                    interactive session
//   oc sessions           list session transcripts
//   oc theme --lint FILE  report which theme keys would be ignored
//   oc lang               report the active language and what a pack is missing
//   oc doctor             print engine, platform, shell, language and endpoint
//
// Runs under Bun and under Node, on Linux, macOS and Windows. Anything
// engine-specific or platform-specific lives in src/rt. The interface ships
// English only; any other language is a JSON pack the user supplies.

import { Agent } from "./agent/loop"
import { builtins } from "./agent/builtins"
import { lspTools } from "./agent/lsp-tools"
import { Model } from "./agent/model"
import { Registry, type ToolContext } from "./agent/tools"
import {
	disableRawInput,
	enableRawInput,
	nextLine,
	closeStdin,
	runtimeLabel,
	shellPlan,
	which,
} from "./rt/index"
import { availableServers, disposeClients } from "./lsp/index"
import { Checkpoints } from "./safety/checkpoints"
import { EffectLedger } from "./safety/ledger"
import { MODE_CYCLE, Permissions, type PermissionMode } from "./safety/permissions"
import { projectKey, Session } from "./session/jsonl"
import { loadUserTheme, resolveTheme, themePath } from "./theme/theme"
import { direction, langPath, loadLanguage, resolveLangCode, t, visual, type PackReport } from "./i18n/index"
import { render, type AppState } from "./app"
import { LineEditor } from "./tui/editor"
import { parseKeys } from "./tui/keys"
import { Terminal } from "./tui/terminal"
import { readdir } from "node:fs/promises"
import { resolve as resolvePath } from "node:path"

/**
 * Ask a yes/no question.
 *
 * Reads through the single shared stdin reader in src/rt. Two independent
 * `for await (const line of console)` loops used to consume the same stdin
 * iterator, so a permission prompt raised mid-turn could steal the user's next
 * task, or the main loop could swallow the answer to "[y/N]".
 */
async function askYesNo(question: string): Promise<boolean> {
	process.stdout.write(`\n${visual(question)} [y/N] `)
	const line = await nextLine()
	return (line ?? "").trim().toLowerCase().startsWith("y")
}

/**
 * What to report about the language.
 *
 * English is compiled in and never read from disk, so naming a path for it is
 * an invitation to create a file that will be ignored. A path is reported only
 * when a pack was actually consulted.
 */
function languageReport(report: PackReport): Record<string, unknown> {
	if (report.code === "en") {
		return { requested: "en", active: "en", direction: direction(), source: "built in" }
	}
	return {
		requested: report.code,
		active: report.loaded ? report.code : "en",
		direction: direction(),
		source: report.loaded ? "pack" : "built in, pack not loaded",
		packPath: report.path,
		missingKeys: report.missing,
		ignoredKeys: report.ignored,
		...(report.reason ? { reason: report.reason } : {}),
	}
}

/** One line describing a pack load, said out loud instead of failing quietly. */
function packSummary(report: PackReport): string {
	if (report.loaded) {
		const extra = report.ignored.length ? ` \u00b7 ignored ${report.ignored.length}` : ""
		return `${t("language")}: ${report.code} \u00b7 ${report.direction}${extra}`
	}
	const why = report.missing.length ? `missing ${report.missing.length} keys` : (report.reason ?? "unusable")
	return `${t("language")}: en \u00b7 ${report.code} not loaded (${why}) \u00b7 ${report.path}`
}

async function doctor(report: PackReport): Promise<void> {
	const plan = shellPlan("echo ok")
	const model = new Model()
	const probe = await model.probe()
	const rg = await which("rg")
	const lsp = await availableServers()
	console.log(
		JSON.stringify(
			{
				runtime: runtimeLabel(),
				shell: { file: plan.file, name: plan.shell, args: plan.args.slice(0, -1) },
				// A bare null said nothing about consequence. Search still works
				// without ripgrep; it is just the slower path.
				search: rg
					? { engine: "ripgrep", path: rg }
					: { engine: "built in scanner", note: "ripgrep not on PATH; grep is slower but works" },
				// Which language servers the lsp tools can actually use. A missing
				// server disables those tools for its language, nothing else.
				languageServers: Object.fromEntries(
					lsp.map((s) => [s.bin, s.path ?? "not on PATH"]),
				),
				language: languageReport(report),
				themePath: themePath(process.env.ORACLE_THEME ?? "user"),
				model: { name: model.name, baseUrl: model.baseUrl },
				endpoint: probe.ok
					? { reachable: true, serving: probe.models }
					: { reachable: false, reason: probe.reason, hint: probe.hint },
			},
			null,
			2,
		),
	)
}

/**
 * Previous prompts of this project, oldest first, for up-arrow history.
 * Read from the most recent session transcript; a missing store is empty
 * history, not an error.
 */
async function loadPromptHistory(limit = 100): Promise<string[]> {
	try {
		const dir = resolvePath(".oracle", "sessions", projectKey())
		const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort()
		const latest = files[files.length - 1]
		if (!latest) return []
		const { readText } = await import("./rt/index")
		const text = await readText(resolvePath(dir, latest))
		const prompts: string[] = []
		for (const line of text.split(/\r?\n/)) {
			if (!line) continue
			try {
				const record = JSON.parse(line) as { kind?: string; data?: { text?: string } }
				if (record.kind === "user" && typeof record.data?.text === "string") {
					prompts.push(record.data.text)
				}
			} catch {
				// A torn line at the end of a crashed session is expected.
			}
		}
		return prompts.slice(-limit)
	} catch {
		return []
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2)

	// The language is settled before anything is printed, so the first line the
	// user sees is already in the language they asked for.
	let langReport = await loadLanguage(resolveLangCode())

	if (argv[0] === "sessions") {
		const list = await Session.list()
		console.log(list.length ? list.join("\n") : visual(t("noSessions")))
		return
	}

	if (argv[0] === "lang") {
		console.log(JSON.stringify(languageReport(langReport), null, 2))
		return
	}

	if (argv[0] === "doctor") {
		await doctor(langReport)
		return
	}

	if (argv[0] === "theme" && argv[1] === "--lint" && argv[2]) {
		const resolved = resolveTheme(await loadUserTheme(argv[2]))
		console.log(
			JSON.stringify(
				{ theme: resolved.name, ignored: resolved.ignored, cleanFile: resolved.ignored.length === 0 },
				null,
				2,
			),
		)
		return
	}

	const modeArg = process.env.ORACLE_MODE as PermissionMode | undefined
	const mode: PermissionMode = modeArg && MODE_CYCLE.includes(modeArg) ? modeArg : "manual"

	const session = new Session()
	// Interactive mode answers permission prompts from the key loop; the line
	// asker below serves one-shot mode. The holder lets both share one
	// Permissions instance created before the mode is known.
	let interactiveAsk: ((question: string) => Promise<boolean>) | null = null
	const permissions = new Permissions(mode, (q) => (interactiveAsk ? interactiveAsk(q) : askYesNo(q)))
	const checkpoints = new Checkpoints(session.id)
	const ledger = new EffectLedger(session.id)
	const model = new Model()
	const registry = new Registry().register(...builtins, ...lspTools)
	const ctx: ToolContext = { cwd: process.cwd(), permissions, checkpoints, ledger, session }

	await session.append("session.start", {
		cwd: process.cwd(),
		model: model.name,
		baseUrl: model.baseUrl,
		mode,
		lang: langReport.loaded ? langReport.code : "en",
		runtime: runtimeLabel(),
		shell: shellPlan("true").shell,
	})

	// Find out before the first prompt, not during it. An unreachable endpoint is
	// the most common failure on a fresh machine and it must name itself.
	const reachable = await model.probe()

	const theme = resolveTheme(await loadUserTheme(themePath(process.env.ORACLE_THEME ?? "user")))

	const oneShot = argv.filter((a) => !a.startsWith("--")).join(" ").trim()

	// One-shot mode stays line-oriented so it composes with pipes and jq.
	if (oneShot) {
		if (!reachable.ok) {
			process.stderr.write(`${visual(t("endpointUnreachable"))}\n  ${reachable.reason}\n  ${reachable.hint}\n`)
			process.exitCode = 1
			return
		}
		const agent = new Agent(model, registry, ctx, {
			onEvent: (event) => {
				if (event.type === "token") process.stdout.write(event.text)
				if (event.type === "tool.end")
					process.stderr.write(
						`\n[${event.ok ? "ok" : "fail"}] ${event.parallel ? "\u2225" : "\u2192"} ${event.name} ${event.durationMs.toFixed(0)}ms\n`,
					)
			},
		})
		await agent.run(oneShot)
		process.stdout.write("\n")
		const irreversible = ledger.irreversible()
		if (irreversible.length) {
			process.stderr.write(`\n${visual(t("irreversible"))} ${irreversible.length} \u2014 .oracle/effects.jsonl\n`)
		}
		disposeClients()
		closeStdin()
		return
	}

	// Interactive mode.
	const term = new Terminal({ alternateScreen: true })

	const served =
		reachable.ok && reachable.models.length ? ` \u00b7 ${t("serving")} ${reachable.models.join(", ")}` : ""
	const entries: AppState["entries"] = [
		{
			role: "notice",
			text: reachable.ok
				? `oracle-code \u00b7 ${model.name} @ ${model.baseUrl} \u00b7 ${mode}${served}`
				: `oracle-code \u00b7 ${model.name} @ ${model.baseUrl} \u00b7 ${mode} \u00b7 ${t("endpointUnreachable")}`,
		},
		{ role: "notice", text: `${t("runtime")} ${runtimeLabel()}` },
	]
	if (!reachable.ok) {
		entries.push({ role: "notice", text: reachable.reason })
		entries.push({ role: "notice", text: reachable.hint })
	}
	// Only mention the language when it is not the default, or when a pack the
	// user asked for failed to load. Silence is the correct output otherwise.
	if (langReport.code !== "en" || !langReport.loaded) {
		entries.push({ role: "notice", text: packSummary(langReport) })
	}
	entries.push({ role: "notice", text: t("startupHint") })

	const state: AppState = {
		entries,
		streaming: "",
		input: "",
		cursor: 0,
		multiline: false,
		scroll: 0,
		mode,
		model: model.name,
		lang: langReport.loaded ? langReport.code : "en",
		busy: false,
		question: null,
		spinnerFrame: 0,
		checkpoints: 0,
		irreversibleEffects: 0,
		fillerHits: 0,
		lastFrameMs: 0,
		patchedCells: 0,
	}

	const draw = () => {
		const record = term.draw(render(state, theme.palette))
		state.lastFrameMs = record.durationMs
		state.patchedCells = record.patched
	}

	const spinner = setInterval(() => {
		if (!state.busy) return
		state.spinnerFrame++
		draw()
	}, 80)

	draw()

	const agent = new Agent(model, registry, ctx, {
		onEvent: (event) => {
			switch (event.type) {
				case "token":
					state.streaming += event.text
					break
				case "tool.end":
					state.entries.push({
						role: "tool",
						name: event.name,
						ok: event.ok,
						summary: "",
						durationMs: event.durationMs,
						parallel: event.parallel,
						preview: event.preview,
					})
					break
				case "compaction":
					state.entries.push({
						role: "notice",
						text: `${t("contextCompacted")} (${event.droppedToolOutputs}${event.summarized ? " +" : ""})`,
					})
					break
				case "filler":
					state.fillerHits += event.hits.length
					break
				case "turn.end":
					state.streaming = ""
					state.entries.push({ role: "assistant", text: event.text })
					break
			}
			draw()
		},
	})

	// -------------------------------------------------------------------------
	// Key loop. Raw mode owns stdin exclusively; nextLine is never called while
	// it is active, which is what keeps a permission prompt from racing the
	// composer for the same bytes.

	const editor = new LineEditor()
	editor.seedHistory(await loadPromptHistory())

	// Permission prompts become a y/n keypress routed by the key handler.
	let pendingAnswer: ((yes: boolean) => void) | null = null
	interactiveAsk = (question: string) =>
		new Promise<boolean>((resolveAnswer) => {
			state.question = question
			pendingAnswer = resolveAnswer
			draw()
		})

	const syncComposer = () => {
		state.input = editor.text
		state.cursor = editor.cursorPosition
		state.multiline = editor.isMultiline
	}

	const runTask = async (input: string) => {
		state.entries.push({ role: "user", text: input })
		state.scroll = 0
		state.busy = true
		draw()
		try {
			await agent.run(input)
		} catch (error) {
			state.entries.push({ role: "notice", text: `${t("error")}: ${(error as Error).message}` })
		}
		state.busy = false
		state.checkpoints = checkpoints.entries().length
		state.irreversibleEffects = ledger.irreversible().length
		draw()
	}

	const handleSubmit = async (raw: string, quit: () => void): Promise<void> => {
		const input = raw.trim()
		if (input === "/quit" || input === "/exit") {
			quit()
			return
		}
		if (input === "/mode") {
			state.mode = permissions.cycle()
			state.entries.push({ role: "notice", text: `${t("permissionMode")}: ${state.mode}` })
			draw()
			return
		}
		if (input === "/lang" || input.startsWith("/lang ")) {
			const arg = input.slice(5).trim().toLowerCase()
			langReport = await loadLanguage(arg || langReport.code)
			state.lang = langReport.loaded ? langReport.code : "en"
			state.entries.push({ role: "notice", text: packSummary(langReport) })
			if (!langReport.loaded) {
				state.entries.push({ role: "notice", text: langPath(langReport.code) })
			}
			draw()
			return
		}
		if (input === "/undo") {
			const restored = await checkpoints.undo()
			state.checkpoints = checkpoints.entries().length
			state.entries.push({
				role: "notice",
				text: restored ? `${t("restored")} ${restored}` : t("nothingToUndo"),
			})
			draw()
			return
		}
		if (!input) return
		await runTask(input)
	}

	await new Promise<void>((finish) => {
		let done = false
		const quit = () => {
			if (done) return
			done = true
			finish()
		}

		// A chunk boundary can split an escape sequence; the tail is carried into
		// the next chunk. A lone ESC that nothing follows is flushed as the escape
		// key after a beat — that is the user pressing the key, not a sequence.
		let carry = ""
		let escTimer: ReturnType<typeof setTimeout> | null = null

		const handleKeys = (chunk: string) => {
			if (escTimer) {
				clearTimeout(escTimer)
				escTimer = null
			}
			const { keys, rest } = parseKeys(carry + chunk)
			carry = rest
			if (carry === "\u001b") {
				escTimer = setTimeout(() => {
					carry = ""
					escTimer = null
					feed([{ kind: "escape" as const }])
				}, 40)
			}
			feed(keys)
		}

		const feed = (keys: ReturnType<typeof parseKeys>["keys"]) => {
			for (const key of keys) {
				// A pending permission question consumes the next key: y is yes,
				// anything else is no. Nothing reaches the composer.
				if (pendingAnswer) {
					const answer = pendingAnswer
					pendingAnswer = null
					state.question = null
					answer(key.kind === "char" && key.char.toLowerCase() === "y")
					draw()
					continue
				}
				if (key.kind === "ctrl" && (key.char === "c" || key.char === "d")) {
					quit()
					return
				}
				// While a turn runs the composer is closed; scrolling still works.
				if (state.busy && key.kind !== "pageUp" && key.kind !== "pageDown") continue
				const action = editor.feed(key)
				syncComposer()
				switch (action.kind) {
					case "submit":
						syncComposer()
						draw()
						void handleSubmit(action.text, quit)
						break
					case "scroll": {
						const max = Math.max(0, state.entries.length - 1)
						state.scroll =
							action.direction === "up"
								? Math.min(max, state.scroll + 5)
								: Math.max(0, state.scroll - 5)
						break
					}
					case "cancel":
						quit()
						return
					case "none":
						break
				}
			}
			if (!done) draw()
		}

		if (!enableRawInput(handleKeys, quit)) {
			// stdin is not available for keystrokes (piped input, tests). Fall back
			// to line mode so `echo task | oc` still works.
			void (async () => {
				while (!done) {
					const line = await nextLine()
					if (line === null) return quit()
					await handleSubmit(line, quit)
				}
			})()
		}
	})

	clearInterval(spinner)
	disposeClients()
	disableRawInput()
	closeStdin()
}

await main()
