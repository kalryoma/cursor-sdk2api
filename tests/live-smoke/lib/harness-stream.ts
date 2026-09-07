/** First semantic byte / stop marks for harness-protocol SSE. No payloads kept. */

export type HarnessProtocol = "messages" | "responses";

export interface HarnessMarks {
  first_byte_ms?: number;
  stop_ms?: number;
  stop_reason?: string;
  error_type?: string;
}

export function parseSseChunk(raw: string): { event: string; data: Record<string, unknown> | null } {
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

export function isSemanticDelta(protocol: HarnessProtocol, item: ReturnType<typeof parseSseChunk>): boolean {
  if (!item.data) return false;
  if (protocol === "messages") {
    const delta = item.data.delta as { type?: string } | undefined;
    const block = item.data.content_block as { type?: string } | undefined;
    if (item.event === "content_block_delta" && (delta?.type === "text_delta" || delta?.type === "thinking_delta")) {
      return true;
    }
    return item.event === "content_block_start" && block?.type === "thinking";
  }
  const type = String(item.data.type ?? item.event);
  return (
    type === "response.output_text.delta" ||
    type === "response.reasoning_summary_text.delta" ||
    type === "response.reasoning.delta"
  );
}

export function classifyHarnessEvent(
  protocol: HarnessProtocol,
  item: ReturnType<typeof parseSseChunk>,
  marks: HarnessMarks,
  now: number,
): void {
  if (isSemanticDelta(protocol, item)) marks.first_byte_ms ??= now;
  if (protocol === "messages") {
    const delta = item.data?.delta as { stop_reason?: string } | undefined;
    if (item.event === "message_delta" && delta?.stop_reason) {
      marks.stop_ms ??= now;
      marks.stop_reason = delta.stop_reason;
    }
    if (item.event === "error") {
      marks.error_type = String((item.data?.error as { type?: string } | undefined)?.type ?? "error");
    }
    return;
  }
  const type = String(item.data?.type ?? item.event);
  if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
    marks.stop_ms ??= now;
    marks.stop_reason = String((item.data?.response as { status?: string } | undefined)?.status ?? type);
  }
  if (type === "error" || type === "response.failed") {
    marks.error_type = String((item.data?.error as { type?: string } | undefined)?.type ?? type);
  }
}

export function pickCatalogId(requested: string[], catalogIds: readonly string[]): string | undefined {
  for (const id of requested) {
    if (catalogIds.includes(id)) return id;
  }
  return undefined;
}
