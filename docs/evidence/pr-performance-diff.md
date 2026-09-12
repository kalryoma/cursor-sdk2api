# Performance diff

## 2026-09-12 — signal-driven close and turn-ended

Same 11-case `live:timing` suite. **main** `1684b1d` (settle 1500, idle off) vs this PR (idle 200, announce / `step-completed` close, final on `turn-ended`). Both 11/11. Full receipt: [2026-09-12-streaming-responsiveness-diff.md](2026-09-12-streaming-responsiveness-diff.md).

**`batch_close_wait_ms`** is the effect: 1500–1502 ms settle on every main tool case → **200–234 ms** idle on the PR. Live `step-completed` did not beat the 200 ms idle in this sample. Sonnet `announce_lead_ms` was 0–2 ms.

| Case | close_wait | Tool lead | Duration |
|---|---:|---:|---:|
| Sonnet Messages single | 1502 → **201 ms** | 1504 → **203 ms** | 8.78s → 4.95s |
| Sonnet Messages parallel | 1500 → **200 ms** | 2077 → **774 ms** | 6.16s → 4.44s |
| Grok Messages single | 1500 → **224 ms** | 1502 → **226 ms** | 5.42s → 3.64s |
| Grok Messages parallel | 1500 → **227 ms** | 1501 → **228 ms** | 6.86s → 3.72s |
| Composer Messages single | 1500 → **234 ms** | 1501 → **236 ms** | 3.87s → 2.49s |
| Composer Messages parallel | 1500 → **222 ms** | 1502 → **223 ms** | 4.46s → 2.53s |
| Sonnet Chat parallel | 1501 → **209 ms** | 2457 → **210 ms** | 5.68s → 6.34s |
| Sonnet Responses parallel | 1501 → **208 ms** | 2457 → **209 ms** | 7.89s → 5.90s |

Text SSE stop after the last token: Sonnet 122 → **12 ms**, Grok 76 → **4 ms**, Composer 96 → **21 ms**. PR `publish_lag_ms` on those turns was 0–1 ms (`turn-ended`). Chat/Responses on the PR selected 1 of 2 tools — duration there is generation, not close policy.

| Client | Per tool round | 30 rounds |
|---|---|---|
| Waits for stop (typical Claude Code) | **~1.3 s faster** | **~39 s** of settle removed |
| Starts on the tool item (Codex) | `response.completed` **~1.3 s earlier** | same ~39 s of blocked continuation removed |

## Previous — early tool streaming (SDK 1.0.30 → 1.0.31)

Same suite, `TOOL_BATCH_SETTLE_MS=1500`, idle off. Before early tool streaming (`@cursor/sdk` 1.0.30) vs 1.0.31. Both 11/11.

**`tool_lead_ms`** is the effect: first streamed tool item → stop. Duration still included generation and the same 1.5 s settle.

| Case | First tool before → 1.0.31 | Tool lead | Duration |
|---|---:|---:|---:|
| Sonnet Messages single | 7.08s → 5.37s | 0 → **1503 ms** | 7.08s → 6.87s |
| Sonnet Messages parallel | 6.78s → 8.62s | 0 → **2138 ms** | 6.78s → 10.75s |
| Grok Messages single | 33.47s → 2.83s | 0 → **1502 ms** | 33.47s → 4.33s |
| Grok Messages parallel | 5.87s → 4.22s | 0 → **1502 ms** | 5.87s → 5.73s |
| Composer Messages single | 3.84s → 2.95s | 0 → **1501 ms** | 3.84s → 4.45s |
| Composer Messages parallel | 4.46s → 6.76s | 0 → **1501 ms** | 4.46s → 8.26s |
| Sonnet Chat parallel | 6.00s → 5.65s | 0 → **2450 ms** | 6.00s → 8.10s |
| Sonnet Responses parallel | 6.48s → 3.55s | 0 → **2055 ms** | 6.48s → 5.61s |

Before, tools landed only in `finish()` (`tool_lead=0`, parallel items as one clump). 1.0.31 writes each item at `execute()`. Text SSE was unchanged. `batch_close_wait_ms` on 1.0.31 was 1500–1503 ms every tool case. That stop wait is what the 2026-09-12 row removes.
