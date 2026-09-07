# OpenCodex integration

`cursor-sdk2api` is an external Responses provider for [OpenCodex](https://opencodex.me/).
It does not patch OpenCodex, run inside the `ocx` process, or use OpenCodex's
experimental `cursor` adapter (that adapter talks to `api2.cursor.sh` over
Connect/gRPC). Both services stay ordinary HTTP on loopback:

```
Codex CLI  →  OpenCodex :10100  →  cursor-sdk2api :8080  →  @cursor/sdk
```

Use the `openai-responses` adapter with `authMode: "key"` so OpenCodex
passthroughs Codex's Responses body to `POST /v1/responses`. Do not point
OpenCodex at this gateway with `adapter: "cursor"`.

## Start the gateway

```bash
AUTH_MODE=managed GATEWAY_ACCESS_KEY='replace-me' node dist/index.js
```

Import a Cursor account in `/console/` if you use managed mode. BYOK also
works: then OpenCodex's provider key is the Cursor User API Key.

## Add the provider

Isolated homes keep this stack off your default `~/.opencodex` / `~/.codex`:

```bash
export OPENCODEX_HOME="$HOME/.opencodex-cursor-sdk2api"
export CODEX_HOME="$HOME/.codex-cursor-sdk2api"
```

`$OPENCODEX_HOME/config.json`:

```json
{
  "port": 10100,
  "hostname": "127.0.0.1",
  "defaultProvider": "cursor-sdk2api",
  "providers": {
    "cursor-sdk2api": {
      "adapter": "openai-responses",
      "baseUrl": "http://127.0.0.1:8080/v1",
      "authMode": "key",
      "apiKey": "${GATEWAY_ACCESS_KEY}",
      "defaultModel": "claude-sonnet-5",
      "liveModels": true,
      "allowPrivateNetwork": true,
      "reasoningEfforts": ["low", "medium", "high", "xhigh", "max"]
    }
  },
  "websockets": false
}
```

```bash
ocx start --port 10100
ocx provider test cursor-sdk2api
ocx sync
```

`ocx sync` writes `openai_base_url` and a routed catalog into `$CODEX_HOME`.
Codex then selects `cursor-sdk2api/claude-sonnet-5`. Keep `web_search = "disabled"`
unless the gateway is started with `HOSTED_SEARCH_MODE=auto`.

```bash
codex exec -m cursor-sdk2api/claude-sonnet-5 -c model_reasoning_effort=low \
  -c web_search=disabled "Reply with exactly PONG"
```

Codex 0.153 may try `ws://127.0.0.1:10100/v1/responses` first and log `426
Upgrade Required` when `websockets` is false. The request then falls back to
SSE. That is expected, not a gateway failure.

Live: `ocx provider test` 32 ms / 37 models including `cursor-sdk2api/claude-sonnet-5`.
Direct OpenCodex Responses TTFB ~1.9 s. Codex through OpenCodex: ping ~2.6 s;
local `exec_command` turn ~16 s. Not claimed: `adapter: "cursor"`, hosted OpenAI
tools, WebSocket Responses, or managed multi-account.

## Not this path

- OpenCodex `adapter: "cursor"` / `ocx login cursor` — private Cursor transport,
  forbidden here.
- Hosted OpenAI tools (`file_search`, `computer`, `shell`, `apply_patch`).
- `previous_response_id` and `store=true`.
