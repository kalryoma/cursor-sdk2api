# Live timing — signal-driven close and turn-ended

Same 11-case `live:timing` suite on one User API Key, Node `v22.23.2`, child-process BYOK. Both sides **11/11**. Receipts stay outside git (`/tmp/retest-2026-09-12/`). This file is timings and event names only.

| Side | Git | Gateway defaults |
|---|---|---|
| **main** | `1684b1d` | `TOOL_BATCH_SETTLE_MS=1500`, `TOOL_BATCH_IDLE_MS=0` (off) |
| **PR** | `8c50bb2` (`cursor/streaming-responsiveness-parity-4bcf`) | settle cap 1500, **idle 200**, announce / `step-completed` close, final on `turn-ended` |

The runner was this branch's `tests/live-smoke/timing.ts` both times. `LIVE_TIMING_REPO_ROOT` pointed main at a detached worktree; the PR spawned `/workspace/dist/index.js`. Neither side set `TOOL_BATCH_*` in the environment, so each gateway used its compiled defaults.

Window: main `2026-09-12T15:19:46Z`–`15:20:51Z`; PR `15:21:34Z`–`15:22:25Z`.

## Policy effect

**`batch_close_wait_ms`** is the gateway wait after the last `execute`. On main it is the 1.5 s settle on every tool case. On the PR it is the 200 ms idle grace: live `step-completed` did not beat idle in this sample (close stayed 200–234 ms, not ~0). Sonnet custom-tool `announce_lead_ms` was 0–2 ms — announces exist and join on `callId`, but they do not arrive hundreds of milliseconds before `execute`.

**`tool_lead_ms`** is first streamed tool item → stop (what Claude Code / Codex pay after the tool is visible). **`text_tail_ms`** is last token → stop. **`publish_lag_ms`** is last model output → published boundary (PR logs only).

Duration still includes generation. Chat and Responses on the PR selected 1 of 2 requested tools (model-nondeterministic); treat those two duration cells as generation, not close policy. Their `batch_close_wait_ms` is still a valid stop-wait comparison.

| Case | close_wait main → PR | tool_lead main → PR | duration |
|---|---:|---:|---:|
| Sonnet Messages single | 1502 → **201** | 1504 → **203** | 8.78s → 4.95s |
| Sonnet Messages parallel | 1500 → **200** | 2077 → **774** | 6.16s → 4.44s |
| Grok Messages single | 1500 → **224** | 1502 → **226** | 5.42s → 3.64s |
| Grok Messages parallel | 1500 → **227** | 1501 → **228** | 6.86s → 3.72s |
| Composer Messages single | 1500 → **234** | 1501 → **236** | 3.87s → 2.49s |
| Composer Messages parallel | 1500 → **222** | 1502 → **223** | 4.46s → 2.53s |
| Sonnet Chat parallel | 1501 → **209** | 2457 → **210** | 5.68s → 6.34s |
| Sonnet Responses parallel | 1501 → **208** | 2457 → **209** | 7.89s → 5.90s |

| Case | text_tail main → PR | publish_lag (PR) | duration |
|---|---:|---:|---:|
| Sonnet Messages text SSE | 122 → **12** | **1** | 3.20s → 3.17s |
| Grok Messages text SSE | 76 → **4** | **0** | 1.46s → 1.82s |
| Composer Messages text SSE | 96 → **21** | **0** | 1.56s → 1.54s |

Sonnet Messages parallel kept a 573–575 ms tool spread on both sides and stayed one batch (`pending_count=2`). Stop wait on that case is idle + spread (774 ms) instead of settle + spread (2077 ms).

## Client impact versus the previous settle-only policy

The 1.0.31 early-stream work made tools visible at `execute()` but left **round wall-clock unchanged** for clients that wait for stop. This update removes that wait.

| Client | Per tool round | 30 tool rounds |
|---|---|---|
| Waits for stop (typical Claude Code) | **~1.3 s faster** (1500 → ~200–230 ms close) | **~39 s** of settle removed |
| Starts on the tool item (Codex `output_item.done`) | Tool item still at `execute()`; `response.completed` **~1.3 s earlier**, so `function_call_output` can post sooner | Same ~39 s of blocked continuation removed |
| Text-only turn | Stop **~70–110 ms** after the last token instead of ~80–120 ms | Turn-end wind-down no longer on the client path |

`TOOL_BATCH_SETTLE_MS=1500` remains the cap. A live announce whose execute never matches still degrades to that cap; this sample never hit it.
