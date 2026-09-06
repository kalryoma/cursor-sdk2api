import { responseId } from "../../ids.js";
import type { AnthropicContentBlock, AssistantTurn } from "../anthropic/types.js";
import type { ResponsesStatus } from "./types.js";

export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens_details: { reasoning_tokens: number };
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  usage_deferred?: boolean;
  usage_status?: "sdk" | "unavailable" | "deferred";
}

export function encodeResponsesUsage(turn: AssistantTurn): ResponsesUsage {
  const cached =
    typeof turn.usage.cache_read_input_tokens === "number" ? turn.usage.cache_read_input_tokens : 0;
  const usage: ResponsesUsage = {
    input_tokens: turn.usage.input_tokens,
    output_tokens: turn.usage.output_tokens,
    total_tokens: turn.usage.input_tokens + turn.usage.output_tokens,
    input_tokens_details: { cached_tokens: cached },
    output_tokens_details: { reasoning_tokens: turn.usage.reasoning_tokens ?? 0 },
  };
  if (typeof turn.usage.cache_read_input_tokens === "number") {
    usage.cache_read_input_tokens = turn.usage.cache_read_input_tokens;
  }
  if (typeof turn.usage.cache_creation_input_tokens === "number") {
    usage.cache_creation_input_tokens = turn.usage.cache_creation_input_tokens;
  }
  if (turn.usage.usage_deferred) usage.usage_deferred = true;
  if (turn.usage.usage_status) usage.usage_status = turn.usage.usage_status;
  return usage;
}

export function mapResponseStatus(stopReason: AssistantTurn["stopReason"]): {
  status: ResponsesStatus;
  incomplete_details: { reason: string } | null;
} {
  if (stopReason === "max_tokens") {
    return { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
  }
  return { status: "completed", incomplete_details: null };
}

export function reasoningItemId(messageId: string): string {
  if (messageId.startsWith("msg_")) return `rs_${messageId.slice(4)}`;
  if (messageId.startsWith("resp_")) return `rs_${messageId.slice(5)}`;
  return `rs_${messageId}`;
}

export function functionCallItemId(callId: string): string {
  return callId.startsWith("fc_") ? callId : `fc_${callId}`;
}

/**
 * Id seed for the n-th reasoning or message item of a turn. The first item of
 * a kind derives from the message id; later ones, reopened after a tool call,
 * add their output index. The stream writer and the final encoder both use
 * this so `response.completed.output` matches the streamed items.
 */
export function responsesItemSeed(messageId: string, ordinal: number, outputIndex: number): string {
  return ordinal === 0 ? messageId : `${messageId}_${outputIndex}`;
}

export function encodeReasoningItem(messageId: string, text: string): Record<string, unknown> {
  return {
    id: reasoningItemId(messageId),
    type: "reasoning",
    summary: text ? [{ type: "summary_text", text }] : [],
  };
}

export function encodeMessageItem(messageId: string, text: string, status = "completed"): Record<string, unknown> {
  return {
    id: messageId,
    type: "message",
    status,
    role: "assistant",
    content: text
      ? [{ type: "output_text", text, annotations: [] }]
      : [],
  };
}

export function encodeFunctionCallItem(
  block: Extract<AnthropicContentBlock, { type: "tool_use" }>,
  status = "completed",
): Record<string, unknown> {
  return {
    id: functionCallItemId(block.id),
    type: "function_call",
    status,
    call_id: block.id,
    name: block.name,
    arguments: JSON.stringify(block.input ?? {}),
    ...(block.namespace ? { namespace: block.namespace } : {}),
  };
}

export function encodeCustomToolCallItem(
  block: Extract<AnthropicContentBlock, { type: "tool_use" }>,
  status = "completed",
): Record<string, unknown> {
  const record = block.input && typeof block.input === "object" ? block.input as Record<string, unknown> : {};
  return {
    id: functionCallItemId(block.id),
    type: "custom_tool_call",
    status,
    call_id: block.id,
    name: block.name,
    input: typeof record.input === "string" ? record.input : JSON.stringify(block.input ?? ""),
    ...(block.namespace ? { namespace: block.namespace } : {}),
  };
}

/** Output items in block order; one item per contiguous thinking or text run. */
export function encodeResponsesOutput(turn: AssistantTurn): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  let reasoningOrdinal = 0;
  let messageOrdinal = 0;
  for (const block of turn.blocks) {
    const outputIndex = output.length;
    if (block.type === "thinking") {
      if (!block.thinking) continue;
      output.push(encodeReasoningItem(responsesItemSeed(turn.messageId, reasoningOrdinal++, outputIndex), block.thinking));
    } else if (block.type === "text") {
      if (!block.text) continue;
      output.push(encodeMessageItem(responsesItemSeed(turn.messageId, messageOrdinal++, outputIndex), block.text));
    } else if (block.type === "tool_use") {
      output.push(block.tool_kind === "custom" ? encodeCustomToolCallItem(block) : encodeFunctionCallItem(block));
    }
  }
  return output;
}

export function encodeResponse(
  turn: AssistantTurn,
  createdAt: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const { status, incomplete_details } = mapResponseStatus(turn.stopReason);
  return {
    id: responseId(turn.messageId),
    object: "response",
    created_at: createdAt,
    status,
    error: null,
    incomplete_details,
    model: turn.model,
    output: encodeResponsesOutput(turn),
    usage: encodeResponsesUsage(turn),
    cursor_session_id: turn.sessionId,
    ...extra,
  };
}

export function encodeInProgressResponse(input: {
  id: string;
  createdAt: number;
  model: string;
  sessionId: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    object: "response",
    created_at: input.createdAt,
    status: "in_progress",
    error: null,
    incomplete_details: null,
    model: input.model,
    output: [],
    usage: null,
    cursor_session_id: input.sessionId,
  };
}

export function textOf(blocks: AnthropicContentBlock[], type: "text" | "thinking"): string {
  return blocks
    .filter((block) => block.type === type)
    .map((block) => (block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : ""))
    .join("");
}
