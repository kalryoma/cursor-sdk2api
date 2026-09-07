# Performance diff

Same 11-case `live:timing` suite, `TOOL_BATCH_SETTLE_MS=1500`, idle off. Before early tool streaming (`@cursor/sdk` 1.0.30) vs current (1.0.31). Both 11/11.

**`tool_lead_ms`** is the effect: first streamed tool item → stop. Duration still includes generation and the same 1.5 s settle.

| Case | First tool before → current | Tool lead | Duration |
|---|---:|---:|---:|
| Sonnet Messages single | 7.08s → 5.37s | 0 → **1503 ms** | 7.08s → 6.87s |
| Sonnet Messages parallel | 6.78s → 8.62s | 0 → **2138 ms** | 6.78s → 10.75s |
| Grok Messages single | 33.47s → 2.83s | 0 → **1502 ms** | 33.47s → 4.33s |
| Grok Messages parallel | 5.87s → 4.22s | 0 → **1502 ms** | 5.87s → 5.73s |
| Composer Messages single | 3.84s → 2.95s | 0 → **1501 ms** | 3.84s → 4.45s |
| Composer Messages parallel | 4.46s → 6.76s | 0 → **1501 ms** | 4.46s → 8.26s |
| Sonnet Chat parallel | 6.00s → 5.65s | 0 → **2450 ms** | 6.00s → 8.10s |
| Sonnet Responses parallel | 6.48s → 3.55s | 0 → **2055 ms** | 6.48s → 5.61s |

Before, tools land only in `finish()` (`tool_lead=0`, parallel items as one clump). Current writes each item at `execute()`. Text SSE is unchanged. Duration deltas are generation. `batch_close_wait_ms` on current was 1500–1503 ms every tool case. Grok single on the before side sat 33.5 s before the tool clump — generation, not close policy.

| Client | Per round | 30 rounds |
|---|---|---|
| Starts on the tool item (Codex `output_item.done`) | **1.5 s earlier** (~**2.1–2.5 s** on Sonnet parallel) | Up to ~45 s of tool work overlapped with the wait, if the tools take that long |
| Waits for stop (typical Claude Code) | Tools visible 1.5 s earlier; **round wall-clock unchanged** | **0 s** of settle removed |

`TOOL_BATCH_IDLE_MS=300` (off by default) is the only setting that shortens stop wait (~1.2 s/round); Sonnet parallel batches can split. Settle exists because the SDK still has no generation-end event before local tools run; see Architecture.

## Cursor CLI direct-key baseline

Same three `live:timing` model families, measured on official Cursor CLI (`agent` `2026.09.02-c22c1a3`, `-p --output-format stream-json --stream-partial-output`) with a User API Key and **no** HTTP gateway. Window: 2026-09-07, Node `v22.22.2`, linux x64, 9/9 pass. Re-run with `CURSOR_LIVE_SMOKE=1 npm run live:cli-timing`.

CLI catalog slugs are not the gateway ids. The runner maps them and records both:

| Gateway / live:timing id | CLI `--model` |
|---|---|
| `claude-sonnet-4-6` | `claude-4.6-sonnet-medium` |
| `grok-4.6` | `cursor-grok-4.6-medium` |
| `composer-2.5` | `composer-2.5` |

This is the generation/harness floor the gateway numbers sit on. CLI has no Messages / Chat / Responses split. Text uses `--mode ask`. Tool cases use CLI-native file reads against isolated marker files, not `live_alpha` / `live_beta`. `tool_lead_ms` here is first native tool start → CLI `result` (tool exec + follow-up generation). It is **not** the gateway 1.5 s settle. Gateway `live:timing` tool rows stop when the first tool batch is published; they do not run the tools or a second model turn.

Receipt fields match `live:timing` where they exist: `first_byte_ms` (first thinking or assistant delta), `first_tool_ms`, `tool_lead_ms`, `duration_ms`. The machine JSON stays outside git.

| Case | First byte | First tool | Tool lead | Duration | Result |
|---|---:|---:|---:|---:|---|
| Sonnet CLI text | 8.58s | — | — | 9.32s | pass |
| Sonnet CLI single | 19.00s | 11.23s | **7914 ms** | 19.35s | pass |
| Sonnet CLI parallel | 16.66s | 9.37s | **7363 ms** | 16.90s | pass |
| Grok CLI text | 9.81s | — | — | 10.07s | pass |
| Grok CLI single | 9.30s | 10.51s | **7178 ms** | 17.86s | pass |
| Grok CLI parallel | 10.48s | 11.97s | **15824 ms** | 28.07s | pass |
| Composer CLI text | 9.19s | — | — | 9.41s | pass |
| Composer CLI single | 8.14s | 8.14s | **6972 ms** | 15.30s | pass |
| Composer CLI parallel | 8.24s | 8.24s | **10836 ms** | 19.25s | pass |

Sonnet tool turns streamed the file `read` before any thinking/text (`first_tool` < `first_byte`). Composer started both in the same ~10 ms window. Grok parallel selected two `read`s and also `glob` / `getMcpTools` (spread 8.66 s); treat that extra tool work as model-nondeterministic, not a CLI scheduler claim.

Text is the only same-shaped comparison: one generation, no tools. CLI first byte was 8.6–9.8 s and wall clock 9.3–10.1 s across the three families. Do not subtract the gateway 1.5 s settle from these CLI tool durations; the CLI paid a full agent turn.

Chat and Responses rows in the gateway table have no CLI counterpart.
