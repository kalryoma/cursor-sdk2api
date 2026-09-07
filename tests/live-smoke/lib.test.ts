import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import {
  catalogCapability,
  DEFAULT_LIVE_MODELS,
  resolveCatalogModel,
  resolveRequestedModels,
} from "./lib/catalog.js";
import { defaultRequestedModels, liveSmokeGate } from "./lib/gate.js";
import { applyLiveModelSelection } from "./lib/client.js";
import {
  buildReceipt,
  exitCodeFor,
  isRequiredFailure,
  receiptOk,
  summarizeCases,
  type SmokeCase,
} from "./lib/receipt.js";
import {
  classifyCliEvent,
  parseCliLine,
  parseCliModelIds,
  resolveCliModel,
  toolNameFromCall,
  type CliMarks,
} from "./lib/cli-stream.js";
import { assertNoCanary, receiptContainsCanary, redactSecrets, redactValue } from "./lib/redact.js";
import {
  containsOpaqueMarker,
  listToolUses,
  parseSse,
  pickErrorType,
  pickUsage,
  sseShapeOk,
} from "./lib/sse.js";

test("check.mjs refuses to start without CURSOR_LIVE_SMOKE=1", () => {
  const result = spawnSync(process.execPath, ["tests/live-smoke/check.mjs"], {
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("CURSOR_LIVE_SMOKE=1");
  expect(result.stderr).not.toMatch(/sk-/);
});

test("live smoke gate requires explicit flag and key without echoing the key", () => {
  expect(liveSmokeGate({}).ok).toBe(false);
  expect(liveSmokeGate({}).code).toBe(2);
  expect(liveSmokeGate({ CURSOR_LIVE_SMOKE: "1" }).code).toBe(3);
  expect(liveSmokeGate({ CURSOR_LIVE_SMOKE: "1" }).message).not.toContain("sk-");
  expect(liveSmokeGate({ CURSOR_LIVE_SMOKE: "1", CURSOR_API_KEY: "sk-test-not-used" }).ok).toBe(true);
});

test("default requested models match the v0.1 matrix names", () => {
  expect(defaultRequestedModels({})).toEqual([...DEFAULT_LIVE_MODELS]);
  expect(defaultRequestedModels({ LIVE_SMOKE_MODELS: " composer-2.5 , grok-4.6 " })).toEqual([
    "composer-2.5",
    "grok-4.6",
  ]);
});

test("live Grok requests keep the original model id and request xhigh explicitly", () => {
  expect(applyLiveModelSelection({ model: "grok-4.6", messages: [] })).toMatchObject({
    model: "grok-4.6",
    reasoning_effort: "xhigh",
  });
  expect(applyLiveModelSelection({ model: "grok-4.6", reasoning_effort: "high" })).toMatchObject({
    model: "grok-4.6",
    reasoning_effort: "high",
  });
  expect(applyLiveModelSelection({ model: "composer-2.5" })).toEqual({ model: "composer-2.5" });
});

test("catalog matching is exact or normalized, never a guessed different model", () => {
  const models = [
    { id: "claude-sonnet-4-6", aliases: ["sonnet-4.6"] },
    { id: "composer-2.5" },
    { id: "grok-4.6" },
  ];
  expect(resolveCatalogModel("claude-sonnet-4-6", models)).toMatchObject({ id: "claude-sonnet-4-6", how: "exact" });
  expect(resolveCatalogModel("Claude_Sonnet_4_6", models)).toMatchObject({
    id: "claude-sonnet-4-6",
    how: "normalized",
  });
  expect(resolveCatalogModel("sonnet-4.6", models)).toMatchObject({ id: "claude-sonnet-4-6", how: "alias" });
  expect(resolveCatalogModel("sonnet", models).id).toBeUndefined();
  expect(resolveCatalogModel("sonnet", models).how).toBe("missing");
  expect(resolveCatalogModel("claude-fable-5", models).how).toBe("missing");
});

test("ambiguous normalized ids fail closed", () => {
  const models = [{ id: "Foo-Bar" }, { id: "foo_bar" }];
  expect(resolveCatalogModel("foo bar", models).how).toBe("ambiguous");
  expect(resolveCatalogModel("foo bar", models).id).toBeUndefined();
});

test("catalog-missing required models are failures, not green skips", () => {
  const resolved = resolveRequestedModels(["claude-fable-5", "composer-2.5"], [{ id: "composer-2.5" }]);
  expect(resolved.missing).toEqual(["claude-fable-5"]);
  const cases: SmokeCase[] = resolved.resolved.map((item) =>
    item.id
      ? { id: `${item.id}/text`, model: item.id, case: "text", status: "pass", required: true }
      : {
          id: `${item.requested}/catalog`,
          model: item.requested,
          case: "catalog",
          status: "catalog_missing",
          required: true,
        },
  );
  expect(cases.some((item) => item.status === "skip")).toBe(false);
  expect(receiptOk(cases).ok).toBe(false);
  expect(summarizeCases(cases).catalog_missing).toBe(1);
  expect(summarizeCases(cases).required_failures).toBe(1);
});

test("region-blocked required cases stay red while remaining distinguishable", () => {
  const cases: SmokeCase[] = [
    {
      id: "claude-sonnet-4-6/text",
      model: "claude-sonnet-4-6",
      case: "text",
      status: "region_blocked",
      required: true,
      http_status: 403,
      error_type: "forbidden",
      reason: "region_unsupported",
    },
  ];
  expect(summarizeCases(cases).region_blocked).toBe(1);
  expect(summarizeCases(cases).required_failures).toBe(1);
  expect(receiptOk(cases).ok).toBe(false);
});

test("capability skip only when catalog lists params and omits thinking", () => {
  expect(catalogCapability({ id: "x" }, "thinking")).toBe("unknown");
  expect(catalogCapability({ id: "x", parameters: [{ id: "fast", values: [{ value: "true" }] }] }, "thinking")).toBe(
    "unsupported",
  );
  expect(
    catalogCapability({ id: "x", parameters: [{ id: "reasoning", values: [{ value: "high" }] }] }, "thinking"),
  ).toBe("supported");
});

test("redaction strips keys, bearer, home, and extra canaries", () => {
  const key = "sk-live-canary-ABCDEFGH";
  const text = `Authorization: Bearer ${key} path=${process.env.HOME ?? "/Users/someone"}/secret`;
  const redacted = redactSecrets(text, [key]);
  expect(redacted).not.toContain(key);
  expect(redacted).not.toContain("Bearer sk-");
  expect(redacted.includes("[redacted]") || redacted.includes("[home]")).toBe(true);
  const obj = redactValue({ authorization: "Bearer secret", model: "composer-2.5", content: "nope" }, [key]);
  expect(obj).toMatchObject({ authorization: "[redacted]", model: "composer-2.5", content: "[redacted]" });
});

test("redaction strips Cursor User API keys without a canary list", () => {
  const key = "crsr_canarykey_ABCDEFGH12345678";
  expect(redactSecrets(`export CURSOR_API_KEY=${key}`, [])).not.toContain(key);
});

test("receipt build refuses to emit a canary and omits payload fields", () => {
  const key = "sk-receipt-canary-XYZ12345";
  const cases: SmokeCase[] = [
    { id: "composer-2.5/text_nonstream", model: "composer-2.5", case: "text_nonstream", status: "pass", required: true },
  ];
  const receipt = buildReceipt({
    startedAt: new Date("2026-08-15T00:00:00.000Z"),
    endedAt: new Date("2026-08-15T00:00:01.000Z"),
    environment: {
      node: "v22.19.0",
      platform: "linux",
      arch: "arm64",
      runner: "tests/live-smoke",
      mode: "child",
    },
    catalog: { requested: ["composer-2.5"], model_ids: ["composer-2.5"], resolved: [], missing: [] },
    cases,
    canaries: [key],
  });
  const serialized = JSON.stringify(receipt);
  expect(receiptContainsCanary(serialized, [key])).toBe(false);
  expect(serialized).not.toContain("prompt");
  expect(receipt.ok).toBe(true);
  expect(receipt.duration_ms).toBe(1000);
  expect(exitCodeFor(receipt)).toBe(0);
  expect(() => assertNoCanary(`${serialized}${key}`, [key])).toThrow(/canary/);
});

test("attach-mode not_run restart is incomplete, not a pass", () => {
  const cases: SmokeCase[] = [
    { id: "catalog/authenticated", case: "catalog_auth", status: "pass", required: true },
    {
      id: "composer-2.5/pending_restart_resume",
      model: "composer-2.5",
      case: "pending_restart_resume",
      status: "not_run",
      required: true,
      reason: "attach_mode_no_process_control",
    },
  ];
  expect(isRequiredFailure(cases[1]!)).toBe(true);
  expect(receiptOk(cases)).toEqual({ ok: false, incomplete: true });
  expect(
    exitCodeFor(
      buildReceipt({
        startedAt: new Date(),
        endedAt: new Date(),
        environment: { node: "v22", platform: "linux", arch: "arm64", runner: "x", mode: "attach" },
        catalog: { requested: [], model_ids: [], resolved: [], missing: [] },
        cases,
      }),
    ),
  ).toBe(2);
});

test("SSE shape and usage pickers do not keep assistant text", () => {
  const events = parseSse(
    [
      "event: message_start",
      'data: {"type":"message_start","message":{"cursor_session_id":"ses_1"}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"secret-text"}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n"),
  );
  expect(sseShapeOk({ message_start: 1, message_stop: 1, content_block_delta: 1 })).toBe(true);
  expect(pickErrorType({ type: "error", error: { type: "cursor_session_lost", message: "keep-out" } })).toBe(
    "cursor_session_lost",
  );
  expect(pickErrorType({ type: "message", content: [] })).toBeUndefined();
  expect(pickUsage({ usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 1 } })).toEqual({
    input_tokens: 3,
    output_tokens: 2,
    cache_read_input_tokens: 1,
  });
  const tools = listToolUses({
    content: [{ type: "tool_use", id: "toolu_1", name: "live_alpha", input: { token: "hidden" } }],
  });
  expect(tools).toEqual([{ id: "toolu_1", name: "live_alpha" }]);
  expect(containsOpaqueMarker({ content: [{ text: "mk_abc" }] }, "mk_abc")).toBe(true);
  expect(JSON.stringify(events.find((item) => item.event === "content_block_delta"))).toContain("secret-text");
});

test("CLI stream-json marks keep timings and tool names, not prompt or file bodies", () => {
  const marks: CliMarks = { tool_items: [] };
  const events = [
    parseCliLine(
      '{"type":"system","subtype":"init","model":"Claude 4 Sonnet","cwd":"/secret/path"}',
    ),
    parseCliLine(
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hidden-prompt"}]}}',
    ),
    parseCliLine(
      '{"type":"thinking","subtype":"delta","timestamp_ms":1}',
    ),
    parseCliLine(
      '{"type":"assistant","timestamp_ms":1,"message":{"role":"assistant","content":[{"type":"text","text":"hidden-delta"}]}}',
    ),
    parseCliLine(
      '{"type":"assistant","timestamp_ms":2,"model_call_id":"mc_1","message":{"role":"assistant","content":[{"type":"text","text":"dup"}]}}',
    ),
    parseCliLine(
      '{"type":"tool_call","subtype":"started","tool_call":{"readToolCall":{"args":{"path":"marker.txt"}}}}',
    ),
    parseCliLine(
      '{"type":"tool_call","subtype":"completed","tool_call":{"readToolCall":{"result":{"success":{"content":"secret-file"}}}}}',
    ),
    parseCliLine(
      '{"type":"tool_call","subtype":"started","tool_call":{"function":{"name":"live_beta"}}}',
    ),
    parseCliLine('{"type":"result","subtype":"success","duration_ms":1234,"is_error":false,"result":"hidden-final"}'),
  ];
  const clocks = [0, 5, 8, 10, 20, 40, 50, 80, 90];
  events.forEach((event, index) => {
    expect(event).toBeDefined();
    classifyCliEvent(event!, marks, clocks[index]!);
  });
  expect(marks).toEqual({
    model: "Claude 4 Sonnet",
    first_byte_ms: 8,
    tool_items: [
      { name: "read", at_ms: 40 },
      { name: "live_beta", at_ms: 80 },
    ],
    stop_ms: 90,
    stop_reason: "success",
    cli_duration_ms: 1234,
  });
  expect(JSON.stringify(marks)).not.toContain("hidden");
  expect(JSON.stringify(marks)).not.toContain("secret-file");
  expect(toolNameFromCall({ writeToolCall: { args: { path: "x" } } })).toBe("write");
  expect(parseCliModelIds('{"models":[{"id":"claude-sonnet-4-6"},{"id":"grok-4.6"}]}')).toEqual([
    "claude-sonnet-4-6",
    "grok-4.6",
  ]);
});

test("CLI catalog maps live:timing model ids onto Cursor CLI slugs", () => {
  const listed = parseCliModelIds(
    [
      "Available models",
      "claude-4.6-sonnet-medium - Claude Sonnet 4.6 1M",
      "cursor-grok-4.6-medium - Cursor Grok 4.6 Medium",
      "composer-2.5 - Composer 2.5",
    ].join("\n"),
  );
  expect(listed).toEqual(["claude-4.6-sonnet-medium", "cursor-grok-4.6-medium", "composer-2.5"]);
  expect(resolveCliModel("claude-sonnet-4-6", listed)).toEqual({
    requested: "claude-sonnet-4-6",
    id: "claude-4.6-sonnet-medium",
    how: "alias",
  });
  expect(resolveCliModel("grok-4.6", listed)).toEqual({
    requested: "grok-4.6",
    id: "cursor-grok-4.6-medium",
    how: "alias",
  });
  expect(resolveCliModel("composer-2.5", listed)).toEqual({
    requested: "composer-2.5",
    id: "composer-2.5",
    how: "exact",
  });
  expect(resolveCliModel("claude-fable-5", listed).how).toBe("missing");
});
