// Portability check: runs under plain Node, on Linux and on Windows, with no
// test framework and no bun:test import.
//
// The bun test suite covers behaviour. This file answers a narrower question:
// does the runtime layer actually work on this engine and this operating
// system? It prints CHECKS and FAILS and exits non-zero on any failure, so CI
// on windows-latest either proves the port or refuses the build.

import { mkdtempSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	exists,
	globFiles,
	globToRegExp,
	isWindows,
	readText,
	runtimeLabel,
	sha256hex,
	shellPlan,
	spawnCapture,
	toPosix,
	which,
	writeText,
} from "../src/rt/index.js"
import { Checkpoints } from "../src/safety/checkpoints.js"
import { Session } from "../src/session/jsonl.js"
import { themePath } from "../src/theme/theme.js"

let checks = 0
let fails = 0

function check(name: string, ok: boolean, got?: unknown): void {
	checks++
	if (ok) {
		console.log(`ok   ${name}`)
	} else {
		fails++
		console.log(`FAIL ${name}${got === undefined ? "" : ` got=${JSON.stringify(got)}`}`)
	}
}

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p))

console.log(`RUNTIME ${runtimeLabel()}`)
console.log(`WINDOWS ${isWindows}`)

// 1. hashing
check("sha256(abc)", sha256hex("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")

// 2. shell selection matches the host
const plan = shellPlan("echo oracle")
check("shell is not bash on windows", isWindows ? !plan.args.includes("-lc") : true, plan.args)
const run = await spawnCapture(plan.file, plan.args, { timeoutMs: 60_000 })
check("host shell exit code 0", run.code === 0, run.code)
check("host shell captured stdout", run.stdout.includes("oracle"), run.stdout.trim())

// 3. missing binary does not throw
const missing = await spawnCapture("oracle-nonexistent-binary", [])
check("missing binary reports 127", missing.code === 127, missing.code)

// 4. PATH lookup on the real host PATH
const hostTool = isWindows ? "cmd" : "sh"
check(`which(${hostTool}) resolves`, (await which(hostTool)) !== null)

// 5. glob semantics
check("globstar", globToRegExp("src/**/*.ts").test("src/tui/screen.ts"))
check("star stops at separator", !globToRegExp("*.ts").test("src/a.ts"))
check("posix normalisation", !toPosix(join("src", "a.ts")).includes("\\"))

// 6. real filesystem round trip in a temp tree
const cwd = tmp("oc-port-")
await writeText(join(cwd, "src", "a.ts"), "const a = 1\n")
check("write then read", (await readText(join(cwd, "src", "a.ts"))).startsWith("const a"))
check(
	"glob finds the file",
	(await globFiles("src/**/*.ts", cwd)).join(",") === "src/a.ts",
	await globFiles("src/**/*.ts", cwd),
)

// 7. checkpoints under a session id that contains colons
const base = join(cwd, ".oracle")
const ck = new Checkpoints(new Date().toISOString(), base)
const target = join(cwd, "b.txt")
await writeText(target, "before")
await ck.snapshot(target, "edit")
await writeText(target, "after")
check("undo restores bytes", (await ck.undo()) === target && (await readText(target)) === "before")

// 8. sessions, blobs and fork inside the same root
const session = new Session({ baseDir: base, project: "p" })
await session.append("user", { text: "hi" })
const big = await session.append("tool.result", { text: "x".repeat(5000) })
check("large payload externalised", typeof (big.data as { blob?: string }).blob === "string")
const child = await session.fork(1)
check("fork stays under the store root", child.file.startsWith(base), child.file)
check("fork transcript truncated", (await child.read()).length === 1)
check("session store lists both", (await Session.list(base)).length >= 2)

// 9. paths that used to interpolate undefined on windows
check("theme path has no undefined", !themePath().includes("undefined"), themePath())

// 10. blob store really exists on disk
check(
	"blob file present",
	await exists(join(base, "sessions", "p", "blobs", sha256hex(JSON.stringify({ text: "x".repeat(5000) })))),
)

await writeFile(join(cwd, "done"), "")
console.log(`\nCHECKS ${checks}`)
console.log(`FAILS  ${fails}`)
process.exit(fails > 0 ? 1 : 0)
