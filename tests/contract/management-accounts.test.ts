import { statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
  ctx = undefined;
});

test("accounts persist across gateway restarts with CPA-style private files", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-persistent-"));
  ctx = await startTestApp({ config: { stateDir } });

  const created = await fetch(`${ctx.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "fixture-account-key" }),
  });
  expect(created.status).toBe(201);
  const createdBody = (await created.json()) as { account: { id: string; key_hint: string } };
  expect(createdBody.account.key_hint).toBe("••••-key");
  expect(JSON.stringify(createdBody)).not.toContain("fixture-account-key");
  expect(statSync(join(stateDir, "auths")).mode & 0o777).toBe(0o700);
  expect(statSync(join(stateDir, "auths", `${createdBody.account.id}.json`)).mode & 0o777).toBe(0o600);

  await closeTestApp(ctx);
  ctx = await startTestApp({ config: { stateDir } });
  const restored = await fetch(`${ctx.url}/v0/management/accounts`);
  const restoredBody = (await restored.json()) as { accounts: Array<{ id: string; key_hint: string }> };
  expect(restoredBody.accounts).toEqual([
    expect.objectContaining({ id: createdBody.account.id, key_hint: createdBody.account.key_hint }),
  ]);
  expect(JSON.stringify(restoredBody)).not.toContain("fixture-account-key");

  const removed = await fetch(`${ctx.url}/v0/management/accounts?id=${encodeURIComponent(createdBody.account.id)}`, {
    method: "DELETE",
  });
  expect(removed.status).toBe(200);
  const empty = await fetch(`${ctx.url}/v0/management/accounts`);
  expect(await empty.json()).toMatchObject({ accounts: [] });
});

test("pause state is validated, listed, and persisted across restarts", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-paused-"));
  ctx = await startTestApp({ config: { stateDir } });
  const created = await fetch(`${ctx.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "pause-account-key" }),
  });
  const { account } = (await created.json()) as { account: { id: string; paused: boolean } };
  expect(account.paused).toBe(false);

  const setPaused = (body: unknown) => fetch(`${ctx!.url}/v0/management/accounts/paused`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect((await setPaused({ id: account.id, paused: "yes" })).status).toBe(400);
  expect((await setPaused({ id: "acct_missing", paused: true })).status).toBe(404);

  const paused = await setPaused({ id: account.id, paused: true });
  expect(paused.status).toBe(200);
  const pausedText = await paused.text();
  expect(pausedText).not.toContain("pause-account-key");
  expect(JSON.parse(pausedText)).toMatchObject({ account: { id: account.id, paused: true } });

  await closeTestApp(ctx);
  ctx = await startTestApp({ config: { stateDir } });
  const listed = (await (await fetch(`${ctx.url}/v0/management/accounts`)).json()) as {
    accounts: Array<{ id: string; paused: boolean }>;
  };
  expect(listed.accounts).toEqual([expect.objectContaining({ id: account.id, paused: true })]);
});

test("adding the same Cursor key is idempotent", async () => {
  ctx = await startTestApp();
  const add = () => fetch(`${ctx!.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "same-key" }),
  });
  const first = (await (await add()).json()) as { account: { id: string } };
  const second = (await (await add()).json()) as { account: { id: string } };
  expect(second.account.id).toBe(first.account.id);
  const listed = await fetch(`${ctx.url}/v0/management/accounts`);
  const body = (await listed.json()) as { accounts: unknown[] };
  expect(body.accounts).toHaveLength(1);
});

test("account probe uses the stored Cursor key without returning it to the browser", async () => {
  ctx = await startTestApp({
    sdk: {
      modelsByApiKey: {
        "probe-secret-key": { ok: true, models: [{ id: "claude-sonnet-4-6", displayName: "Sonnet 4.6" }] },
      },
      accountsByApiKey: {
        "probe-secret-key": { ok: true, identity: { apiKeyName: "probe-account" } },
      },
    },
  });
  const created = await fetch(`${ctx.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "probe-secret-key" }),
  });
  const { account } = (await created.json()) as { account: { id: string } };

  const response = await fetch(`${ctx.url}/v0/management/accounts/probe?id=${encodeURIComponent(account.id)}`);
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).not.toContain("probe-secret-key");
  expect(JSON.parse(text)).toMatchObject({
    models: { data: [{ id: "claude-sonnet-4-6" }] },
    account: { identity: { api_key_name: "probe-account" } },
  });
  expect(ctx.sdk.listModelsApiKeys).toContain("probe-secret-key");
  expect(ctx.sdk.getAccountApiKeys).toContain("probe-secret-key");
});

test("account playground runs with the selected stored Cursor key", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["managed console ok"] }]] },
  });
  const created = await fetch(`${ctx.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "run-secret-key" }),
  });
  const { account } = (await created.json()) as { account: { id: string } };

  const response = await fetch(`${ctx.url}/v0/management/accounts/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      account_id: account.id,
      protocol: "messages",
      request: {
        model: "claude-sonnet-4-6",
        max_tokens: 128,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
    }),
  });
  expect(response.status).toBe(200);
  expect(ctx.sdk.lastCreate?.apiKey).toBe("run-secret-key");
  expect(await response.text()).toContain("managed console ok");
});
