# Oracle Code

Local-first terminal coding agent. Bun + TypeScript, zero runtime dependencies.

**Repo policy:** code only. All design notes, protocols and state logs live in Notion, not here.

## Evidence tags used in code comments

- `FACT` — behaviour documented by an upstream vendor or verifiable from a spec.
- `DERIVED` — reconstructed from community reverse-engineering; unstable across builds.
- `UNKNOWN` — not verified here. Never treated as a contract.

No performance number is asserted in this repo unless it is produced by `bun run bench` on the
authoritative machine and written into the run's JSONL record. `bench/frame.ts` prints raw samples,
not marketing claims.

## Measured

One number exists. Frame pipeline, `bench/frame.ts`, 200x120 cells, 600 frames, bun 1.4.2,
linux-x64: total p50 2.254 ms, of which paint 2.239, blit 0.011, diff 0.001, write 0.000.

No Windows number has been produced. No head-to-head run against any other tool exists. Every cell
in the comparison table below is therefore a structural claim about implementation, not a
measurement, and the column describing the reference tool is `DERIVED` throughout.

## Language

The shipped interface is English only. `src/i18n/` will load one optional user pack from
`~/.oracle/lang/<code>.json`; a pack with missing or unknown keys is reported and refused rather
than half-applied, and `oc lang` prints which pack resolved and why. No translation ships in the
binary.

## Why this exists (and where it aims to beat the reference tool)

The transferable idea in a terminal agent is not the UI framework. It is the pipeline:
packed cell store -> damage rectangle -> cell-level diff -> single synchronized write.
This repo implements that pipeline directly and adds the parts the reference tool does not do.

| Axis | Reference tool (Claude Code) | Oracle Code |
| --- | --- | --- |
| Render stack | React + `react-reconciler` + JS Yoga port (DERIVED) | Retained node tree, no React, no reconciler — one dependency-free layout pass |
| Cell store | Packed typed arrays + interning pools (DERIVED) | Same model, implemented in the open: `CharPool`, `StylePool` (bit 0 = visible-on-space), `HyperlinkPool`, pools shared across front/back frames |
| Arabic / RTL | UNKNOWN — fixed-width cell grid does no joining or bidi | A text layer, not a translated UI: contextual shaping (Presentation Forms-B), lam-alef ligatures, zero-width combining marks, UAX#9-subset reordering, per-paragraph base direction. Shaping is not width preserving — a lam-alef pair collapses two code points into one cell — and one case in the shaper's skip loop is still `UNKNOWN` |
| CJK / emoji | ASCII fast path, wide chars fall back to a map | Explicit width table, wide cells reserve a continuation cell so the grid never desynchronizes |
| Model backend | Vendor API only | Any OpenAI-compatible endpoint; defaults to a local `khz` / llama.cpp server. Offline is the normal case, not degraded mode |
| Sessions | JSONL under a home directory (FACT) | JSONL plus content-addressed blobs for large tool payloads, so replay stays cheap and `jq`-inspectable |
| Frame telemetry | Internal | Every frame's damage area, patch bytes and duration is appendable to the session JSONL — measurement is a product feature, not a guess |
| Irreversible effects | File checkpoints; remote effects governed by permissions (FACT) | Same split, made explicit: a persisted effect ledger records every non-undoable action with the permission decision that allowed it |
| MCP schemas | Deferred, loaded on demand (FACT) | Deferred plus a capability firewall: a server must declare `readOnlyHint` to be eligible for parallel execution, and unknown tools are quarantined until approved |
| Input | Raw-mode line editor (DERIVED) | Raw-mode key parser and line editor implemented in the open: cursor movement, ^A/^E/^U/^K/^W, ↑/↓ history persisted through the session JSONL, `"""` multiline blocks, PageUp/PageDown scrollback |
| Language intelligence | Vendor LSP integration (DERIVED) | A ~200-line JSON-RPC/stdio LSP client, zero dependencies: `diagnostics`, `definition`, `references`, `symbols`, `rename` tools when `typescript-language-server`, `pyright-langserver`, `rust-analyzer` or `gopls` is on PATH; diagnostics are injected into every `write`/`edit` result so the model sees breakage in the same turn that caused it |
| Filler | UNKNOWN | The system prompt forbids preamble and pleasantries, `max_tokens` (ORACLE_MAX_ANSWER_TOKENS) enforces a hard cap, and a post-turn detector records every filler hit in the session JSONL and counts it on the status line — measured, not assumed |

## Model endpoint and egress

`ORACLE_BASE_URL` accepts any OpenAI-compatible URL, and `ORACLE_API_KEY` is sent as a bearer
header to whatever that URL names. There is no allowlist and no loopback pin: the default is local,
and egress is one environment variable away. `oc doctor` prints the resolved endpoint, whether it
answered, and what it is serving.

## Layout

```
src/tui/        pools, packed screen, damage diff, optimizer, ANSI writer, layout, widgets, key parser, line editor, code highlighting
src/text/       width table, Arabic shaping, bidi reordering
src/agent/      context -> execute -> verify loop, tool registry and scheduler, LSP tools, filler detector
src/lsp/        raw JSON-RPC/stdio LSP client, server registry, workspace-edit application
src/session/    append-only JSONL sessions, resume and fork
src/safety/     checkpoints, effect ledger, permission modes
src/mcp/        stdio MCP client with lazy schema loading
src/theme/      built-in themes, COLORFGBG auto-detection, user JSON overrides
src/i18n/       English strings, optional user pack, pack validation
src/rt/         runtime layer: paths, spawn, shell plan, file scan, raw stdin — Bun and Node, Linux and Windows
src/app.ts      wiring: model, tools, screen, session, permissions
src/index.ts    CLI entry: oc, doctor, lang, sessions, theme --lint
bench/frame.ts  raw frame samples, the only authorized source of performance numbers
test/           14 files
```

## Run

```sh
bun install
bun test
bun run dev
```

Without bun, on Node 20.11 or newer:

```sh
npm install --no-audit --no-fund
npm run test:node
npx tsx src/index.ts doctor
```

`oc doctor` is the first thing to run on a new machine. It reports the runtime, the resolved shell
plan, whether ripgrep is on PATH, which language servers are on PATH, the active language and where
it came from, the theme path, and whether the model endpoint answered — and if it did not, it names
the reason rather than the symptom.

## What runs on every push

`.github/workflows/test.yml`, matrix `ubuntu-latest` and `windows-latest`, `fail-fast: false`:

- bun job: `bun install`, `bun test`, `bun x tsc --noEmit`
- node job: `npm install --no-audit --no-fund`, `npm run test:node`

Four jobs. A claim in this file that no job covers is a claim, not a contract.
