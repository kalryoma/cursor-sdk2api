/**
 * Collect one harness-protocol SSE turn: timings, tool names, and in-memory
 * tool calls needed to continue. Receipts must never persist args or text.
 */
import {
  classifyHarnessEvent,
  parseSseChunk,
  type HarnessMarks,
  type HarnessProtocol,
} from "./harness-stream.js";

export interface HarnessToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface HarnessTurnMarks extends HarnessMarks {
  first_tool_ms?: number;
  tool_items: Array<{ name: string; at_ms: number }>;
  tool_calls: HarnessToolCall[];
  text_chars: number;
  session_id?: string;
}

interface OpenTool {
  id: string;
  name: string;
  json: string;
}

export function emptyHarnessTurn(): HarnessTurnMarks {
  return { tool_items: [], tool_calls: [], text_chars: 0 };
}

export function collectHarnessEvent(
  protocol: HarnessProtocol,
  item: ReturnType<typeof parseSseChunk>,
  marks: HarnessTurnMarks,
  now: number,
  open: Map<string, OpenTool>,
): void {
  classifyHarnessEvent(protocol, item, marks, now);
  if (protocol === "messages") {
    collectMessages(item, marks, now, open);
    return;
  }
  collectResponses(item, marks, now, open);
}

function collectMessages(
  item: ReturnType<typeof parseSseChunk>,
  marks: HarnessTurnMarks,
  now: number,
  open: Map<string, OpenTool>,
): void {
  const data = item.data;
  if (!data) return;
  if (item.event === "message_start") {
    const message = data.message as { cursor_session_id?: string } | undefined;
    if (typeof message?.cursor_session_id === "string") marks.session_id = message.cursor_session_id;
  }
  const index = typeof data.index === "number" ? String(data.index) : "";
  const block = data.content_block as { type?: string; id?: string; name?: string } | undefined;
  const delta = data.delta as { type?: string; text?: string; partial_json?: string } | undefined;
  if (item.event === "content_block_start" && block?.type === "tool_use" && block.id && block.name) {
    marks.first_tool_ms ??= now;
    marks.tool_items.push({ name: block.name, at_ms: now });
    open.set(index, { id: block.id, name: block.name, json: "" });
    return;
  }
  if (item.event === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
    marks.text_chars += delta.text.length;
    return;
  }
  if (item.event === "content_block_delta" && delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
    const current = open.get(index);
    if (current) current.json += delta.partial_json;
    return;
  }
  if (item.event === "content_block_stop" && open.has(index)) {
    const current = open.get(index)!;
    open.delete(index);
    marks.tool_calls.push({ id: current.id, name: current.name, input: parseObject(current.json) });
  }
}

function collectResponses(
  item: ReturnType<typeof parseSseChunk>,
  marks: HarnessTurnMarks,
  now: number,
  open: Map<string, OpenTool>,
): void {
  const data = item.data;
  if (!data) return;
  const type = String(data.type ?? item.event);
  const response = data.response as { cursor_session_id?: string } | undefined;
  if (typeof response?.cursor_session_id === "string") marks.session_id = response.cursor_session_id;

  if (type === "response.output_text.delta" && typeof data.delta === "string") {
    marks.text_chars += data.delta.length;
  }

  const added = data.item as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
  if (type === "response.output_item.added" && added?.type === "function_call" && added.call_id && added.name) {
    marks.first_tool_ms ??= now;
    marks.tool_items.push({ name: added.name, at_ms: now });
    open.set(added.call_id, { id: added.call_id, name: added.name, json: added.arguments ?? "" });
    return;
  }
  if (type === "response.function_call_arguments.delta") {
    const id = String(data.item_id ?? "");
    const match = [...open.values()].find((call) => functionCallItemId(call.id) === id) ?? open.get(String(data.call_id ?? ""));
    if (match && typeof data.delta === "string") match.json += data.delta;
    return;
  }
  if (type === "response.function_call_arguments.done") {
    const args = typeof data.arguments === "string" ? data.arguments : "";
    const name = typeof data.name === "string" ? data.name : "";
    const callId = callIdFromDone(data, open);
    if (!callId) return;
    const current = open.get(callId) ?? { id: callId, name, json: "" };
    current.name = current.name || name;
    current.json = args || current.json;
    open.set(callId, current);
    return;
  }
  if (type === "response.output_item.done") {
    const done = data.item as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
    if (done?.type !== "function_call" || !done.call_id) return;
    const current = open.get(done.call_id) ?? { id: done.call_id, name: done.name ?? "tool", json: "" };
    current.name = done.name || current.name;
    current.json = done.arguments || current.json;
    open.delete(done.call_id);
    if (!marks.tool_calls.some((call) => call.id === current.id)) {
      marks.first_tool_ms ??= now;
      if (!marks.tool_items.some((item) => item.name === current.name && item.at_ms === now)) {
        if (!marks.tool_items.some((item) => item.name === current.name)) {
          marks.tool_items.push({ name: current.name, at_ms: now });
        }
      }
      marks.tool_calls.push({ id: current.id, name: current.name, input: parseObject(current.json) });
    }
  }
}

function callIdFromDone(data: Record<string, unknown>, open: Map<string, OpenTool>): string | undefined {
  if (typeof data.call_id === "string") return data.call_id;
  const itemId = typeof data.item_id === "string" ? data.item_id : "";
  const match = [...open.entries()].find(([, call]) => functionCallItemId(call.id) === itemId);
  return match?.[0];
}

function functionCallItemId(callId: string): string {
  return callId.startsWith("fc_") ? callId : `fc_${callId}`;
}

function parseObject(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function flushOpenTools(marks: HarnessTurnMarks, open: Map<string, OpenTool>): void {
  for (const current of open.values()) {
    if (marks.tool_calls.some((call) => call.id === current.id)) continue;
    marks.tool_calls.push({ id: current.id, name: current.name, input: parseObject(current.json) });
  }
  open.clear();
}

export function receiptToolNames(marks: HarnessTurnMarks): string[] {
  return marks.tool_items.map((item) => item.name);
}

export async function readHarnessTurn(
  res: Response,
  started: number,
  protocol: HarnessProtocol,
): Promise<HarnessTurnMarks> {
  const marks = emptyHarnessTurn();
  const open = new Map<string, OpenTool>();
  const sessionHeader = res.headers.get("x-cursor-session-id");
  if (sessionHeader) marks.session_id = sessionHeader;
  if (!res.body) {
    if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      marks.error_type = "not_sse";
    }
    return marks;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const drain = (final: boolean) => {
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (raw.trim()) collectHarnessEvent(protocol, parseSseChunk(raw), marks, Date.now() - started, open);
      index = buffer.indexOf("\n\n");
    }
    if (final && buffer.trim()) collectHarnessEvent(protocol, parseSseChunk(buffer), marks, Date.now() - started, open);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    drain(false);
  }
  buffer += decoder.decode();
  drain(true);
  flushOpenTools(marks, open);
  return marks;
}
