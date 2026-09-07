# Live smoke

Opt-in credentialed matrix against a real Cursor catalog. Default CI must not set `CURSOR_LIVE_SMOKE=1`.

The runner never reads `.env`, browser cookies, or files from other projects. It only uses process environment that **you** export in the current shell.

## Invoke

```bash
npm run build
export CURSOR_LIVE_SMOKE=1
export CURSOR_API_KEY=...   # do not commit; do not paste into chat
npm run live:smoke
npm run live:ordinary   # exact-lineage ordinary follow-up only
npm run live:timing     # where a gateway tool round spends its time
npm run live:cli-timing # Cursor CLI direct-key baseline (no HTTP gateway)
```

`live:timing` records first SSE byte, first/last tool item, stop, and gateway
round timings. It forwards `TOOL_BATCH_SETTLE_MS`, `TOOL_BATCH_IDLE_MS`,
`HOST_SYSTEM_PROMPT_MODE`, and `SSE_HEARTBEAT_MS`. `LIVE_TIMING_PROTOCOL_MODEL`
picks the Chat/Responses model (default: the first requested model).
`LIVE_TIMING_REPO_ROOT` / `LIVE_TIMING_ENTRY` point the spawned child at another
built checkout so the same runner can A/B two gateway revisions.

`live:cli-timing` is the same three default models (`claude-sonnet-4-6`,
`grok-4.6`, `composer-2.5`) on official Cursor CLI (`agent -p`,
`CURSOR_API_KEY`). It does not start this gateway. CLI catalog slugs are
mapped (`claude-4.6-sonnet-medium`, `cursor-grok-4.6-medium`,
`composer-2.5`). Text uses `--mode ask`. Tool cases read isolated marker
files through CLI-native tools, not `live_alpha` / `live_beta`. Requires
the `agent` binary on `PATH` or `CURSOR_CLI_BIN`. Receipts stay in a temp
file unless `LIVE_SMOKE_OUTPUT` is set. The published comparison lives in
[`docs/evidence/pr-performance-diff.md`](../../docs/evidence/pr-performance-diff.md).

`live:harness-vs-cli` is the same-work text PONG: Claude Code Messages,
Codex Responses, and Grok Build Responses through this gateway versus
official Cursor CLI. Fast is requested on both sides when the catalog
exposes it. Do not compare its durations to `live:timing` tool rows.

`live:pr2-e2e` is the same three pairs on a finished agent task: generate a
summary report of this repo's PR #2. The gateway side runs a client tool
loop (`pr_metadata`, `pr_files`, `pr_diff`, `read_repo_file`). The CLI
side is `agent -p` against this workspace with sandbox disabled so `gh`
can reach GitHub. Receipts keep timings, tool names, and report length.
`LIVE_E2E_PR` overrides the PR number (default 2). `LIVE_E2E_REPEATS`
runs each side N times (default 1). When N≥3 the receipt stores every
sample and a per-metric trimmed mean (drop one min and one max). Default
per-request timeout is 240000. `LIVE_E2E_MATRIX=grok-harness` (or
`npm run live:pr2-e2e-grok`) holds Grok 4.6 fixed and compares Claude
Code Messages, Codex Responses, Grok Build Responses, and raw Cursor CLI
on the same PR #2 summary. Do not commit the generated report text.

Optional:

- `GATEWAY_BASE_URL` — attach to an already running gateway instead of spawning `dist/index.js` on `127.0.0.1`. Restart cases are `not_run` and the process exits `2` (incomplete), not green.
- `LIVE_SMOKE_MODELS` — comma list; default `claude-sonnet-4-6,claude-fable-5,grok-4.6,composer-2.5`.
- `LIVE_SMOKE_OUTPUT` — receipt path. Default is a temp file, not the repository.
- `LIVE_SMOKE_TIMEOUT_MS` — per-request timeout (default 180000).

Child mode binds **127.0.0.1** on a free port, uses isolated temp `STATE_DIR` / workspace, SIGTERM on exit, then deletes the temp dirs.

## What it checks

Per resolved catalog id: authenticated `/v1/models`, non-stream text, SSE shape, single tool continuation, parallel two-tool batch, multi-round two batches, in-process duplicate-same replay, pending `tool_result` recovery after a hard restart, full-transcript cold recovery after deleting lineage, and completed `x-cursor-session-id` resume after restart. Fable also sends a Claude Code-style Messages header/body shape.

Catalog-missing required names are `catalog_missing` failures, not skips. Capability skips happen only when the live catalog lists parameters and omits that capability.

Stdout is pass/fail/timings/model/status/error type only. Receipts are redacted JSON. The runner does not call `/v1/account` and does not keep prompt/tool/assistant bodies.

## Not claimed

This document does not record any live model result. Running the script requires an explicitly supplied test credential.
