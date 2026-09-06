import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { api, closeTestApp, startTestApp, weatherTool, type TestContext } from "../helpers/app.js";

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
});

const tools = [
  weatherTool(),
  {
    name: "beta",
    description: "Second tool",
    input_schema: { type: "object", properties: { n: { type: "number" } } },
  },
];

test("single tool round-trip uses the same in-process run", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "weather" } }] },
          { type: "text", chunks: ["sunny"] },
        ],
      ],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [{ role: "user", content: "weather?" }],
      tools: [weatherTool()],
    }),
  });
  const toolTurn = (await first.json()) as {
    stop_reason: string;
    content: Array<{ type: string; id?: string; name?: string }>;
    usage: { input_tokens: number; output_tokens: number };
    usage_deferred?: boolean;
    cursor_session_id: string;
  };
  expect(first.status).toBe(200);
  expect(toolTurn.stop_reason).toBe("tool_use");
  const tool = toolTurn.content.find((block) => block.type === "tool_use");
  expect(tool?.name).toBe("lookup");
  expect(ctx.sdk.lastAllowlist).toEqual(["mcp"]);
  expect(ctx.sdk.agents[0]?.runs[0]?.waitCalls ?? 0).toBe(0);

  const second = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", content: toolTurn.content },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: tool?.id, content: "72F" }],
        },
      ],
      tools: [weatherTool()],
    }),
  });
  const final = (await second.json()) as { content: Array<{ text?: string }>; stop_reason: string };
  expect(second.status).toBe(200);
  expect(final.stop_reason).toBe("end_turn");
  expect(final.content.some((block) => block.text === "sunny")).toBe(true);
  expect(ctx.sdk.agents.length).toBe(1);
  expect(ctx.sdk.agents[0]?.runs.length).toBe(1);
  expect(ctx.sdk.agents[0]?.runs[0]?.waitCalls).toBe(1);
});

test("parallel tools return one assistant batch before any result resolves", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          {
            type: "tools",
            calls: [
              { name: "lookup", input: { q: "a" } },
              { name: "beta", input: { n: 2 } },
            ],
          },
          { type: "text", chunks: ["both"] },
        ],
      ],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [{ role: "user", content: "do both" }],
      tools,
    }),
  });
  const toolTurn = (await first.json()) as {
    content: Array<{ type: string; id?: string; name?: string }>;
  };
  const calls = toolTurn.content.filter((block) => block.type === "tool_use");
  expect(calls).toHaveLength(2);
  expect(calls.map((call) => call.name).sort()).toEqual(["beta", "lookup"]);
  expect(ctx.app.registry.sessions.size).toBe(1);
  expect(ctx.sdk.agents[0]?.runs[0]?.waitCalls ?? 0).toBe(0);

  const second = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [
        { role: "user", content: "do both" },
        { role: "assistant", content: toolTurn.content },
        {
          role: "user",
          content: calls.map((call) => ({
            type: "tool_result",
            tool_use_id: call.id,
            content: "ok",
          })),
        },
      ],
      tools,
    }),
  });
  const final = (await second.json()) as { content: Array<{ text?: string }> };
  expect(second.status).toBe(200);
  expect(final.content.some((block) => block.text === "both")).toBe(true);
});

test("staggered same-turn callbacks still settle into one parallel batch", async () => {
  ctx = await startTestApp({
    config: { toolBatchSettleMs: 100 },
    sdk: {
      scripts: [
        [
          {
            type: "tools",
            calls: [
              { name: "lookup", input: { q: "a" } },
              { name: "beta", input: { n: 2 }, delayMs: 50 },
            ],
          },
          { type: "text", chunks: ["both"] },
        ],
      ],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [{ role: "user", content: "do both" }],
      tools,
    }),
  });
  const turn = (await first.json()) as { content: Array<{ type: string; name?: string }> };
  expect(first.status).toBe(200);
  expect(turn.content.filter((block) => block.type === "tool_use").map((block) => block.name).sort()).toEqual([
    "beta",
    "lookup",
  ]);
});

async function firstToolTurn(ctx: TestContext): Promise<{ names: string[]; elapsedMs: number }> {
  const started = Date.now();
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [{ role: "user", content: "do both" }],
      tools,
    }),
  });
  const elapsedMs = Date.now() - started;
  const turn = (await res.json()) as { content: Array<{ type: string; name?: string }> };
  expect(res.status).toBe(200);
  return {
    names: turn.content.filter((block) => block.type === "tool_use").map((block) => block.name ?? "").sort(),
    elapsedMs,
  };
}

function logFields(ctx: TestContext, message: string): Record<string, unknown> | undefined {
  return ctx.logs
    .map((line) => JSON.parse(line) as { fields: Record<string, unknown>; message: string })
    .find((entry) => entry.message === message)?.fields;
}

test("round logs carry numeric timings for the batch, the close wait, and the client gap", async () => {
  ctx = await startTestApp({
    captureLogs: true,
    config: { toolBatchSettleMs: 100 },
    sdk: {
      scripts: [
        [
          { type: "text", chunks: ["checking"] },
          {
            type: "tools",
            calls: [
              { name: "lookup", input: { q: "a" } },
              { name: "beta", input: { n: 2 }, delayMs: 40 },
            ],
          },
          { type: "text", chunks: ["both"] },
        ],
      ],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", max_tokens: 32, messages: [{ role: "user", content: "do both" }], tools }),
  });
  const turn = (await first.json()) as { content: Array<{ type: string; id?: string }> };
  const ids = turn.content.filter((block) => block.type === "tool_use").map((block) => block.id ?? "");
  expect(ids).toHaveLength(2);
  const awaiting = logFields(ctx, "awaiting tool results");
  expect(awaiting).toMatchObject({ pending_count: 2, tool_count: 2 });
  expect(awaiting?.tool_spread_ms).toBeGreaterThanOrEqual(30);
  expect(awaiting?.batch_close_wait_ms).toBeGreaterThanOrEqual(90);
  for (const field of ["agent_ready_ms", "first_sdk_event_ms", "first_client_write_ms", "duration_ms"]) {
    expect(typeof awaiting?.[field]).toBe("number");
  }
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [{ role: "user", content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "ok" })) }],
      tools,
    }),
  });
  expect(res.status).toBe(200);
  const received = logFields(ctx, "tool results received");
  expect(received?.result_count).toBe(2);
  expect(received?.tool_result_gap_ms).toBeGreaterThanOrEqual(25);
  expect(received?.tool_result_gap_ms).toBeLessThan(Date.now() - started + 200);
  const completed = logFields(ctx, "turn completed");
  expect(typeof completed?.duration_ms).toBe("number");
  // Segment stamps restart with the continuation; only run liveness is cumulative.
  expect(typeof completed?.first_sdk_event_ms).toBe("number");
  expect(completed?.first_sdk_event_ms).toBeLessThanOrEqual(completed?.duration_ms as number);
  expect(completed?.tool_count).toBeUndefined();
});

test("the settle timer restarts on each callback so a staggered batch stays whole", async () => {
  ctx = await startTestApp({
    config: { toolBatchSettleMs: 100 },
    sdk: {
      scripts: [
        [
          {
            type: "tools",
            calls: [
              { name: "lookup", input: { q: "a" } },
              { name: "beta", input: { n: 2 }, delayMs: 50 },
            ],
          },
          { type: "text", chunks: ["both"] },
        ],
      ],
    },
  });
  const turn = await firstToolTurn(ctx);
  expect(turn.names).toEqual(["beta", "lookup"]);
  expect(turn.elapsedMs).toBeGreaterThanOrEqual(140);
});

async function readTimedSse(res: Response): Promise<Array<{ event: string; data: Record<string, unknown>; at: number }>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: Record<string, unknown>; at: number }> = [];
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator = buffer.indexOf("\n\n");
    while (separator !== -1) {
      const lines = buffer.slice(0, separator).split("\n");
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf("\n\n");
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
      const data = lines.find((line) => line.startsWith("data:"))?.slice(5).trim() ?? "{}";
      events.push({ event, data: JSON.parse(data) as Record<string, unknown>, at: Date.now() });
    }
  }
  return events;
}

test("SSE writes the tool_use block when the SDK requests the tool, before the batch closes", async () => {
  ctx = await startTestApp({
    config: { toolBatchSettleMs: 400 },
    sdk: {
      scripts: [
        [
          { type: "text", chunks: ["checking"] },
          { type: "tools", calls: [{ name: "lookup", input: { q: "a" } }] },
          { type: "text", chunks: ["done"] },
        ],
      ],
    },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      stream: true,
      messages: [{ role: "user", content: "go" }],
      tools,
    }),
  });
  const events = await readTimedSse(res);
  const toolStart = events.find(
    (item) => item.event === "content_block_start" && (item.data.content_block as { type?: string })?.type === "tool_use",
  );
  const stop = events.find((item) => item.event === "message_stop");
  expect(toolStart).toBeDefined();
  expect(stop).toBeDefined();
  expect(stop!.at - toolStart!.at).toBeGreaterThanOrEqual(250);
  expect(events.filter((item) => item.event === "content_block_start").map((item) => (item.data.content_block as { type: string }).type)).toEqual([
    "text",
    "tool_use",
  ]);
  const stopIndexes = events.filter((item) => item.event === "content_block_stop").map((item) => item.data.index);
  expect(stopIndexes).toEqual([0, 1]);
  expect((events.find((item) => item.event === "message_delta")?.data.delta as { stop_reason?: string })?.stop_reason).toBe("tool_use");
});

test("text after a tool call keeps arrival order in the stream, the non-stream body, and the replay", async () => {
  ctx = await startTestApp({
    config: { toolBatchSettleMs: 100 },
    sdk: {
      scripts: [
        [
          { type: "text", chunks: ["Calling"] },
          { type: "tools", calls: [{ name: "lookup", input: { q: "a" } }], trailingText: [" now"] },
          { type: "text", chunks: ["later"] },
        ],
      ],
    },
  });
  const body = { model: "composer-2.5", max_tokens: 32, messages: [{ role: "user", content: "go" }], tools };
  const res = await api(ctx, "/v1/messages", { method: "POST", body: JSON.stringify({ ...body, stream: true }) });
  const events = await readTimedSse(res);
  const starts = events.filter((item) => item.event === "content_block_start");
  expect(starts.map((item) => (item.data.content_block as { type: string }).type)).toEqual(["text", "tool_use", "text"]);
  expect(starts.map((item) => item.data.index)).toEqual([0, 1, 2]);
  const textOf = (index: number) =>
    events
      .filter((item) => item.event === "content_block_delta" && item.data.index === index)
      .map((item) => (item.data.delta as { text?: string }).text ?? "")
      .join("");
  expect(textOf(0)).toBe("Calling");
  expect(textOf(2)).toBe(" now");
  const replay = await api(ctx, "/v1/messages", { method: "POST", body: JSON.stringify(body) });
  const replayed = (await replay.json()) as { content: Array<{ type: string; text?: string; name?: string }> };
  expect(replay.status).toBe(200);
  expect(replayed.content.map((block) => block.type)).toEqual(["text", "tool_use", "text"]);
  expect(replayed.content.map((block) => block.text ?? block.name)).toEqual(["Calling", "lookup", " now"]);
});

test("deltas and tool callbacks that fire before send() resolves keep their relative order", async () => {
  ctx = await startTestApp({
    config: { toolBatchSettleMs: 50 },
    sdk: {
      scripts: [
        [
          { type: "text", chunks: ["BEFORE"], early: true },
          { type: "send-tools", calls: [{ name: "lookup", input: { q: "a" } }] },
          { type: "text", chunks: ["AFTER"], early: true },
          { type: "hang" },
        ],
      ],
    },
  });
  const body = { model: "composer-2.5", max_tokens: 32, messages: [{ role: "user", content: "go" }], tools };
  const res = await api(ctx, "/v1/messages", { method: "POST", body: JSON.stringify({ ...body, stream: true }) });
  const events = await readTimedSse(res);
  const starts = events.filter((item) => item.event === "content_block_start");
  expect(starts.map((item) => (item.data.content_block as { type: string }).type)).toEqual(["text", "tool_use", "text"]);
  const textOf = (index: number) =>
    events
      .filter((item) => item.event === "content_block_delta" && item.data.index === index)
      .map((item) => (item.data.delta as { text?: string }).text ?? "")
      .join("");
  expect(textOf(0)).toBe("BEFORE");
  expect(textOf(2)).toBe("AFTER");
  const replay = await api(ctx, "/v1/messages", { method: "POST", body: JSON.stringify(body) });
  const replayed = (await replay.json()) as { content: Array<{ type: string; text?: string; name?: string }> };
  expect(replayed.content.map((block) => block.text ?? block.name)).toEqual(["BEFORE", "lookup", "AFTER"]);
});

const lateBatchScript = [
  [
    {
      type: "tools" as const,
      calls: [
        { name: "lookup", input: { q: "a" } },
        { name: "beta", input: { n: 2 }, delayMs: 60 },
      ],
    },
    { type: "text" as const, chunks: ["both-done"] },
  ],
];

async function toolResultTurn(ctx: TestContext, id: string, content: string, stream = false): Promise<Response> {
  return api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      stream,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] }],
      tools,
    }),
  });
}

test("a call arriving after the published batch is carried into the next tool turn instead of failing the session", async () => {
  ctx = await startTestApp({ captureLogs: true, config: { toolBatchSettleMs: 10 }, sdk: { scripts: lateBatchScript } });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", max_tokens: 32, messages: [{ role: "user", content: "do both" }], tools }),
  });
  const turn = (await first.json()) as { content: Array<{ type: string; id?: string; name?: string }>; stop_reason: string };
  expect(first.status).toBe(200);
  expect(turn.content.filter((block) => block.type === "tool_use").map((block) => block.name)).toEqual(["lookup"]);
  const lookupId = turn.content.find((block) => block.type === "tool_use")?.id ?? "";
  await new Promise((resolve) => setTimeout(resolve, 100));

  // The late call opens the next segment immediately: no SDK wait, no failure.
  const carried = await toolResultTurn(ctx, lookupId, "ok", true);
  const events = await readTimedSse(carried);
  expect(carried.status).toBe(200);
  const carriedTools = events
    .filter((item) => item.event === "content_block_start" && (item.data.content_block as { type?: string }).type === "tool_use")
    .map((item) => (item.data.content_block as { name: string; id: string }));
  expect(carriedTools.map((block) => block.name)).toEqual(["beta"]);
  expect((events.find((item) => item.event === "message_delta")?.data.delta as { stop_reason?: string })?.stop_reason).toBe("tool_use");
  const awaiting = ctx.logs
    .map((line) => JSON.parse(line) as { fields: Record<string, unknown>; message: string })
    .filter((entry) => entry.message === "awaiting tool results");
  expect(awaiting[1]?.fields.carried_count).toBe(1);
  expect(awaiting[1]?.fields.tool_count).toBe(1);
  expect(ctx.sdk.agents[0]?.runs[0]?.capturedToolResults).toEqual(["ok"]);

  const final = await toolResultTurn(ctx, carriedTools[0]!.id, "second");
  const body = (await final.json()) as { content: Array<{ type: string; text?: string }>; stop_reason: string };
  expect(final.status).toBe(200);
  expect(body.stop_reason).toBe("end_turn");
  expect(body.content.map((block) => block.text)).toEqual(["both-done"]);
  expect(ctx.sdk.agents[0]?.runs[0]?.capturedToolResults).toEqual(["ok", "second"]);
});

test("text the model emits after the batch closed heads the next response instead of being dropped", async () => {
  ctx = await startTestApp({
    captureLogs: true,
    config: { toolBatchSettleMs: 20 },
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "a" } }], trailingText: ["late "], trailingTextDelayMs: 120 },
          { type: "text", chunks: ["done"] },
        ],
      ],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", max_tokens: 32, messages: [{ role: "user", content: "go" }], tools }),
  });
  const turn = (await first.json()) as { content: Array<{ type: string; id?: string }>; stop_reason: string };
  expect(turn.stop_reason).toBe("tool_use");
  expect(turn.content.map((block) => block.type)).toEqual(["tool_use"]);
  // The late text lands after the batch was published and before results are posted.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const next = await toolResultTurn(ctx, turn.content[0]?.id ?? "", "ok", true);
  const events = await readTimedSse(next);
  expect(next.status).toBe(200);
  const text = events
    .filter((item) => item.event === "content_block_delta")
    .map((item) => (item.data.delta as { text?: string }).text ?? "")
    .join("");
  expect(text).toBe("late done");
  expect((events.find((item) => item.event === "message_delta")?.data.delta as { stop_reason?: string })?.stop_reason).toBe("end_turn");
  const awaiting = ctx.logs
    .map((line) => JSON.parse(line) as { fields: Record<string, unknown>; message: string })
    .filter((entry) => entry.message === "awaiting tool results");
  // Carried text alone does not open a tool batch: one round, no carried_count.
  expect(awaiting).toHaveLength(1);
  expect(awaiting[0]?.fields.carried_count).toBeUndefined();
});

test("a carried call never enters the persisted pending batch, so restart recovery still matches what the client saw", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-carried-"));
  ctx = await startTestApp({ config: { stateDir, toolBatchSettleMs: 10 }, sdk: { scripts: lateBatchScript } });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", max_tokens: 32, messages: [{ role: "user", content: "do both" }], tools }),
  });
  const turn = (await first.json()) as { cursor_session_id: string; content: Array<{ type: string; id?: string }> };
  const lookupId = turn.content.find((block) => block.type === "tool_use")?.id ?? "";
  await new Promise((resolve) => setTimeout(resolve, 100));
  const lineage = JSON.parse(readFileSync(join(stateDir, "lineage", `${turn.cursor_session_id}.json`), "utf8")) as {
    pendingToolIds: string[];
  };
  expect(lineage.pendingToolIds).toEqual([lookupId]);
  await closeTestApp(ctx);

  ctx = await startTestApp({ config: { stateDir }, sdk: { scripts: [[{ type: "text", chunks: ["recovered"] }]] } });
  const recovered = await toolResultTurn(ctx, lookupId, "ok");
  expect(recovered.status).toBe(200);
  expect(ctx.sdk.resumeCalls).toHaveLength(1);
});

test("multi-round tools stay on the same SDK run", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "1" } }] },
          { type: "tools", calls: [{ name: "lookup", input: { q: "2" } }] },
          { type: "text", chunks: ["done-2"] },
        ],
      ],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [{ role: "user", content: "round" }],
      tools: [weatherTool()],
    }),
  });
  const turn1 = (await first.json()) as { content: Array<{ type: string; id?: string }> };
  const id1 = turn1.content.find((block) => block.type === "tool_use")?.id;
  const second = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [
        { role: "user", content: "round" },
        { role: "assistant", content: turn1.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id1, content: "r1" }] },
      ],
      tools: [weatherTool()],
    }),
  });
  const turn2 = (await second.json()) as { content: Array<{ type: string; id?: string }>; stop_reason: string };
  expect(turn2.stop_reason).toBe("tool_use");
  const id2 = turn2.content.find((block) => block.type === "tool_use")?.id;
  const third = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [
        { role: "user", content: "round" },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id2, content: "r2" }] },
      ],
      tools: [weatherTool()],
    }),
  });
  const final = (await third.json()) as { content: Array<{ text?: string }> };
  expect(third.status).toBe(200);
  expect(final.content.some((block) => block.text === "done-2")).toBe(true);
  expect(ctx.sdk.agents[0]?.runs.length).toBe(1);
});

test("tool_result is_error resolves as native SDKCustomToolResult", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "boom" } }] },
          { type: "text", chunks: ["handled"] },
        ],
      ],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "go" }],
      tools: [weatherTool()],
    }),
  });
  const turn = (await first.json()) as { content: Array<{ type: string; id?: string }> };
  const id = turn.content.find((block) => block.type === "tool_use")?.id;
  const second = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, content: "lookup failed", is_error: true }],
        },
      ],
    }),
  });
  expect(second.status).toBe(200);
  expect(ctx.sdk.agents[0]?.runs[0]?.capturedToolResults).toEqual([
    { content: [{ type: "text", text: "lookup failed" }], isError: true },
  ]);
});

test("successful tool_result still resolves as a plain string", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "ok" } }] },
          { type: "text", chunks: ["done"] },
        ],
      ],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "go" }],
      tools: [weatherTool()],
    }),
  });
  const turn = (await first.json()) as { content: Array<{ type: string; id?: string }> };
  const id = turn.content.find((block) => block.type === "tool_use")?.id;
  await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "72F" }] }],
    }),
  });
  expect(ctx.sdk.agents[0]?.runs[0]?.capturedToolResults).toEqual(["72F"]);
});

test("mixed new text and tool_result is rejected", async () => {
  ctx = await startTestApp();
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "also do this" },
            { type: "tool_result", tool_use_id: "toolu_x", content: "1" },
          ],
        },
      ],
    }),
  });
  const body = (await res.json()) as { error: { type: string } };
  expect(res.status).toBe(422);
  expect(body.error.type).toBe("invalid_request");
});
