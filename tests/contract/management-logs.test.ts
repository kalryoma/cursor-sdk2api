import { afterEach, expect, test } from "vitest";
import { api, closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
  ctx = undefined;
});

async function listLogs(limit?: number): Promise<{
  generated_at: number;
  total: number;
  logs: Array<Record<string, unknown>>;
}> {
  const path = limit == null ? "/v0/management/logs" : `/v0/management/logs?limit=${limit}`;
  const response = await fetch(`${ctx!.url}${path}`);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    generated_at: number;
    total: number;
    logs: Array<Record<string, unknown>>;
  };
}

test("management logs start empty and reject an invalid limit", async () => {
  ctx = await startTestApp();
  const empty = await listLogs();
  expect(empty.total).toBe(0);
  expect(empty.logs).toEqual([]);
  expect(typeof empty.generated_at).toBe("number");

  const invalid = await fetch(`${ctx.url}/v0/management/logs?limit=0`);
  expect(invalid.status).toBe(400);
});

test("a messages turn is recorded and health stays off the ring", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["hello"] }]] },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  expect(res.status).toBe(200);
  await fetch(`${ctx.url}/health`);
  await api(ctx, "/v1/models");

  const listed = await listLogs();
  expect(listed.total).toBe(1);
  expect(listed.logs[0]).toMatchObject({
    protocol: "messages",
    path: "/v1/messages",
    method: "POST",
    model: "composer-2.5",
    stream: false,
    status: 200,
    key_hint: "••••ey-a",
  });
  expect(listed.logs[0]?.request_id).toEqual(expect.any(String));
  expect(listed.logs[0]?.session_id).toEqual(expect.stringMatching(/^ses_/));
  expect(listed.logs[0]?.duration_ms).toEqual(expect.any(Number));
});

test("limit returns the newest rows only", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [{ type: "text", chunks: ["one"] }],
        [{ type: "text", chunks: ["two"] }],
      ],
    },
  });
  for (const model of ["composer-2.5", "grok-4.6"]) {
    const res = await api(ctx, "/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
  }
  const listed = await listLogs(1);
  expect(listed.total).toBe(2);
  expect(listed.logs).toHaveLength(1);
  expect(listed.logs[0]?.model).toBe("grok-4.6");
});

test("failed auth and parse are recorded without prompts or keys", async () => {
  const canaryKey = "sk-canary-SECRET-123456789";
  const canaryPrompt = "do-not-log-this-prompt";
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["ok"] }]] },
  });

  const unauth = await fetch(`${ctx.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: canaryPrompt }],
    }),
  });
  expect(unauth.status).toBe(401);

  const invalid = await api(ctx, "/v1/messages", {
    apiKey: canaryKey,
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", prompt: canaryPrompt }),
  });
  expect(invalid.status).toBe(422);

  const ok = await api(ctx, "/v1/messages", {
    apiKey: canaryKey,
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: canaryPrompt }],
    }),
  });
  expect(ok.status).toBe(200);

  const listed = await listLogs();
  const text = JSON.stringify(listed);
  expect(text).not.toContain(canaryKey);
  expect(text).not.toContain(canaryPrompt);
  expect(listed.total).toBe(3);
  expect(listed.logs[2]).toMatchObject({
    protocol: "messages",
    status: 401,
    error_type: "authentication_error",
  });
  expect(listed.logs[1]).toMatchObject({
    protocol: "messages",
    status: 422,
    error_type: "invalid_request",
    key_hint: "••••6789",
  });
  expect(listed.logs[0]).toMatchObject({
    protocol: "messages",
    status: 200,
    key_hint: "••••6789",
  });
});

test("in-flight rows show running until the turn finishes", async () => {
  let inflight: unknown;
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["hello"] }]] },
    beforeApplyBoundary: async () => {
      const listed = await listLogs();
      inflight = listed.logs[0]?.status;
    },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  expect(res.status).toBe(200);
  expect(inflight).toBe("running");
  const listed = await listLogs();
  expect(listed.logs[0]?.status).toBe(200);
});

test("playground runs appear on the request log", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["pong"] }]] },
  });
  const created = await fetch(`${ctx.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "fixture-account-key" }),
  });
  expect(created.status).toBe(201);
  const { account } = (await created.json()) as { account: { id: string; key_hint: string } };

  const run = await fetch(`${ctx.url}/v0/management/accounts/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      account_id: account.id,
      protocol: "messages",
      request: {
        model: "composer-2.5",
        max_tokens: 16,
        messages: [{ role: "user", content: "playground-secret-prompt" }],
      },
    }),
  });
  expect(run.status).toBe(200);

  const listed = await listLogs();
  const text = JSON.stringify(listed);
  expect(text).not.toContain("fixture-account-key");
  expect(text).not.toContain("playground-secret-prompt");
  expect(listed.logs[0]).toMatchObject({
    protocol: "messages",
    path: "/v0/management/accounts/run",
    status: 200,
    account_id: account.id,
    key_hint: account.key_hint,
    model: "composer-2.5",
  });
});
