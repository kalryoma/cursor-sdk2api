import type { ServerResponse } from "node:http";
import type { Clock } from "../clock.js";
import type { AnthropicContentBlock, AssistantTurn, ToolUseBlock } from "../protocols/anthropic/types.js";
import type { ResponseSink } from "./event-pump.js";
import type { Session } from "./session.js";

export interface TurnWriter extends ResponseSink {
  finish(turn: AssistantTurn, extra?: { replayed?: boolean }): void;
  fail(error: unknown): void;
}

/**
 * Keep a started SSE response alive through silent stretches such as a long
 * tool-call generation. It never runs before the first protocol event, so
 * pre-semantic recovery, which requires unsent headers, is unaffected.
 */
export function startHeartbeat(ctx: TurnWriterContext, write: () => void): () => void {
  if (ctx.heartbeatMs <= 0) return () => undefined;
  const controller = new AbortController();
  void (async () => {
    try {
      while (!controller.signal.aborted) {
        await ctx.clock.sleep(ctx.heartbeatMs, controller.signal);
        if (ctx.res.destroyed || ctx.res.writableEnded) return;
        write();
      }
    } catch {
      // Aborted: the response finished or failed.
    }
  })();
  return () => controller.abort();
}

/** What a streaming writer has already put on the wire for the current turn. */
export interface WrittenProgress {
  /** Characters of text streamed so far, across every text block in order. */
  textChars: number;
  /** Characters of thinking streamed so far, across every thinking block in order. */
  thinkingChars: number;
  toolIds: ReadonlySet<string>;
}

export type TailSegment =
  | { kind: "text" | "thinking"; text: string; /** Continues the block the writer currently has open. */ continues: boolean }
  | { kind: "tool_use"; block: ToolUseBlock };

/**
 * The part of an ordered turn a writer has not streamed yet, in block order.
 * Streamed deltas are counted per kind, so a fully streamed turn yields no
 * segments and a replayed turn yields every block.
 */
export function unwrittenTail(blocks: AnthropicContentBlock[], written: WrittenProgress): TailSegment[] {
  const tail: TailSegment[] = [];
  let textOffset = 0;
  let thinkingOffset = 0;
  for (const block of blocks) {
    if (block.type === "tool_use") {
      if (!written.toolIds.has(block.id)) tail.push({ kind: "tool_use", block });
      continue;
    }
    if (block.type !== "text" && block.type !== "thinking") continue;
    const full = block.type === "text" ? block.text : block.thinking;
    const offset = block.type === "text" ? textOffset : thinkingOffset;
    const streamed = Math.max(0, Math.min(full.length, (block.type === "text" ? written.textChars : written.thinkingChars) - offset));
    if (streamed < full.length) {
      tail.push({ kind: block.type, text: full.slice(streamed), continues: streamed > 0 });
    }
    if (block.type === "text") textOffset += full.length;
    else thinkingOffset += full.length;
  }
  return tail;
}

export type TurnWriterSession = Pick<Session, "sessionId" | "modelId" | "createdAt">;

export interface TurnWriterContext {
  res: ServerResponse;
  requestId: string;
  session: TurnWriterSession;
  stream: boolean;
  messageId: string;
  clock: Clock;
  heartbeatMs: number;
}

export type TurnWriterFactory = (ctx: TurnWriterContext) => TurnWriter;
