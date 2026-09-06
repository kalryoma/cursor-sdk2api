import { afterEach, expect, test } from "vitest";
import { api, closeTestApp, parseSse, startTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
});

/** Two text chunks with a silent gap long enough for several heartbeats. */
const pausedScript = [[{ type: "text" as const, chunks: ["first", "second"], pauseBetweenMs: 150 }]];

function commentLines(raw: string): string[] {
  return raw.split("\n").filter((line) => line.startsWith(":"));
}

test("Anthropic stream sends ping events during a silent stretch and none after message_stop", async () => {
  ctx = await startTestApp({ config: { sseHeartbeatMs: 30 }, sdk: { scripts: pausedScript } });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", max_tokens: 32, stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  const events = parseSse(await res.text());
  const names = events.map((event) => event.event);
  const pings = events.filter((event) => event.event === "ping");
  expect(pings.length).toBeGreaterThanOrEqual(2);
  expect(pings.every((event) => JSON.stringify(event.data) === JSON.stringify({ type: "ping" }))).toBe(true);
  expect(names.indexOf("ping")).toBeGreaterThan(names.indexOf("message_start"));
  expect(names.lastIndexOf("ping")).toBeLessThan(names.indexOf("message_stop"));
  expect(names.at(-1)).toBe("message_stop");
});

test("Chat Completions and Responses streams send SSE comment lines that parsers skip", async () => {
  ctx = await startTestApp({ config: { sseHeartbeatMs: 30 }, sdk: { scripts: [...pausedScript, ...pausedScript] } });
  const chat = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", stream: true, messages: [{ role: "user", content: "chat" }] }),
  });
  const chatRaw = await chat.text();
  expect(commentLines(chatRaw).length).toBeGreaterThanOrEqual(2);
  expect(commentLines(chatRaw).every((line) => line === ": ping")).toBe(true);
  expect(chatRaw.trimEnd().endsWith("data: [DONE]")).toBe(true);

  const responses = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", stream: true, input: "responses" }),
  });
  const responsesRaw = await responses.text();
  expect(commentLines(responsesRaw).length).toBeGreaterThanOrEqual(2);
  const sequence = parseSse(responsesRaw)
    .map((event) => (event.data as { sequence_number?: number } | null)?.sequence_number)
    .filter((value): value is number => typeof value === "number");
  expect(sequence).toEqual(sequence.map((_, index) => index));
});

test("SSE_HEARTBEAT_MS=0 disables the heartbeat and non-stream responses never carry one", async () => {
  ctx = await startTestApp({ config: { sseHeartbeatMs: 0 }, sdk: { scripts: [...pausedScript, ...pausedScript] } });
  const stream = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", max_tokens: 32, stream: true, messages: [{ role: "user", content: "a" }] }),
  });
  expect(parseSse(await stream.text()).some((event) => event.event === "ping")).toBe(false);
  const json = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", max_tokens: 32, messages: [{ role: "user", content: "b" }] }),
  });
  expect(json.headers.get("content-type")).toContain("application/json");
  expect((await json.text()).includes("ping")).toBe(false);
});
