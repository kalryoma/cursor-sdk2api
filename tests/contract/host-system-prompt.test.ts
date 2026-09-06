import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { GatewayConfig } from "../../src/config.js";
import { api, closeTestApp, startTestApp, weatherTool, type TestContext } from "../helpers/app.js";

const apps: TestContext[] = [];

afterEach(async () => {
  while (apps.length > 0) {
    const ctx = apps.pop();
    if (ctx) await closeTestApp(ctx);
  }
});

const replace: Partial<GatewayConfig> = { hostSystemPromptMode: "replace" };

async function messages(ctx: TestContext, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return api(ctx, "/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "composer-2.5", max_tokens: 32, ...body }),
  });
}

function logFields(ctx: TestContext, message: string): Record<string, unknown> | undefined {
  return ctx.logs
    .map((line) => JSON.parse(line) as { fields: Record<string, unknown>; message: string })
    .find((entry) => entry.message === message)?.fields;
}

async function errorType(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: { type?: string } }).error?.type;
}

test("the default mode keeps the system prompt inline", async () => {
  const ctx = await startTestApp({ captureLogs: true, sdk: { scripts: [[{ type: "text", chunks: ["ok"] }]] } });
  apps.push(ctx);
  await messages(ctx, { system: "Inline host.", tools: [weatherTool()], messages: [{ role: "user", content: "hi" }] });
  expect(ctx.sdk.lastCreate?.systemPrompt).toBeUndefined();
  const sent = ctx.sdk.agents[0]?.lastSend?.text ?? "";
  expect(sent).toContain("HARNESS TOOL CONTEXT:");
  expect(sent).toContain("System:\nInline host.");
  expect(logFields(ctx, "turn completed")?.system_prompt_mode).toBe("inline");
});

test("replace mode passes the host system prompt to Agent.create with the harness tool context restated", async () => {
  const ctx = await startTestApp({ captureLogs: true, config: replace, sdk: { scripts: [[{ type: "text", chunks: ["ok"] }]] } });
  apps.push(ctx);
  const res = await messages(ctx, {
    system: "You are the host.",
    tools: [weatherTool()],
    messages: [{ role: "user", content: "hi" }],
  });
  expect(res.status).toBe(200);
  const created = ctx.sdk.lastCreate;
  expect(created?.systemPrompt?.startsWith("HARNESS TOOL CONTEXT:")).toBe(true);
  expect(created?.systemPrompt?.endsWith("You are the host.")).toBe(true);
  const sent = ctx.sdk.agents[0]?.lastSend?.text ?? "";
  expect(sent).not.toContain("System:");
  expect(sent).not.toContain("HARNESS TOOL CONTEXT");
  expect(sent).toContain("hi");
  expect(logFields(ctx, "turn completed")?.system_prompt_mode).toBe("replace");
});

test("without tools the systemPrompt is the host text alone, and empty or whitespace system falls back to inline", async () => {
  const ctx = await startTestApp({
    config: replace,
    sdk: { scripts: [[{ type: "text", chunks: ["a"] }], [{ type: "text", chunks: ["b"] }], [{ type: "text", chunks: ["c"] }]] },
  });
  apps.push(ctx);
  await messages(ctx, { system: "Plain host.", messages: [{ role: "user", content: "one" }] });
  expect(ctx.sdk.agents[0]?.input.systemPrompt).toBe("Plain host.");

  await messages(ctx, { messages: [{ role: "user", content: "two" }] });
  expect(ctx.sdk.agents[1]?.input.systemPrompt).toBeUndefined();
  expect(ctx.sdk.agents[1]?.lastSend?.text).not.toContain("System:");

  await messages(ctx, { system: "   \n ", messages: [{ role: "user", content: "three" }] });
  expect(ctx.sdk.agents[2]?.input.systemPrompt).toBeUndefined();
});

for (const surface of ["run", "send"] as const) {
  test(`an account without systemPrompt access (gate reported via ${surface}) falls back to inline once and is remembered`, async () => {
    const ctx = await startTestApp({
      captureLogs: true,
      config: replace,
      sdk: {
        systemPromptGated: surface,
        scripts: [[{ type: "text", chunks: ["first"] }], [{ type: "text", chunks: ["second"] }]],
      },
    });
    apps.push(ctx);
    const first = await messages(ctx, { system: "Host.", messages: [{ role: "user", content: "one" }], stream: surface === "run" });
    expect(first.status).toBe(200);
    const body = await first.text();
    expect(body).toContain("first");
    expect(body).not.toContain("system-prompt");
    // The gated attempt created an agent with systemPrompt; the retry created one without.
    expect(ctx.sdk.agents).toHaveLength(2);
    expect(ctx.sdk.agents[0]?.input.systemPrompt).toBe("Host.");
    expect(ctx.sdk.agents[1]?.input.systemPrompt).toBeUndefined();
    expect(ctx.sdk.agents[1]?.lastSend?.text).toContain("System:\nHost.");
    const retry = ctx.logs
      .map((line) => JSON.parse(line) as { fields: Record<string, unknown>; message: string })
      .find((entry) => entry.message.includes("inline system prompt"));
    expect(retry?.fields.fallback_reason).toBe("system_prompt_gated");
    expect(JSON.stringify(ctx.logs)).not.toContain("Host.");

    const second = await messages(ctx, { system: "Host.", messages: [{ role: "user", content: "two" }] });
    expect(second.status).toBe(200);
    expect(ctx.sdk.agents).toHaveLength(3);
    expect(ctx.sdk.agents[2]?.input.systemPrompt).toBeUndefined();
    expect(logFields(ctx, "turn completed")?.system_prompt_mode).toBe("inline");
  });
}

test("a follow-up with a different host prompt resumes the same agent with the new systemPrompt", async () => {
  const ctx = await startTestApp({ config: replace, sdk: { scripts: [[{ type: "text", chunks: ["one"] }], [{ type: "text", chunks: ["two"] }]] } });
  apps.push(ctx);
  const first = await messages(ctx, { system: "Prompt A.", messages: [{ role: "user", content: "one" }] });
  const { cursor_session_id: sessionId } = (await first.json()) as { cursor_session_id: string };
  const original = ctx.sdk.agents[0];
  expect(original?.input.systemPrompt).toBe("Prompt A.");

  const follow = await messages(
    ctx,
    { system: "Prompt B.", messages: [{ role: "user", content: "one" }, { role: "assistant", content: "one" }, { role: "user", content: "two" }] },
    { "x-cursor-session-id": sessionId },
  );
  expect(follow.status).toBe(200);
  expect(ctx.sdk.resumeCalls).toHaveLength(1);
  expect(ctx.sdk.lastResume?.agentId).toBe(original?.agentId);
  expect(ctx.sdk.lastResume?.systemPrompt).toBe("Prompt B.");
  expect(ctx.sdk.agents[1]?.lastSend?.text).not.toContain("System:");
  expect(original?.closed).toBe(true);
});

test("a follow-up with the same or no host prompt keeps the live handle and its prompt", async () => {
  const ctx = await startTestApp({
    config: replace,
    sdk: { scripts: [[{ type: "text", chunks: ["one"] }], [{ type: "text", chunks: ["two"] }], [{ type: "text", chunks: ["three"] }]] },
  });
  apps.push(ctx);
  const first = await messages(ctx, { system: "Prompt A.", messages: [{ role: "user", content: "one" }] });
  const { cursor_session_id: sessionId } = (await first.json()) as { cursor_session_id: string };
  const headers = { "x-cursor-session-id": sessionId };

  const same = await messages(ctx, { system: "Prompt A.", messages: [{ role: "user", content: "two" }] }, headers);
  expect(same.status).toBe(200);
  const none = await messages(ctx, { messages: [{ role: "user", content: "three" }] }, headers);
  expect(none.status).toBe(200);
  expect(ctx.sdk.resumeCalls).toHaveLength(0);
  expect(ctx.sdk.agents).toHaveLength(1);
  expect(ctx.sdk.agents[0]?.sendCount).toBe(3);
  expect(ctx.sdk.agents[0]?.lastSend?.text).not.toContain("System:");
});

test("pending tool results after a restart must carry the same host prompt the stored replace session used", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-host-prompt-pending-"));
  const script = [[{ type: "tools" as const, calls: [{ name: "lookup", input: { q: "a" } }] }, { type: "text" as const, chunks: ["done"] }]];
  const app1 = await startTestApp({ config: { ...replace, stateDir }, sdk: { scripts: script } });
  apps.push(app1);
  const first = await messages(app1, { system: "Host.", tools: [weatherTool()], messages: [{ role: "user", content: "go" }] });
  const turn = (await first.json()) as { stop_reason: string; content: Array<{ type: string; id?: string }> };
  expect(turn.stop_reason).toBe("tool_use");
  const toolId = turn.content.find((block) => block.type === "tool_use")?.id ?? "";
  await closeTestApp(app1);
  apps.pop();

  const app2 = await startTestApp({ config: { ...replace, stateDir }, sdk: { scripts: [[{ type: "text", chunks: ["done"] }]] } });
  apps.push(app2);
  const results = (system?: string) =>
    messages(app2, {
      ...(system ? { system } : {}),
      tools: [weatherTool()],
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "ok" }] }],
    });
  const missing = await results();
  expect(missing.status).toBe(409);
  expect(await errorType(missing)).toBe("cursor_session_conflict");
  const different = await results("Other.");
  expect(different.status).toBe(409);
  expect(await errorType(different)).toBe("cursor_session_conflict");
  expect(app2.sdk.resumeCalls).toHaveLength(0);

  const matching = await results("Host.");
  expect(matching.status).toBe(200);
  expect(app2.sdk.resumeCalls).toHaveLength(1);
  expect(app2.sdk.lastResume?.systemPrompt?.endsWith("Host.")).toBe(true);
  expect(((await matching.json()) as { content: Array<{ text?: string }> }).content[0]?.text).toBe("done");
});

test("pending tool results keep the stored prompt mode across a restart that switched HOST_SYSTEM_PROMPT_MODE", async () => {
  const toolScript = [[{ type: "tools" as const, calls: [{ name: "lookup", input: { q: "a" } }] }, { type: "text" as const, chunks: ["done"] }]];
  const openToolTurn = async (config: Partial<GatewayConfig>) => {
    const app = await startTestApp({ config, sdk: { scripts: toolScript } });
    apps.push(app);
    const first = await messages(app, { system: "Host.", tools: [weatherTool()], messages: [{ role: "user", content: "go" }] });
    const turn = (await first.json()) as { content: Array<{ type: string; id?: string }> };
    await closeTestApp(app);
    apps.pop();
    return turn.content.find((block) => block.type === "tool_use")?.id ?? "";
  };
  const resumeWithResult = async (config: Partial<GatewayConfig>, toolId: string) => {
    const app = await startTestApp({ config, sdk: { scripts: [[{ type: "text", chunks: ["done"] }]] } });
    apps.push(app);
    const res = await messages(app, {
      system: "Host.",
      tools: [weatherTool()],
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "ok" }] }],
    });
    expect(res.status).toBe(200);
    expect(app.sdk.resumeCalls).toHaveLength(1);
    return app;
  };

  // replace -> inline: the stored session needs the SDK systemPrompt, and the recovery text carries only tool results.
  const replaceState = mkdtempSync(join(tmpdir(), "cursor-sdk2api-mode-switch-"));
  const replaceTool = await openToolTurn({ ...replace, stateDir: replaceState });
  const inlineApp = await resumeWithResult({ stateDir: replaceState }, replaceTool);
  expect(inlineApp.sdk.lastResume?.systemPrompt?.endsWith("Host.")).toBe(true);
  expect(inlineApp.sdk.agents[0]?.lastSend?.text).not.toContain("System:");

  // inline -> replace: the prompt already sits in the agent's history; do not add a second copy as systemPrompt.
  const inlineState = mkdtempSync(join(tmpdir(), "cursor-sdk2api-mode-switch-"));
  const inlineTool = await openToolTurn({ stateDir: inlineState });
  const replaceApp = await resumeWithResult({ ...replace, stateDir: inlineState }, inlineTool);
  expect(replaceApp.sdk.lastResume?.systemPrompt).toBeUndefined();
});

test("a completed follow-up after restart passes the host system prompt to Agent.resume, may change it, but cannot drop it", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-host-prompt-"));
  const app1 = await startTestApp({ config: { ...replace, stateDir }, sdk: { scripts: [[{ type: "text", chunks: ["first"] }]] } });
  apps.push(app1);
  const first = await messages(app1, { system: "Host.", messages: [{ role: "user", content: "one" }] });
  const body = (await first.json()) as { cursor_session_id: string };
  expect(first.status).toBe(200);
  await closeTestApp(app1);
  apps.pop();

  const app2 = await startTestApp({ config: { ...replace, stateDir }, sdk: { scripts: [[{ type: "text", chunks: ["second"] }]] } });
  apps.push(app2);
  const headers = { "x-cursor-session-id": body.cursor_session_id };
  const dropped = await messages(app2, { messages: [{ role: "user", content: "two" }] }, headers);
  expect(dropped.status).toBe(409);
  expect(await errorType(dropped)).toBe("cursor_session_conflict");
  expect(app2.sdk.resumeCalls).toHaveLength(0);

  const follow = await messages(app2, { system: "Changed host.", messages: [{ role: "user", content: "two" }] }, headers);
  expect(follow.status).toBe(200);
  expect(app2.sdk.resumeCalls).toHaveLength(1);
  expect(app2.sdk.lastResume?.systemPrompt).toBe("Changed host.");
  expect(app2.sdk.agents[0]?.lastSend?.text).not.toContain("System:");
});
