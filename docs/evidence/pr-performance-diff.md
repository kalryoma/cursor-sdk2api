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
