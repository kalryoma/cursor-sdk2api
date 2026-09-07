import { afterEach, expect, test } from "vitest";
import { parseResponsesRequest } from "../../src/protocols/openai-responses/parse.js";
import { api, closeTestApp, parseSse, startTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
  ctx = undefined as never;
});

const functionTool = {
  type: "function",
  name: "lookup",
  description: "Look something up",
  parameters: { type: "object", properties: { q: { type: "string" } } },
};

const jsonSchema = {
  type: "json_schema",
  name: "answer",
  strict: true,
  schema: {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  },
};

test("json_schema intent is forwarded as an explicit output contract", async () => {
  ctx = await startTestApp({ config: { hostSystemPromptMode: "replace" }, sdk: { scripts: [[{ type: "text", chunks: ['{"answer":"ok"}'] }]] } });
  const response = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: "answer",
      text: { format: jsonSchema },
    }),
  });
  expect(response.status).toBe(200);
  // The output contract is system-level text; in replace mode it rides on the SDK systemPrompt.
  const prompt = ctx.sdk.agents[0]?.input.systemPrompt ?? "";
  expect(prompt).toContain("OUTPUT FORMAT:");
  expect(prompt).toContain("Return only valid JSON matching schema answer");
  expect(prompt).toContain('"additionalProperties":false');
  expect(ctx.sdk.agents[0]?.lastSend?.text).not.toContain("OUTPUT FORMAT:");
});

test("unknown text formats fail closed instead of disappearing", () => {
  expect(() => parseResponsesRequest({
    model: "composer-2.5",
    input: "hi",
    text: { format: { type: "xml" } },
  })).toThrowError(/text.format.type must be/);
});

test("additional_tools function entries join the executable client tool catalog", async () => {
  ctx = await startTestApp({ sdk: { scripts: [[{ type: "text", chunks: ["ok"] }]] } });
  const response = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [
        { type: "additional_tools", role: "developer", tools: [functionTool] },
        { type: "message", role: "user", content: "hello" },
      ],
    }),
  });
  expect(response.status).toBe(200);
  expect(ctx.sdk.lastAllowlist).toEqual(["mcp"]);
  expect(ctx.sdk.lastCreate?.clientToolNames).toEqual(["lookup"]);
});

test("top-level Codex namespace tools qualify like additional_tools", () => {
  const parsed = parseResponsesRequest({
    model: "composer-2.5",
    tools: [
      functionTool,
      {
        type: "namespace",
        name: "multi_agent_v1",
        description: "Tools for spawning and managing sub-agents.",
        tools: [{
          type: "function",
          name: "spawn_agent",
          description: "Spawn a sub-agent",
          parameters: { type: "object", properties: { prompt: { type: "string" } } },
        }],
      },
      { type: "namespace", name: "collaboration" },
    ],
    input: "hello",
  });
  expect(parsed.parsed.tools.map((tool) => tool.sdk_name ?? tool.name)).toEqual([
    "lookup",
    "multi_agent_v1__spawn_agent",
  ]);
  expect(parsed.parsed.tools[1]).toMatchObject({
    name: "spawn_agent",
    namespace: "multi_agent_v1",
    sdk_name: "multi_agent_v1__spawn_agent",
  });
});

test("identical top-level and additional function tools dedupe", () => {
  const parsed = parseResponsesRequest({
    model: "composer-2.5",
    tools: [functionTool],
    input: [
      { type: "additional_tools", role: "developer", tools: [functionTool] },
      { type: "message", role: "user", content: "hello" },
    ],
  });
  expect(parsed.parsed.tools).toHaveLength(1);
  expect(parsed.parsed.tools[0]?.name).toBe("lookup");
});

test("top-level tool declarations are authoritative over Responses Lite duplicates", () => {
  const parsed = parseResponsesRequest({
    model: "composer-2.5",
    tools: [functionTool],
    input: [
      {
        type: "additional_tools",
        tools: [{ ...functionTool, parameters: { type: "object", properties: { n: { type: "number" } } } }],
      },
      { type: "message", role: "user", content: "hello" },
    ],
  });
  expect(parsed.parsed.tools).toHaveLength(1);
  expect(parsed.parsed.tools[0]).toMatchObject({ name: "lookup", tool_kind: "function" });
  expect(parsed.parsed.tools[0]?.input_schema).toEqual(functionTool.parameters);
});

test("conflicting duplicates inside additional_tools still fail closed", () => {
  expect(() => parseResponsesRequest({
    model: "composer-2.5",
    input: [
      {
        type: "additional_tools",
        tools: [
          functionTool,
          { ...functionTool, parameters: { type: "object", properties: { n: { type: "number" } } } },
        ],
      },
      { type: "message", role: "user", content: "hello" },
    ],
  })).toThrowError(/conflicting duplicate additional tool name: lookup/);
});

test("Codex custom additional_tools round-trip as native custom tool calls", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [[
        { type: "tools", calls: [{ name: "exec", input: { input: "echo ok" }, id: "call_exec" }] },
        { type: "text", chunks: ["done"] },
      ]],
    },
  });
  const tools = [{ type: "custom", name: "exec", description: "Run a command" }];
  const first = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [
        { type: "additional_tools", role: "developer", tools },
        { type: "message", role: "user", content: "run it" },
      ],
      tool_choice: { type: "custom", name: "exec" },
    }),
  });
  const firstBody = (await first.json()) as { output: Array<Record<string, unknown>> };
  const call = firstBody.output.find((item) => item.type === "custom_tool_call");
  expect(first.status).toBe(200);
  expect(call).toMatchObject({
    type: "custom_tool_call",
    call_id: "call_exec",
    name: "exec",
    input: "echo ok",
  });

  const second = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [{ type: "custom_tool_call_output", call_id: "call_exec", output: "ok" }],
      tools,
    }),
  });
  const secondBody = (await second.json()) as { output: Array<Record<string, unknown>> };
  expect(second.status).toBe(200);
  expect(secondBody.output.find((item) => item.type === "message")).toMatchObject({
    content: [{ type: "output_text", text: "done" }],
  });
  expect(ctx.sdk.agents[0]?.runs[0]?.capturedToolResults).toEqual(["ok"]);
});

test("custom tools use native Responses streaming event names", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "tools", calls: [{ name: "exec", input: { input: "pwd" }, id: "call_stream" }] }]] },
  });
  const response = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      stream: true,
      input: [
        { type: "additional_tools", tools: [{ type: "custom", name: "exec" }] },
        { type: "message", role: "user", content: "run" },
      ],
    }),
  });
  const events = parseSse(await response.text());
  expect(events.some((event) => event.event === "response.custom_tool_call_input.delta")).toBe(true);
  expect(events.some((event) => event.event === "response.custom_tool_call_input.done")).toBe(true);
  const done = events.find((event) => event.event === "response.output_item.done")?.data as {
    item?: Record<string, unknown>;
  };
  expect(done.item).toMatchObject({
    type: "custom_tool_call",
    call_id: "call_stream",
    name: "exec",
    input: "pwd",
  });
});

test("namespaced additional functions use qualified SDK names and restore Responses identity", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [[
        { type: "tools", calls: [{ name: "mcp__exa__search", input: { q: "sdk" }, id: "call_ns" }] },
        { type: "text", chunks: ["found"] },
      ]],
    },
  });
  const namespaceTool = {
    type: "namespace",
    name: "mcp__exa",
    tools: [{
      type: "function",
      name: "search",
      description: "Search the web",
      parameters: { type: "object", properties: { q: { type: "string" } } },
    }],
  };
  const first = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [
        { type: "additional_tools", role: "developer", tools: [namespaceTool] },
        { type: "message", role: "user", content: "search" },
      ],
    }),
  });
  const firstBody = (await first.json()) as { output: Array<Record<string, unknown>> };
  const call = firstBody.output.find((item) => item.type === "function_call");
  expect(first.status).toBe(200);
  expect(ctx.sdk.lastCreate?.clientToolNames).toEqual(["search"]);
  expect(call).toMatchObject({
    type: "function_call",
    call_id: "call_ns",
    name: "search",
    namespace: "mcp__exa",
  });

  const second = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [
        { type: "additional_tools", role: "developer", tools: [namespaceTool] },
        {
          type: "function_call_output",
          call_id: "call_ns",
          name: "search",
          namespace: "mcp__exa",
          output: "result",
        },
      ],
    }),
  });
  expect(second.status).toBe(200);
  expect(ctx.sdk.agents[0]?.runs[0]?.capturedToolResults).toEqual(["result"]);
});

test("hosted additional tools remain explicit unsupported capabilities", () => {
  expect(() => parseResponsesRequest({
    model: "composer-2.5",
    input: [
      { type: "additional_tools", tools: [{ type: "web_search" }] },
      { type: "message", role: "user", content: "hello" },
    ],
  })).toThrowError(/unsupported additional_tools type/);
});
