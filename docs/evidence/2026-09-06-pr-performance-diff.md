# Performance diff — `main` vs this PR

Same 11-case live suite, production `TOOL_BATCH_SETTLE_MS=1500`, idle off. `main` `6951f1b` (`@cursor/sdk` 1.0.30) vs this branch (1.0.31), re-run after the prompt-binding and journal carry-over fixes. Both sides 11/11 pass.

**`tool_lead_ms`** is the PR effect: first streamed tool item → stop. `duration_ms` still includes model generation and the same 1.5 s settle.

| Case | First tool `main` → PR | Tool lead | Duration |
|---|---:|---:|---:|
| Sonnet Messages single | 6.56s → 4.15s | 0 → **1502 ms** | 6.56s → 5.65s |
| Sonnet Messages parallel | 7.23s → 4.06s | 1 → **2130 ms** | 7.23s → 6.19s |
| Grok Messages single | 4.17s → 2.51s | 0 → **1500 ms** | 4.17s → 4.01s |
| Grok Messages parallel | 6.29s → 3.75s | 0 → **1501 ms** | 6.29s → 5.26s |
| Composer Messages single | 4.03s → 2.16s | 0 → **1501 ms** | 4.03s → 3.66s |
| Composer Messages parallel | 4.02s → 4.87s | 0 → **1501 ms** | 4.02s → 6.37s |
| Sonnet Chat parallel | 8.11s → 6.19s | 0 → **2293 ms** | 8.11s → 8.48s |
| Sonnet Responses parallel | 7.34s → 5.71s | 0 → **2263 ms** | 7.34s → 7.98s |

On `main`, tools are written only in `finish()` when the batch closes (`tool_lead=0`, parallel items as one clump). This PR writes each item at `execute()`. Text SSE is unchanged. Duration deltas (−1.0 s to +2.3 s) are generation, not a faster or slower close.

| Client | Per round | 30 rounds |
|---|---|---|
| Starts on the tool item (Codex `output_item.done`) | **1.5 s earlier** (about **2.1–2.3 s** on Sonnet parallel) | Up to ~45 s of tool work overlapped with the wait, if the tools take that long |
| Waits for stop (typical Claude Code) | Tools visible 1.5 s earlier; **round wall-clock unchanged** | **0 s** of settle removed |

Optional `TOOL_BATCH_IDLE_MS=300` (off by default) is the only setting that shortens stop wait (~1.2 s/round); Sonnet parallel batches can split.
