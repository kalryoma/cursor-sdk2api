# Performance diff redo — `6951f1b` vs current

Same 11-case `npm run live:timing` suite as [2026-09-06-pr-performance-diff.md](2026-09-06-pr-performance-diff.md). One client (`tests/live-smoke/timing.ts` on this branch) spawned each gateway in turn: detached `6951f1b` (`@cursor/sdk` 1.0.30, before PR #2) then this tree (`@cursor/sdk` 1.0.31). Production `TOOL_BATCH_SETTLE_MS=1500`, idle off. Sequential on one machine. Both sides 11/11 pass.

The Codex top-level `namespace` parse on this branch is kept. Default Codex CLI 0.153 still sends those wrappers on `/v1/responses`; without the flatten the first `codex exec` request is 422. That path is not on the timing suite (plain `type: "function"` tools only) and is not a streaming change.

**`tool_lead_ms`** is the PR #2 effect: first streamed tool item → stop. `duration_ms` still includes model generation and the same 1.5 s settle.

| Case | First tool `6951f1b` → current | Tool lead | Duration |
|---|---:|---:|---:|
| Sonnet Messages single | 7.08s → 5.37s | 0 → **1503 ms** | 7.08s → 6.87s |
| Sonnet Messages parallel | 6.78s → 8.62s | 0 → **2138 ms** | 6.78s → 10.75s |
| Grok Messages single | 33.47s → 2.83s | 0 → **1502 ms** | 33.47s → 4.33s |
| Grok Messages parallel | 5.87s → 4.22s | 0 → **1502 ms** | 5.87s → 5.73s |
| Composer Messages single | 3.84s → 2.95s | 0 → **1501 ms** | 3.84s → 4.45s |
| Composer Messages parallel | 4.46s → 6.76s | 0 → **1501 ms** | 4.46s → 8.26s |
| Sonnet Chat parallel | 6.00s → 5.65s | 0 → **2450 ms** | 6.00s → 8.10s |
| Sonnet Responses parallel | 6.48s → 3.55s | 0 → **2055 ms** | 6.48s → 5.61s |

Grok Messages single on `6951f1b` waited 33.5 s before the tool clump (`first_byte` 1.9 s). That is generation, not close policy; `tool_lead` stayed 0.

On `6951f1b`, tools are written only in `finish()` when the batch closes (`tool_lead=0`, parallel items as one clump). Current writes each item at `execute()`. Text SSE is unchanged (Sonnet 3.0s → 2.8s, Grok 1.4s → 1.3s, Composer 1.5s → 1.3s). Duration deltas are generation plus the same 1.5 s settle, not a faster or slower close. `batch_close_wait_ms` on current was 1500–1503 ms on every tool case.

| Client | Per round | 30 rounds |
|---|---|---|
| Starts on the tool item (Codex `output_item.done`) | **1.5 s earlier** (about **2.1–2.5 s** on Sonnet parallel) | Up to ~45 s of tool work overlapped with the wait, if the tools take that long |
| Waits for stop (typical Claude Code) | Tools visible 1.5 s earlier; **round wall-clock unchanged** | **0 s** of settle removed |

Optional `TOOL_BATCH_IDLE_MS=300` (off by default) is the only setting that shortens stop wait (~1.2 s/round); Sonnet parallel batches can split.

Receipts stay out of git (timings and event names only; no key, prompt, or tool payload).
