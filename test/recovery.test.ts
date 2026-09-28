import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile as readBytes, rm, symlink, writeFile as put } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Checkpoints } from "../src/safety/checkpoints"
import { workspacePath } from "../src/safety/paths"
import { builtins } from "../src/agent/builtins"
import { Registry, executeBatch, type ToolContext } from "../src/agent/tools"
import { Permissions } from "../src/safety/permissions"
import { EffectLedger } from "../src/safety/ledger"
import { Session } from "../src/session/jsonl"

const roots: string[] = []
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "oracle-recovery-"))
	roots.push(root)
	const cwd = join(root, "workspace")
	await mkdir(cwd)
	const base = join(cwd, ".oracle")
	const ctx: ToolContext = { cwd, checkpoints: new Checkpoints("sid", base), permissions: new Permissions("manual", async () => true), ledger: new EffectLedger("sid", base), session: new Session({ baseDir: base, project: "p" }) }
	const call = async (name: string, args: object) => (await executeBatch([{ id: "fixture", name, arguments: JSON.stringify(args) }], new Registry().register(...builtins), ctx))[0]!
	return { root, cwd, base, ctx, call }
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe("recovery and truthful outcomes", () => {
	test("failed exact edit is not green and leaves the file unchanged", async () => {
		const f = await fixture(); await put(join(f.cwd, "a.txt"), "before")
		const out = await f.call("edit", { path: "a.txt", oldString: "absent", newString: "after" })
		expect(out.ok).toBe(false); expect(out.output).toContain("oldString not found")
		expect(await readBytes(join(f.cwd, "a.txt"), "utf8")).toBe("before")
	})
	test("duplicate or empty edit patterns fail without changing content", async () => {
		const f = await fixture(); await put(join(f.cwd, "a.txt"), "x x")
		for (const oldString of ["x", ""]) expect((await f.call("edit", { path: "a.txt", oldString, newString: "y" })).ok).toBe(false)
		expect(await readBytes(join(f.cwd, "a.txt"), "utf8")).toBe("x x")
	})
	test("replacement text is literal, not a JavaScript substitution pattern", async () => {
		const f = await fixture(); await put(join(f.cwd, "a.txt"), "before")
		expect((await f.call("edit", { path: "a.txt", oldString: "before", newString: "$&" })).ok).toBe(true)
		expect(await readBytes(join(f.cwd, "a.txt"), "utf8")).toBe("$&")
	})
	test("nonzero shell exit is a failed tool call", async () => {
		const f = await fixture(); const out = await f.call("bash", { command: "exit 7", timeoutMs: 5000 })
		expect(out.ok).toBe(false); expect(out.output).toContain("exit=7")
	})
	test("binary bytes survive a new checkpoint manager and undo is persisted", async () => {
		const f = await fixture(); const path = join(f.cwd, "binary.bin")
		const original = Buffer.from([0xff, 0xfe, 0, 65, 0x80]); await put(path, original)
		await f.ctx.checkpoints.snapshot(path, "edit"); await put(path, "changed")
		expect(await new Checkpoints("sid", f.base).undo()).toBe(path)
		expect(await readBytes(path)).toEqual(original)
		expect(await new Checkpoints("sid", f.base).undo()).toBeNull()
	})
	test("undo of newly created file survives restart", async () => {
		const f = await fixture(); const path = join(f.cwd, "new.txt")
		await f.ctx.checkpoints.snapshot(path, "write"); await put(path, "new")
		await new Checkpoints("sid", f.base).undo()
		expect(await readBytes(path).then(() => true, () => false)).toBe(false)
	})
	test("tampered recovery blob fails without consuming history", async () => {
		const f = await fixture(); const path = join(f.cwd, "a.txt"); await put(path, "before")
		const e = await f.ctx.checkpoints.snapshot(path, "edit"); await put(path, "after")
		await put(join(f.base, "checkpoints", "sid", "blobs", e.hash), "corrupt")
		let failed = false; try { await new Checkpoints("sid", f.base).undo() } catch { failed = true }
		expect(failed).toBe(true); expect(await readBytes(path, "utf8")).toBe("after")
	})
	test("directory removal is refused", async () => {
		const f = await fixture(); await mkdir(join(f.cwd, "folder")); await put(join(f.cwd, "folder", "keep"), "keep")
		expect((await f.call("rm", { path: "folder" })).ok).toBe(false)
		expect(await readBytes(join(f.cwd, "folder", "keep"), "utf8")).toBe("keep")
	})
	test("checkpoint session ids cannot escape storage", () => {
		for (const id of ["../other", "..", "a/b", "a\\b"]) expect(() => new Checkpoints(id)).toThrow()
	})
})

describe("workspace-scoped file tools", () => {
	test("parent traversal and sibling-prefix paths are denied", async () => {
		const f = await fixture(); const sibling = join(f.root, "workspace-other"); await mkdir(sibling); await put(join(sibling, "private.txt"), "private")
		for (const path of ["../workspace-other/private.txt", join(sibling, "private.txt")]) {
			expect((await f.call("read", { path })).ok).toBe(false)
			expect((await f.call("write", { path, content: "changed" })).ok).toBe(false)
		}
		expect(await readBytes(join(sibling, "private.txt"), "utf8")).toBe("private")
	})
	test("nested file creation remains supported", async () => {
		const f = await fixture(); expect((await f.call("write", { path: "src/new.txt", content: "ok" })).ok).toBe(true)
		expect(await readBytes(join(f.cwd, "src/new.txt"), "utf8")).toBe("ok")
	})
	test("workspace root and control metadata are protected from mutation", async () => {
		const f = await fixture()
		for (const path of [".", ".git/config", ".oracle/effects.jsonl"]) expect((await f.call("write", { path, content: "changed" })).ok).toBe(false)
	})
	test("symlink escape and cyclic glob links are contained", async () => {
		const f = await fixture(); const outside = join(f.root, "outside"); await mkdir(outside); await put(join(outside, "private.txt"), "private")
		// Directory junctions avoid the Windows developer-mode requirement.
		await symlink(outside, join(f.cwd, "escape"), process.platform === "win32" ? "junction" : "dir")
		await symlink(f.cwd, join(f.cwd, "cycle"), process.platform === "win32" ? "junction" : "dir")
		expect((await f.call("read", { path: "escape/private.txt" })).ok).toBe(false)
		expect((await f.call("write", { path: "escape/new.txt", content: "bad" })).ok).toBe(false)
		const result = await f.call("glob", { pattern: "**/*" }); expect(result.ok).toBe(true); expect(result.output).toBe("(no matches)")
	})
	test("prefix check is segment-aware", async () => {
		const f = await fixture(); let failed = false
		try { await workspacePath(f.cwd, `${f.cwd}-suffix/file.txt`) } catch { failed = true }
		expect(failed).toBe(true)
	})
})
