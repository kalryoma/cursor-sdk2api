# Codex CLI Sonnet 5 live probe — 2026-09-07

Redacted public summary of a loopback Codex CLI 0.153.4 run against this gateway on `@cursor/sdk` 1.0.31. No API key, account identity, prompt, assistant text, tool schema, tool arguments, tool results, or home path is recorded.

Environment: gateway `0.4.0`, Node `v22.22.2`, Linux x64, `AUTH_MODE=byok`, isolated `STATE_DIR` / Codex home. Catalog `GET /v1/models` returned 37 models in 414 ms and resolved `claude-sonnet-5` exactly, with public `effort` values including `low`.

## Direct Responses baseline

`POST /v1/responses` stream, model `claude-sonnet-5`, `reasoning.effort=low`, no tools:

| Metric | Result |
|---|---:|
| HTTP | 200 |
| TTFB | 3114 ms |
| First `response.output_text.delta` | 3159 ms |
| `response.completed` | 3333 ms |
| SSE lifecycle | created → in_progress → output_item → content_part → text deltas → completed |

Opaque 4-character marker observed. No SSE error events.

## Default Codex CLI 0.153.4 (before this change)

First `/v1/responses` from `codex exec` included:

- `store=false`, `stream=true`, `reasoning.effort=low`
- `include=["reasoning.encrypted_content"]` (accepted and omitted)
- top-level function tools `exec_command`, `write_stdin`, `request_user_input`, `view_image`
- top-level `type=namespace` `multi_agent_v1` with five child functions
- hosted `type=web_search` unless `web_search=disabled`

The unpatched parser rejected `type=namespace` as an unimplemented hosted tool (422 `invalid_request`) before any SDK run. Codex also warned that it has no built-in metadata for `claude-sonnet-5` and falls back to generic limits; that warning is client-side and did not block the later successful runs.

## After top-level namespace flatten

`codex exec --ephemeral` with `model=claude-sonnet-5`, `model_reasoning_effort=low`, `web_search=disabled`, read-only sandbox, approval never:

| Case | Result | Wall | Notes |
|---|---|---:|---|
| No-tool ping | pass | 3584 ms | Final client message observed; one streamed Responses request |
| Local file tool | pass | 17837 ms | Three streamed Responses requests; one `exec_command` batch, then `function_call_output` continuation, then completed text |

Gateway segment logs (numeric only):

| Segment | first_sdk_event_ms | first_client_write_ms | duration_ms | tool_count | batch_close_wait_ms |
|---|---:|---:|---:|---:|---:|
| No-tool ping | (not separately captured) | 3149 | 3337 | 0 | — |
| Tool turn 1 | 235 | 5016 | 6550 | 1 | 1502 |
| Tool continuation | 1389 | 5824 | 7325 | 1 | 1501 |
| Tool final text | — | 3015 | 3582 | 0 | — |

Hosted `web_search` remains fail-closed unless `HOSTED_SEARCH_MODE=auto`. That default is unchanged; the live Codex recipe disables the client tool.

## Interpretation

- Proven this window: catalog; Sonnet 5 low-effort streaming Responses; Codex CLI 0.153.4 no-tool ping; Codex local `exec_command` continuation through the same coordinator.
- Not claimed: hosted OpenAI tools, `previous_response_id` / `store=true`, multi-account managed mode, or Codex model-catalog metadata for `claude-sonnet-5`.
- `/health` still reports `verification.live_smoke=false`.
