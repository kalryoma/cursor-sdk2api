# OpenCodex → cursor-sdk2api Sonnet 5 live probe

Redacted public summary of Codex CLI 0.153.4 through OpenCodex 2.45.0 to this
gateway on `@cursor/sdk` 1.0.31. No API key, account identity, prompt, assistant
text, tool schema, arguments, results, or home path is recorded.

Environment: gateway `0.4.0` BYOK on `127.0.0.1:8080`; OpenCodex
`openai-responses` provider `cursor-sdk2api` on `127.0.0.1:10100`; isolated
`OPENCODEX_HOME` / `CODEX_HOME`. Node `v22.22.2`, Linux x64.

## OpenCodex provider

| Check | Result |
|---|---|
| `ocx provider test cursor-sdk2api` | pass, 32 ms, 37 models |
| Live catalog | resolved `cursor-sdk2api/claude-sonnet-5` with effort `low`…`max` |
| `ocx sync` | appended 37 routed models; injected `openai_base_url` |

## Direct OpenCodex Responses

`POST http://127.0.0.1:10100/v1/responses`, model `cursor-sdk2api/claude-sonnet-5`,
`reasoning.effort=low`, no tools:

| Metric | Result |
|---|---:|
| HTTP | 200 |
| TTFB | 1890 ms |
| Completed | 2255 ms |
| SSE lifecycle | created → in_progress → text deltas → completed |

Opaque 4-character marker observed. No SSE error events.

## Codex CLI through OpenCodex

`codex exec --ephemeral` with `model=cursor-sdk2api/claude-sonnet-5`,
`model_reasoning_effort=low`, `web_search=disabled`, read-only sandbox:

| Case | Result | Wall | Notes |
|---|---|---:|---|
| No-tool ping | pass | 2634 ms | Final client message observed |
| Local file tool | pass | 15898 ms | One `exec_command`, then completed text |

Codex logged `426 Upgrade Required` on `ws://127.0.0.1:10100/v1/responses`
because OpenCodex `websockets` was false. Both turns completed over SSE.

## Interpretation

- Proven this window: OpenCodex key-auth Responses passthrough to this gateway;
  live catalog; Sonnet 5 low-effort stream; Codex no-tool ping; Codex local
  `exec_command` continuation.
- Not claimed: OpenCodex `adapter: "cursor"`, hosted OpenAI tools, WebSocket
  Responses, managed multi-account mode, or OpenCodex dashboard GUI.
- `/health` still reports `verification.live_smoke=false`.
