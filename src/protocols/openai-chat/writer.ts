import { chatCompletionId } from "../../ids.js";
import { startHeartbeat, unwrittenTail, type TurnWriter, type TurnWriterContext, type TurnWriterFactory } from "../../core/turn-writer.js";
import { sendJson, sendOpenAIError, writeSseComment } from "../../server/http-util.js";
import type { AssistantTurn, ToolUseBlock } from "../anthropic/types.js";
import { encodeChatChunk, encodeChatCompletion, encodeChatToolCall, encodeChatUsage, mapChatFinishReason } from "./encode.js";
import { beginChatSse, writeChatDone, writeChatFrame, writeChatStreamError } from "./sse.js";

export function createChatWriterFactory(options: { includeUsage: boolean }): TurnWriterFactory {
  return (ctx) => new ChatTurnWriter(ctx, options.includeUsage);
}

class ChatTurnWriter implements TurnWriter {
  private started = false;
  private roleSent = false;
  private writtenText = 0;
  private writtenThinking = 0;
  private toolIndex = 0;
  private readonly emittedTools = new Set<string>();
  private readonly completionId: string;
  private readonly created: number;
  private stopHeartbeat: () => void = () => undefined;

  constructor(
    private readonly ctx: TurnWriterContext,
    private readonly includeUsage: boolean,
  ) {
    this.completionId = chatCompletionId(ctx.messageId);
    this.created = Math.floor(ctx.session.createdAt / 1000);
  }

  onToolUse(block: ToolUseBlock): void {
    if (!this.ctx.stream || this.dead()) return;
    this.ensureStart();
    this.writeToolCalls([block]);
  }

  onThinking(text: string): void {
    if (!this.ctx.stream || this.dead() || !text) return;
    this.ensureStart();
    this.writeThinking(text);
  }

  onText(text: string): void {
    if (!this.ctx.stream || this.dead() || !text) return;
    this.ensureStart();
    this.writeText(text);
  }

  private writeThinking(text: string): void {
    this.writtenThinking += text.length;
    this.writeDelta({ reasoning_content: text });
  }

  private writeText(text: string): void {
    this.writtenText += text.length;
    this.writeDelta({ content: text });
  }

  finish(turn: AssistantTurn, extra?: { replayed?: boolean }): void {
    this.stopHeartbeat();
    if (!this.ctx.stream) {
      if (!this.dead()) {
        sendJson(this.ctx.res, 200, encodeChatCompletion(turn, this.created, extra?.replayed ? { replayed: true } : {}), this.ctx.requestId, {
          "x-cursor-session-id": turn.sessionId,
        });
      }
      return;
    }
    if (this.dead()) return;
    this.ensureStart();
    this.stopHeartbeat();
    this.emitRemaining(turn);
    writeChatFrame(
      this.ctx.res,
      encodeChatChunk({
        id: this.completionId,
        created: this.created,
        model: this.ctx.session.modelId,
        delta: {},
        finishReason: mapChatFinishReason(turn.stopReason),
        ...(extra?.replayed ? { extra: { replayed: true } } : {}),
      }),
    );
    if (this.includeUsage) {
      writeChatFrame(
        this.ctx.res,
        encodeChatChunk({
          id: this.completionId,
          created: this.created,
          model: this.ctx.session.modelId,
          emptyChoices: true,
          usage: encodeChatUsage(turn),
        }),
      );
    }
    writeChatDone(this.ctx.res);
    this.ctx.res.end();
  }

  fail(error: unknown): void {
    this.stopHeartbeat();
    if (this.dead()) return;
    if (this.ctx.stream && this.ctx.res.headersSent) {
      writeChatStreamError(this.ctx.res, error, this.ctx.requestId);
      this.ctx.res.end();
      return;
    }
    sendOpenAIError(this.ctx.res, error, this.ctx.requestId);
  }

  /** Write whatever the turn holds that was not streamed, in block order. */
  private emitRemaining(turn: AssistantTurn): void {
    if (this.dead()) return;
    const tail = unwrittenTail(turn.blocks, {
      textChars: this.writtenText,
      thinkingChars: this.writtenThinking,
      toolIds: this.emittedTools,
    });
    for (const segment of tail) {
      if (segment.kind === "tool_use") this.writeToolCalls([segment.block]);
      else if (segment.kind === "thinking") this.writeThinking(segment.text);
      else this.writeText(segment.text);
    }
  }

  private writeToolCalls(blocks: ToolUseBlock[]): void {
    if (blocks.length === 0) return;
    const toolCalls = blocks.map((block) => {
      this.emittedTools.add(block.id);
      return { index: this.toolIndex++, ...encodeChatToolCall(block) };
    });
    this.writeDelta({ tool_calls: toolCalls });
  }

  private writeDelta(delta: Record<string, unknown>): void {
    writeChatFrame(
      this.ctx.res,
      encodeChatChunk({
        id: this.completionId,
        created: this.created,
        model: this.ctx.session.modelId,
        delta,
      }),
    );
  }

  private ensureStart(): void {
    if (this.dead()) return;
    if (!this.started) {
      this.started = true;
      beginChatSse(this.ctx.res, this.ctx.requestId, this.ctx.session.sessionId);
      this.stopHeartbeat = startHeartbeat(this.ctx, () => writeSseComment(this.ctx.res, "ping"));
    }
    if (this.roleSent) return;
    this.roleSent = true;
    this.writeDelta({ role: "assistant" });
  }

  private dead(): boolean {
    return this.ctx.res.destroyed || this.ctx.res.writableEnded;
  }
}
