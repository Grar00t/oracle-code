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

## Why this exists (and where it aims to beat the reference tool)

The transferable idea in a terminal agent is not the UI framework. It is the pipeline:
packed cell store -> damage rectangle -> cell-level diff -> single synchronized write.
This repo implements that pipeline directly and adds the parts the reference tool does not do.

| Axis | Reference tool (Claude Code) | Oracle Code |
| --- | --- | --- |
| Render stack | React + `react-reconciler` + JS Yoga port (DERIVED) | Retained node tree, no React, no reconciler — one dependency-free layout pass |
| Cell store | Packed typed arrays + interning pools (DERIVED) | Same model, implemented in the open: `CharPool`, `StylePool` (bit 0 = visible-on-space), `HyperlinkPool`, pools shared across front/back frames |
| Arabic / RTL | UNKNOWN — fixed-width cell grid does no joining or bidi | First-class: contextual shaping (Presentation Forms-B), lam-alef ligatures, zero-width combining marks, UAX#9-subset reordering, per-paragraph base direction |
| CJK / emoji | ASCII fast path, wide chars fall back to a map | Explicit width table, wide cells reserve a continuation cell so the grid never desynchronizes |
| Model backend | Vendor API only | Any OpenAI-compatible endpoint; defaults to a local `khz` / llama.cpp server. Offline is the normal case, not degraded mode |
| Sessions | JSONL under a home directory (FACT) | JSONL plus content-addressed blobs for large tool payloads, so replay stays cheap and `jq`-inspectable |
| Frame telemetry | Internal | Every frame's damage area, patch bytes and duration is appendable to the session JSONL — measurement is a product feature, not a guess |
| Irreversible effects | File checkpoints; remote effects governed by permissions (FACT) | Same split, made explicit: a persisted effect ledger records every non-undoable action with the permission decision that allowed it |
| MCP schemas | Deferred, loaded on demand (FACT) | Deferred plus a capability firewall: a server must declare `readOnlyHint` to be eligible for parallel execution, and unknown tools are quarantined until approved |

## Layout

```
src/tui/       pools, packed screen, damage diff, optimizer, ANSI writer, layout, widgets
src/text/      width table, Arabic shaping, bidi reordering
src/agent/     context -> execute -> verify loop, tool registry and scheduler
src/session/   append-only JSONL sessions, resume and fork
src/safety/    checkpoints, effect ledger, permission modes
src/mcp/       stdio MCP client with lazy schema loading
src/theme/     built-in themes, COLORFGBG auto-detection, user JSON overrides
```

## Run

```sh
bun install
bun test
bun run dev
```
