#!/usr/bin/env node
/**
 * Opt-in live timing runner: where does a tool round spend its time?
 *
 * Per case it records, from the client's side, the first SSE byte, the first
 * and last tool item, the stop event, and, from the gateway's own log line,
 * the numeric round timings (agent_ready_ms, first_sdk_event_ms,
 * batch_close_wait_ms, ...). Prompts carry a unique token so identical-digest
 * replay cannot serve one case from another. Stdout and the receipt hold
 * timings and event names only; no prompt, tool payload, or credential.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveSmokeGate } from "./lib/gate.js";
import { redactSecrets, assertNoCanary } from "./lib/redact.js";
import { startChildGateway } from "./lib/spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

type Protocol = "messages" | "chat" | "responses";

interface Marks {
  first_byte_ms?: number;
  first_text_ms?: number;
  last_text_ms?: number;
  tool_items: Array<{ name: string; at_ms: number }>;
  stop_ms?: number;
  stop_reason?: string;
  error_type?: string;
}

interface TimingCase {
  id: string;
  model: string;
  protocol: Protocol;
  status: "pass" | "fail" | "catalog_missing";
  http_status?: number;
  duration_ms?: number;
  first_byte_ms?: number;
  first_text_ms?: number;
  last_text_ms?: number;
  first_tool_ms?: number;
  last_tool_ms?: number;
  tool_spread_ms?: number;
  tool_names?: string[];
  stop_ms?: number;
  stop_reason?: string;
  /** Time between the first tool item and the stop event: the wait a client pays after the last tool. */
  tool_lead_ms?: number;
  /** Time between the last text delta and the stop event: the wait a client pays after the last token. */
  text_tail_ms?: number;
  gateway?: Record<string, number>;
  error_type?: string;
  reason?: string;
}

function markText(marks: Marks, now: number): void {
  marks.first_text_ms ??= now;
  marks.last_text_ms = now;
}

/** Gateway forwards this env into the child so C7/C9 variants can be A/B measured. */
const PASS_THROUGH = ["TOOL_BATCH_SETTLE_MS", "TOOL_BATCH_IDLE_MS", "HOST_SYSTEM_PROMPT_MODE", "SSE_HEARTBEAT_MS"] as const;

const tools = [
  { name: "live_alpha", description: "Record token A. Call when instructed.", schema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] } },
  { name: "live_beta", description: "Record token B. Call when instructed.", schema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] } },
];
const anthropicTools = tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.schema }));
const chatTools = tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.schema } }));
const responsesTools = tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.schema }));

const token = () => `tok-${randomBytes(4).toString("hex")}`;
const singlePrompt = () => `Call live_alpha once. Set token to ${token()}. Do not answer in text first.`;
const parallelPrompt = () =>
  `Call both independent tools live_alpha and live_beta now, in the same assistant turn, before waiting for either result. Use token ${token()} for both. Do not call them sequentially and do not answer in text first.`;

function parseChunk(raw: string): { event: string; data: Record<string, unknown> | null } {
  let event = "message";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data || data === "[DONE]") return { event: data === "[DONE]" ? "done" : event, data: null };
  try {
    return { event, data: JSON.parse(data) as Record<string, unknown> };
  } catch {
    return { event, data: null };
  }
}

const classify: Record<Protocol, (item: ReturnType<typeof parseChunk>, marks: Marks, now: number) => void> = {
  messages(item, marks, now) {
    const block = item.data?.content_block as { type?: string; name?: string } | undefined;
    const delta = item.data?.delta as { stop_reason?: string; type?: string } | undefined;
    if (item.event === "content_block_start" && block?.type === "tool_use") marks.tool_items.push({ name: block.name ?? "", at_ms: now });
    if (item.event === "content_block_delta" && delta?.type === "text_delta") markText(marks, now);
    if (item.event === "message_delta" && delta?.stop_reason) {
      marks.stop_ms ??= now;
      marks.stop_reason = delta.stop_reason;
    }
    if (item.event === "error") marks.error_type = String((item.data?.error as { type?: string } | undefined)?.type ?? "error");
  },
  chat(item, marks, now) {
    const choice = (item.data?.choices as Array<{ delta?: { content?: string; tool_calls?: Array<{ function?: { name?: string } }> }; finish_reason?: string }> | undefined)?.[0];
    if (!choice) {
      if (item.data?.error) marks.error_type = String((item.data.error as { type?: string }).type ?? "error");
      return;
    }
    if (choice.delta?.content) markText(marks, now);
    for (const call of choice.delta?.tool_calls ?? []) {
      if (call.function?.name) marks.tool_items.push({ name: call.function.name, at_ms: now });
    }
    if (choice.finish_reason) {
      marks.stop_ms ??= now;
      marks.stop_reason = choice.finish_reason;
    }
  },
  responses(item, marks, now) {
    const type = String(item.data?.type ?? item.event);
    const output = item.data?.item as { type?: string; name?: string } | undefined;
    if (type === "response.output_item.added" && (output?.type === "function_call" || output?.type === "custom_tool_call")) {
      marks.tool_items.push({ name: output.name ?? "", at_ms: now });
    }
    if (type === "response.output_text.delta") markText(marks, now);
    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      marks.stop_ms ??= now;
      marks.stop_reason = String((item.data?.response as { status?: string } | undefined)?.status ?? type);
    }
    if (type === "error" || type === "response.failed") marks.error_type = String((item.data?.error as { type?: string } | undefined)?.type ?? type);
  },
};

async function readStream(res: Response, started: number, protocol: Protocol): Promise<Marks> {
  const marks: Marks = { tool_items: [] };
  if (!res.body) return marks;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const drain = (final: boolean) => {
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (raw.trim()) classify[protocol](parseChunk(raw), marks, Date.now() - started);
      index = buffer.indexOf("\n\n");
    }
    if (final && buffer.trim()) classify[protocol](parseChunk(buffer), marks, Date.now() - started);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && marks.first_byte_ms === undefined) marks.first_byte_ms = Date.now() - started;
    buffer += decoder.decode(value, { stream: true });
    drain(false);
  }
  buffer += decoder.decode();
  drain(true);
  return marks;
}

interface GatewayLog {
  fields: Record<string, unknown>;
  message: string;
}

function parseGatewayLine(line: string): GatewayLog | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const { msg, ...fields } = parsed;
    return { message: String(msg ?? ""), fields };
  } catch {
    return undefined;
  }
}

function numericFields(fields: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
}

async function main(): Promise<void> {
  const gate = liveSmokeGate(process.env);
  if (!gate.ok) {
    console.error(gate.message);
    process.exit(gate.code);
  }
  const apiKey = process.env.CURSOR_API_KEY?.trim() ?? "";
  const canaries = [apiKey];
  const timeoutMs = Number.parseInt(process.env.LIVE_SMOKE_TIMEOUT_MS ?? "180000", 10);
  const models = (process.env.LIVE_SMOKE_MODELS?.trim() || "claude-sonnet-4-6,grok-4.6,composer-2.5")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const protocolModel = process.env.LIVE_TIMING_PROTOCOL_MODEL?.trim() || models[0] || "claude-sonnet-4-6";
  const output = process.env.LIVE_SMOKE_OUTPUT?.trim() || join(tmpdir(), `cursor-sdk2api-live-timing-${Date.now()}.json`);
  const spawnRoot = process.env.LIVE_TIMING_REPO_ROOT?.trim() || repoRoot;
  const distEntry = process.env.LIVE_TIMING_ENTRY?.trim() || join(spawnRoot, "dist", "index.js");
  if (!existsSync(distEntry)) {
    console.error("dist/index.js is missing. Run npm run build before live:timing.");
    process.exit(3);
  }
  const passThrough = Object.fromEntries(
    PASS_THROUGH.flatMap((name) => (process.env[name] !== undefined ? [[name, String(process.env[name])]] : [])),
  );

  const logs: GatewayLog[] = [];
  const child = await startChildGateway({
    repoRoot: spawnRoot,
    distEntry,
    canaries,
    env: passThrough,
    onLog: (line) => {
      const parsed = parseGatewayLine(line);
      if (parsed) logs.push(parsed);
    },
  });
  const cases: TimingCase[] = [];
  let exitCode = 1;

  const request = async (protocol: Protocol, path: string, body: Record<string, unknown>) => {
    const started = Date.now();
    const logIndex = logs.length;
    const res = await fetch(`${child.baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const marks = (res.headers.get("content-type") ?? "").includes("text/event-stream")
      ? await readStream(res, started, protocol)
      : ({ tool_items: [], error_type: String(((await res.json().catch(() => ({}))) as { error?: { type?: string } }).error?.type ?? "") || undefined } as Marks);
    const gateway = logs.slice(logIndex).find((entry) => entry.message === "awaiting tool results" || entry.message === "turn completed");
    return { status: res.status, duration_ms: Date.now() - started, marks, gateway: gateway ? numericFields(gateway.fields) : undefined };
  };

  const toolCase = (id: string, model: string, protocol: Protocol, r: Awaited<ReturnType<typeof request>>, minTools: number): TimingCase => {
    const first = r.marks.tool_items[0]?.at_ms;
    const last = r.marks.tool_items.at(-1)?.at_ms;
    const ok = r.status === 200 && !r.marks.error_type && r.marks.tool_items.length >= minTools && first !== undefined && r.marks.stop_ms !== undefined;
    return {
      id,
      model,
      protocol,
      status: ok ? "pass" : "fail",
      http_status: r.status,
      duration_ms: r.duration_ms,
      first_byte_ms: r.marks.first_byte_ms,
      first_tool_ms: first,
      last_tool_ms: last,
      tool_spread_ms: first !== undefined && last !== undefined ? last - first : undefined,
      tool_names: r.marks.tool_items.map((item) => item.name),
      stop_ms: r.marks.stop_ms,
      stop_reason: r.marks.stop_reason,
      tool_lead_ms: first !== undefined && r.marks.stop_ms !== undefined ? r.marks.stop_ms - first : undefined,
      gateway: r.gateway,
      error_type: r.marks.error_type,
      reason: ok ? undefined : r.marks.error_type ?? (r.marks.tool_items.length < minTools ? "expected_tool_batch" : "no_stop"),
    };
  };

  try {
    const catalog = await fetch(`${child.baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const catalogIds = (((await catalog.json()) as { data?: Array<{ id?: string }> }).data ?? []).map((item) => item.id).filter((id): id is string => Boolean(id));
    if (catalog.status !== 200 || catalogIds.length === 0) throw new Error(`catalog unavailable (${catalog.status})`);

    for (const model of models) {
      if (!catalogIds.includes(model)) {
        cases.push({ id: `${model}/messages`, model, protocol: "messages", status: "catalog_missing" });
        continue;
      }
      const extras = model === "grok-4.6" ? { reasoning_effort: "medium" } : {};
      const text = await request("messages", "/v1/messages", {
        model,
        max_tokens: 64,
        stream: true,
        ...extras,
        messages: [{ role: "user", content: `Reply with the single word PONG and nothing else. (${token()})` }],
      });
      cases.push({
        id: `${model}/messages/text_sse`,
        model,
        protocol: "messages",
        status: text.status === 200 && !text.marks.error_type && text.marks.first_byte_ms !== undefined ? "pass" : "fail",
        http_status: text.status,
        duration_ms: text.duration_ms,
        first_byte_ms: text.marks.first_byte_ms,
        first_text_ms: text.marks.first_text_ms,
        last_text_ms: text.marks.last_text_ms,
        stop_ms: text.marks.stop_ms,
        stop_reason: text.marks.stop_reason,
        text_tail_ms:
          text.marks.last_text_ms !== undefined && text.marks.stop_ms !== undefined ? text.marks.stop_ms - text.marks.last_text_ms : undefined,
        gateway: text.gateway,
        error_type: text.marks.error_type,
      });
      const single = await request("messages", "/v1/messages", {
        model,
        max_tokens: 256,
        stream: true,
        ...extras,
        tools: anthropicTools,
        messages: [{ role: "user", content: singlePrompt() }],
      });
      cases.push(toolCase(`${model}/messages/single_tool`, model, "messages", single, 1));
      const parallel = await request("messages", "/v1/messages", {
        model,
        max_tokens: 256,
        stream: true,
        ...extras,
        tools: anthropicTools,
        messages: [{ role: "user", content: parallelPrompt() }],
      });
      cases.push(toolCase(`${model}/messages/parallel_tools`, model, "messages", parallel, 2));
    }

    if (catalogIds.includes(protocolModel)) {
      const chat = await request("chat", "/v1/chat/completions", {
        model: protocolModel,
        stream: true,
        tools: chatTools,
        messages: [{ role: "user", content: parallelPrompt() }],
      });
      cases.push(toolCase(`${protocolModel}/chat/parallel_tools`, protocolModel, "chat", chat, 1));
      const responses = await request("responses", "/v1/responses", {
        model: protocolModel,
        stream: true,
        tools: responsesTools,
        input: parallelPrompt(),
      });
      cases.push(toolCase(`${protocolModel}/responses/parallel_tools`, protocolModel, "responses", responses, 1));
    }

    const receipt = {
      schema: "cursor-sdk2api.live-timing.v1",
      ok: cases.every((item) => item.status === "pass" || item.status === "catalog_missing"),
      environment: {
        node: process.version,
        runner: "tests/live-smoke/timing",
        gateway_env: passThrough,
        spawn_repo_root: spawnRoot,
        spawn_entry: distEntry,
      },
      cases,
    };
    const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
    assertNoCanary(serialized, canaries);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, serialized, { encoding: "utf8", mode: 0o600 });
    for (const item of cases) {
      const wait = item.gateway?.batch_close_wait_ms;
      const lag = item.gateway?.publish_lag_ms;
      console.log(
        `case ${item.id} ${item.status}${item.duration_ms !== undefined ? ` ${item.duration_ms}ms` : ""}${
          item.first_text_ms !== undefined ? ` first_text=${item.first_text_ms}ms` : ""
        }${item.text_tail_ms !== undefined ? ` text_tail=${item.text_tail_ms}ms` : ""}${
          item.first_tool_ms !== undefined ? ` first_tool=${item.first_tool_ms}ms` : ""
        }${item.tool_spread_ms !== undefined ? ` spread=${item.tool_spread_ms}ms` : ""}${
          item.tool_lead_ms !== undefined ? ` tool_lead=${item.tool_lead_ms}ms` : ""
        }${wait !== undefined ? ` close_wait=${wait}ms` : ""}${lag !== undefined ? ` publish_lag=${lag}ms` : ""}${
          item.reason ? ` ${item.reason}` : ""
        }`,
      );
    }
    console.log(`receipt ${output}`);
    console.log(`ok=${receipt.ok}`);
    exitCode = receipt.ok ? 0 : 1;
  } catch (error) {
    console.error(redactSecrets(error instanceof Error ? error.message : "live timing failed", canaries));
  } finally {
    await child.stop().catch(() => undefined);
    child.cleanup();
  }
  process.exit(exitCode);
}

void main();
