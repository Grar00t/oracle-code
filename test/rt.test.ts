// Cross-platform runtime tests.
//
// Every case here failed, or could not even be written, before src/rt existed:
// the tree called Bun.* directly, so there was nothing to substitute and
// nothing to assert about Windows behaviour from a Linux runner.

import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { writeFile as nodeWrite } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	__pushLine,
	exists,
	globToRegExp,
	nextLine,
	readText,
	sha256hex,
	shellPlan,
	spawnCapture,
	toPosix,
	which,
	writeText,
} from "../src/rt/index"
import { Checkpoints } from "../src/safety/checkpoints"
import { Session, projectKey, sessionIdFor } from "../src/session/jsonl"
import { bash, editFile, globFiles, readFile, writeFile } from "../src/agent/builtins"
import { themePath } from "../src/theme/theme"
import { McpClient } from "../src/mcp/client"

function tmp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix))
}

describe("R1 shell selection", () => {
	test("windows falls back to ComSpec with cmd switches", () => {
		const plan = shellPlan("dir", "win32", { ComSpec: "C:\\Windows\\system32\\cmd.exe" })
		expect(plan.file).toBe("C:\\Windows\\system32\\cmd.exe")
		expect(plan.args).toEqual(["/d", "/s", "/c", "dir"])
		expect(plan.shell).toBe("cmd")
	})

	test("windows never selects bash -lc", () => {
		const plan = shellPlan("echo hi", "win32", {})
		expect(plan.args.includes("-lc")).toBe(false)
	})

	test("windows honours a PowerShell override", () => {
		const plan = shellPlan("Get-ChildItem", "win32", { ORACLE_SHELL: "pwsh.exe" })
		expect(plan.shell).toBe("powershell")
		expect(plan.args).toEqual(["-NoLogo", "-NoProfile", "-Command", "Get-ChildItem"])
	})

	test("bash gets -lc and dash gets -c", () => {
		expect(shellPlan("ls", "linux", { SHELL: "/bin/bash" }).args).toEqual(["-lc", "ls"])
		expect(shellPlan("ls", "linux", { SHELL: "/bin/sh" }).args).toEqual(["-c", "ls"])
	})
})

describe("R2 hashing and ids", () => {
	test("sha256 matches the published digest for abc", () => {
		expect(sha256hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
	})

	test("session ids contain no character illegal in a windows path", () => {
		const id = sessionIdFor(new Date("2026-09-06T15:04:05.123Z"), "0189d0aa-1111-7000-8000-000000000000")
		expect(/[:*?"<>|]/.test(id)).toBe(false)
		expect(id.startsWith("2026-09-06T15-04-05-123Z-")).toBe(true)
	})

	test("project keys survive a drive-letter path", () => {
		expect(/[\\/:]/.test(projectKey("C:\\Users\\a\\work"))).toBe(false)
	})
})

describe("R3 glob", () => {
	test("star does not cross a separator", () => {
		const re = globToRegExp("*.ts")
		expect(re.test("a.ts")).toBe(true)
		expect(re.test("src/a.ts")).toBe(false)
	})

	test("globstar matches zero or more directories", () => {
		const re = globToRegExp("src/**/*.ts")
		expect(re.test("src/a.ts")).toBe(true)
		expect(re.test("src/tui/screen.ts")).toBe(true)
		expect(re.test("test/a.ts")).toBe(false)
	})

	test("dots in the pattern are literal", () => {
		expect(globToRegExp("a.ts").test("axts")).toBe(false)
	})

	test("backslash paths are compared as posix", () => {
		expect(toPosix("src\\tui\\screen.ts").includes("\\")).toBe(false)
	})
})

describe("R4 PATH lookup", () => {
	test("an executable is found in a PATH directory", async () => {
		const dir = tmp("oc-path-")
		await nodeWrite(join(dir, "faketool"), "#!/bin/sh\n")
		expect(await which("faketool", { PATH: dir })).toBe(join(dir, "faketool"))
	})

	test("a missing executable resolves to null, not a throw", async () => {
		expect(await which("oracle-nonexistent-binary", { PATH: tmp("oc-empty-") })).toBeNull()
	})
})

describe("R5 process capture", () => {
	test("the platform shell runs a command and returns its output", async () => {
		const plan = shellPlan("echo oracle")
		const res = await spawnCapture(plan.file, plan.args, { timeoutMs: 20_000 })
		expect(res.code).toBe(0)
		expect(res.stdout.includes("oracle")).toBe(true)
	})

	test("a missing executable reports 127 instead of crashing the agent", async () => {
		const res = await spawnCapture("oracle-nonexistent-binary", [])
		expect(res.code).toBe(127)
	})
})

describe("R6 checkpoints", () => {
	test("undo restores the previous bytes", async () => {
		const base = tmp("oc-ckpt-")
		const file = join(base, "a.txt")
		await writeText(file, "before")
		const ck = new Checkpoints("2026-09-06T15:04:05.123Z-abc", join(base, ".oracle"))
		await ck.snapshot(file, "edit")
		await writeText(file, "after")
		const restored = await ck.undo()
		expect(restored).toBe(file)
		expect(await readText(file)).toBe("before")
	})

	test("undo of a created file removes it again", async () => {
		const base = tmp("oc-ckpt2-")
		const file = join(base, "new.txt")
		const ck = new Checkpoints("sid", join(base, ".oracle"))
		await ck.snapshot(file, "write")
		await writeText(file, "created")
		await ck.undo()
		expect(await exists(file)).toBe(false)
	})
})

describe("R7 sessions", () => {
	test("small payloads stay inline and big ones move to a blob", async () => {
		const base = join(tmp("oc-sess-"), ".oracle")
		const s = new Session({ baseDir: base, project: "p" })
		await s.append("user", { text: "hi" })
		const big = await s.append("tool.result", { text: "x".repeat(5000) })
		const data = big.data as { blob?: string; bytes?: number }
		expect(typeof data.blob).toBe("string")
		expect(await s.resolve(big)).toEqual({ text: "x".repeat(5000) })
		const records = await s.read()
		expect(records).toHaveLength(2)
	})

	test("a fork stays inside the same store root", async () => {
		const base = join(tmp("oc-fork-"), ".oracle")
		const s = new Session({ baseDir: base, project: "p" })
		await s.append("user", { text: "one" })
		await s.append("user", { text: "two" })
		const child = await s.fork(1)
		expect(child.file.startsWith(base)).toBe(true)
		expect(await child.read()).toHaveLength(1)
		expect((await Session.list(base)).length).toBeGreaterThanOrEqual(2)
	})
})

describe("R8 one stdin reader", () => {
	test("two concurrent readers each get their own line, in order", async () => {
		const first = nextLine()
		const second = nextLine()
		__pushLine("y")
		__pushLine("next task")
		expect(await first).toBe("y")
		expect(await second).toBe("next task")
	})

	test("a line typed before anyone waits is queued, not lost", async () => {
		__pushLine("early")
		expect(await nextLine()).toBe("early")
	})
})

describe("R9 builtin tools end to end", () => {
	test("write, read, edit and glob work through the runtime layer", async () => {
		const cwd = tmp("oc-tools-")
		const base = join(cwd, ".oracle")
		const ctx = {
			cwd,
			checkpoints: new Checkpoints("sid", base),
			session: new Session({ baseDir: base, project: "p" }),
			permissions: null,
			ledger: null,
		} as any
		expect(await writeFile.run({ path: "src/a.ts", content: "const a = 1\n" }, ctx)).toContain("wrote src/a.ts")
		expect(await readFile.run({ path: "src/a.ts" }, ctx)).toBe("1\tconst a = 1\n2\t")
		expect(await editFile.run({ path: "src/a.ts", oldString: "1", newString: "2" }, ctx)).toContain("edited")
		expect(await globFiles.run({ pattern: "src/**/*.ts" }, ctx)).toBe("src/a.ts")
	})

	test("the shell tool reports the shell it used", async () => {
		const cwd = tmp("oc-bash-")
		const ctx = { cwd } as any
		const out = await bash.run({ command: "echo oracle" }, ctx)
		expect(out.includes("exit=0")).toBe(true)
		expect(out.includes("shell=")).toBe(true)
		expect(out.includes("oracle")).toBe(true)
	})
})

describe("R10 paths and dead servers", () => {
	test("the theme path is absolute without depending on $HOME", () => {
		const path = themePath("user")
		expect(path.includes("undefined")).toBe(false)
		expect(path.endsWith(join(".oracle", "themes", "user.json"))).toBe(true)
	})

	test("a server that dies rejects its in-flight request instead of hanging", async () => {
		// A real child that exits immediately. Before the exit handler existed the
		// initialize request sat in the pending map for the full 30s timeout.
		const client = new McpClient("stub", ["node", "-e", "process.exit(0)"])
		const started = Date.now()
		let message = ""
		try {
			await client.start()
		} catch (error) {
			message = (error as Error).message
		}
		expect(message.includes("stub")).toBe(true)
		expect(client.inFlight()).toBe(0)
		expect(Date.now() - started).toBeLessThan(10_000)
		client.stop()
	})
})
