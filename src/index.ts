#!/usr/bin/env node
// Oracle Code entry point.
//
//   oc "prompt"           one-shot, prints the final answer
//   oc                    interactive session
//   oc sessions           list session transcripts
//   oc theme --lint FILE  report which theme keys would be ignored
//   oc doctor             print engine, platform, shell and endpoint status
//
// Runs under Bun and under Node, on Linux, macOS and Windows. Anything
// engine-specific or platform-specific lives in src/rt.

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
	process.stdout.write(`\n${question} [y/N] `)
	const line = await nextLine()
	return (line ?? "").trim().toLowerCase().startsWith("y")
}

async function doctor(): Promise<void> {
	const plan = shellPlan("echo ok")
	const model = new Model()
	const probe = await model.probe()
	console.log(
		JSON.stringify(
			{
				runtime: runtimeLabel(),
				shell: { file: plan.file, name: plan.shell, args: plan.args.slice(0, -1) },
				ripgrep: await which("rg"),
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

	if (argv[0] === "sessions") {
		const list = await Session.list()
		console.log(list.length ? list.join("\n") : "no sessions yet")
		return
	}

	if (argv[0] === "doctor") {
		await doctor()
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
			process.stderr.write(`model endpoint unreachable\n  ${reachable.reason}\n  ${reachable.hint}\n`)
			process.exitCode = 1
			return
		}
		const agent = new Agent(model, registry, ctx, {
			onEvent: (event) => {
				if (event.type === "token") process.stdout.write(event.text)
				if (event.type === "tool.end")
					process.stderr.write(`\n[${event.ok ? "ok" : "fail"}] ${event.name} ${event.durationMs.toFixed(0)}ms\n`)
			},
		})
		await agent.run(oneShot)
		process.stdout.write("\n")
		const irreversible = ledger.irreversible()
		if (irreversible.length) {
			process.stderr.write(`\n${irreversible.length} irreversible effect(s) recorded in .oracle/effects.jsonl\n`)
		}
		closeStdin()
		return
	}

	// Interactive mode.
	const term = new Terminal({ alternateScreen: true })

	const served = reachable.ok && reachable.models.length ? ` \u00b7 serving ${reachable.models.join(", ")}` : ""
	const entries: AppState["entries"] = [
		{
			role: "notice",
			text: reachable.ok
				? `oracle-code \u00b7 ${model.name} @ ${model.baseUrl} \u00b7 mode ${mode}${served}`
				: `oracle-code \u00b7 ${model.name} @ ${model.baseUrl} \u00b7 mode ${mode} \u00b7 endpoint unreachable`,
		},
		{ role: "notice", text: `runtime ${runtimeLabel()}` },
	]
	if (!reachable.ok) {
		entries.push({ role: "notice", text: reachable.reason })
		entries.push({ role: "notice", text: reachable.hint })
	}
	entries.push({
		role: "notice",
		text: "type a task, /mode to cycle permissions, /undo to restore, /quit to exit",
	})

	const state: AppState = {
		entries,
		streaming: "",
		input: "",
		mode,
		model: model.name,
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
						parallel: false,
					})
					break
				case "compaction":
					state.entries.push({
						role: "notice",
						text: `context compacted (${event.droppedToolOutputs} tool outputs elided${event.summarized ? ", summarized" : ""})`,
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
			state.entries.push({ role: "notice", text: `permission mode: ${state.mode}` })
			draw()
			continue
		}
		if (input === "/undo") {
			const restored = await checkpoints.undo()
			state.checkpoints = checkpoints.entries().length
			state.entries.push({
				role: "notice",
				text: restored ? `restored ${restored}` : "nothing to undo",
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
			state.entries.push({ role: "notice", text: `error: ${(error as Error).message}` })
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
