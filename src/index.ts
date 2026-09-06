#!/usr/bin/env node
// Oracle Code entry point.
//
//   oc "prompt"           one-shot, prints the final answer
//   oc                    interactive session
//   oc sessions           list session transcripts
//   oc theme --lint FILE  report which theme keys would be ignored
//   oc lang               report the active language pack and what it is missing
//   oc doctor             print engine, platform, shell, language and endpoint
//
// Runs under Bun and under Node, on Linux, macOS and Windows. Anything
// engine-specific or platform-specific lives in src/rt. The interface ships
// English only; any other language is a JSON pack the user supplies.

import { Agent } from "./agent/loop"
import { builtins } from "./agent/builtins"
import { Model } from "./agent/model"
import { Registry, type ToolContext } from "./agent/tools"
import { nextLine, closeStdin, runtimeLabel, shellPlan, which } from "./rt/index"
import { Checkpoints } from "./safety/checkpoints"
import { EffectLedger } from "./safety/ledger"
import { MODE_CYCLE, Permissions, type PermissionMode } from "./safety/permissions"
import { Session } from "./session/jsonl"
import { loadUserTheme, resolveTheme, themePath } from "./theme/theme"
import { direction, langPath, loadLanguage, resolveLangCode, t, visual, type PackReport } from "./i18n/index"
import { render, type AppState } from "./app"
import { Terminal } from "./tui/terminal"

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
	console.log(
		JSON.stringify(
			{
				runtime: runtimeLabel(),
				shell: { file: plan.file, name: plan.shell, args: plan.args.slice(0, -1) },
				ripgrep: await which("rg"),
				language: {
					requested: report.code,
					active: report.loaded ? report.code : "en",
					direction: direction(),
					packPath: report.path,
					missingKeys: report.missing.length,
					ignoredKeys: report.ignored,
					...(report.reason ? { reason: report.reason } : {}),
				},
				themePath: themePath(process.env.ORACLE_THEME ?? "user"),
				model: { name: model.name, baseUrl: model.baseUrl },
				endpoint: probe.ok ? "reachable" : { unreachable: probe.reason, hint: probe.hint },
			},
			null,
			2,
		),
	)
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
		console.log(
			JSON.stringify(
				{
					requested: langReport.code,
					active: langReport.loaded ? langReport.code : "en",
					direction: direction(),
					packPath: langReport.path,
					missingKeys: langReport.missing,
					ignoredKeys: langReport.ignored,
					...(langReport.reason ? { reason: langReport.reason } : {}),
				},
				null,
				2,
			),
		)
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
	const permissions = new Permissions(mode, askYesNo)
	const checkpoints = new Checkpoints(session.id)
	const ledger = new EffectLedger(session.id)
	const model = new Model()
	const registry = new Registry().register(...builtins)
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
		mode,
		model: model.name,
		lang: langReport.loaded ? langReport.code : "en",
		busy: false,
		spinnerFrame: 0,
		checkpoints: 0,
		irreversibleEffects: 0,
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
					})
					break
				case "compaction":
					state.entries.push({
						role: "notice",
						text: `${t("contextCompacted")} (${event.droppedToolOutputs}${event.summarized ? " +" : ""})`,
					})
					break
				case "turn.end":
					state.streaming = ""
					state.entries.push({ role: "assistant", text: event.text })
					break
			}
			draw()
		},
	})

	while (true) {
		const raw = await nextLine()
		if (raw === null) break
		const input = raw.trim()
		if (input === "/quit" || input === "/exit") break
		if (input === "/mode") {
			state.mode = permissions.cycle()
			state.entries.push({ role: "notice", text: `${t("permissionMode")}: ${state.mode}` })
			draw()
			continue
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
			continue
		}
		if (input === "/undo") {
			const restored = await checkpoints.undo()
			state.checkpoints = checkpoints.entries().length
			state.entries.push({
				role: "notice",
				text: restored ? `${t("restored")} ${restored}` : t("nothingToUndo"),
			})
			draw()
			continue
		}
		if (!input) continue

		state.entries.push({ role: "user", text: input })
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

	clearInterval(spinner)
	closeStdin()
}

await main()
