# Tool batch close

The gateway sees a client tool only when the SDK calls `customTool.execute`. Nothing in `onDelta` or `run.stream()` marks the end of that model generation, so the batch closes `TOOL_BATCH_SETTLE_MS` (1.5 s) after the latest callback.

## Findings (`@cursor/sdk` 1.0.30 and 1.0.31)

- `turn-ended` fires only after every `execute` promise resolves. This gateway holds those promises until the client posts `tool_result`, so `turn-ended` cannot close a batch.
- `tool-call-started` fires at dispatch (1–2 ms before `execute` on Sonnet; 23–26 ms after it on Grok). It is not a batch-end signal.
- Calls from one generation are dispatched separately (typically 0.1–0.7 s apart; outliers of several seconds exist).
- After the last dispatch the delta stream goes silent. Between dispatches the model keeps emitting `token-delta` (silence 49–129 ms in the recorded samples). That is the premise of optional `TOOL_BATCH_IDLE_MS`.
- With `TOOL_BATCH_SETTLE_MS=10000`, every timed batch closed on the settle timer. Tool items stream at `execute`; only the stop reason waits.
- `live:smoke` on this branch: Sonnet 4.6, Grok 4.6, and Composer 2.5 pass the required matrix. Fable 5 `claude_code_shape` passes via the gated `systemPrompt` fallback; remaining Fable failures are `cursor_upstream_error` (model/upstream). The test account has no `systemPrompt` access.

Same-suite `main` vs this PR: [2026-09-06-pr-performance-diff.md](2026-09-06-pr-performance-diff.md). SDK adapter check: [2026-09-06-cursor-sdk-1.0.31-audit.md](2026-09-06-cursor-sdk-1.0.31-audit.md).

## Gateway behavior

Tool items stream as soon as `execute` fires. The batch closes on `TOOL_BATCH_SETTLE_MS`, or earlier on delta silence when `TOOL_BATCH_IDLE_MS` is set (settle stays the cap). Output that arrives after the close is carried into the next turn in order: a late call as its own batch, late text or thinking at its head. Logs: `batch_close` (`settle_timer` / `idle` / `carried`), `batch_close_wait_ms`, `tool_spread_ms`, `tool_result_gap_ms`.

`TOOL_BATCH_IDLE_MS=300` cut stop wait to ~300 ms (~1.2 s saved per round) and split some Sonnet parallel batches. Default stays off.

## Not claimed

Hosted tools and `sand` were not probed. `HOST_SYSTEM_PROMPT_MODE=replace` on an enabled account is unverified, which is why it stays opt-in.

## Upstream request

Gateways that bridge `local.customTools` need a generation boundary independent of tool-result completion. Today they can only wait after the latest `execute`, which adds that wait to every round or splits a slow batch.

Proposed, once per model generation and before any local tool runs:

```json
{ "type": "tool-batch-ready", "modelCallId": "...", "callIds": ["call_a", "call_b"] }
```

`step-completed` at the end of generation (with the step id on `tool-call-started`) would also work.
