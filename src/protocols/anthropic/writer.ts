import { startHeartbeat, unwrittenTail, type TurnWriter, type TurnWriterContext } from "../../core/turn-writer.js";
import { toPublicErrorBody } from "../../errors.js";
import { sendError, sendJson, writeSse } from "../../server/http-util.js";
import { encodeMessage } from "./encode.js";
import {
  beginSse,
  writeBlockStop,
  writeMessageStart,
  writeMessageStop,
  writeCompletedTurn,
  writeSseError,
  writeTerminalStop,
  writeTextDelta,
  writeThinkingDelta,
  writeToolUse,
} from "./sse.js";
import type { AssistantTurn, ToolUseBlock } from "./types.js";

export function createAnthropicWriter(ctx: TurnWriterContext): TurnWriter {
  return new AnthropicTurnWriter(ctx);
}

class AnthropicTurnWriter implements TurnWriter {
  private started = false;
  private failed = false;
  private nextIndex = 0;
  private open?: { kind: "thinking" | "text"; index: number };
  private writtenText = 0;
  private writtenThinking = 0;
  private readonly emittedTools = new Set<string>();
  private stopHeartbeat: () => void = () => undefined;

  constructor(private readonly ctx: TurnWriterContext) {}

  onToolUse(block: ToolUseBlock): void {
    if (!this.ctx.stream || this.dead()) return;
    this.ensureStart();
    this.writeTool(block);
  }

  onThinking(text: string): void {
    if (!this.ctx.stream || this.dead()) return;
    this.ensureStart();
    this.appendDelta("thinking", text);
  }

  onText(text: string): void {
    if (!this.ctx.stream || this.dead()) return;
    this.ensureStart();
    this.appendDelta("text", text);
  }

  finish(turn: AssistantTurn, extra?: { replayed?: boolean }): void {
    this.stopHeartbeat();
    if (!this.ctx.stream) {
      if (!this.dead()) {
        sendJson(
          this.ctx.res,
          200,
          encodeMessage(turn, extra?.replayed ? { replayed: true } : {}),
          this.ctx.requestId,
          { "x-cursor-session-id": turn.sessionId },
        );
      }
      return;
    }
    if (this.dead()) return;
    if (extra?.replayed) {
      writeCompletedTurn(this.ctx.res, turn, this.ctx.requestId);
      return;
    }
    this.ensureStart();
    this.stopHeartbeat();
    const tail = unwrittenTail(turn.blocks, {
      textChars: this.writtenText,
      thinkingChars: this.writtenThinking,
      toolIds: this.emittedTools,
    });
    for (const segment of tail) {
      if (segment.kind === "tool_use") this.writeTool(segment.block);
      else this.appendDelta(segment.kind, segment.text);
    }
    this.closeOpen();
    writeMessageStop(this.ctx.res, turn);
    this.ctx.res.end();
  }

  fail(error: unknown): void {
    this.stopHeartbeat();
    if (this.failed || this.dead()) return;
    this.failed = true;
    if (this.ctx.stream && this.ctx.res.headersSent) {
      this.closeOpen();
      writeTerminalStop(this.ctx.res);
      writeSseError(this.ctx.res, toPublicErrorBody(error, this.ctx.requestId));
      this.ctx.res.end();
      return;
    }
    sendError(this.ctx.res, error, this.ctx.requestId);
  }

  private writeTool(block: ToolUseBlock): void {
    this.closeOpen();
    writeToolUse(this.ctx.res, this.nextIndex++, block);
    this.emittedTools.add(block.id);
  }

  /** Blocks are contiguous runs: a kind change closes the open block. */
  private appendDelta(kind: "thinking" | "text", text: string): void {
    if (this.open?.kind !== kind) {
      this.closeOpen();
      const index = this.nextIndex++;
      if (kind === "thinking") writeThinkingDelta(this.ctx.res, index, "", false);
      else writeTextDelta(this.ctx.res, index, "", false);
      this.open = { kind, index };
    }
    if (!text || !this.open) return;
    if (kind === "thinking") {
      writeThinkingDelta(this.ctx.res, this.open.index, text, true);
      this.writtenThinking += text.length;
    } else {
      writeTextDelta(this.ctx.res, this.open.index, text, true);
      this.writtenText += text.length;
    }
  }

  private closeOpen(): void {
    if (!this.open || this.dead()) {
      this.open = undefined;
      return;
    }
    writeBlockStop(this.ctx.res, this.open.index);
    this.open = undefined;
  }

  private ensureStart(): void {
    if (this.started || this.dead()) return;
    this.started = true;
    beginSse(this.ctx.res, this.ctx.requestId, this.ctx.session.sessionId);
    writeMessageStart(this.ctx.res, {
      messageId: this.ctx.messageId,
      model: this.ctx.session.modelId,
      sessionId: this.ctx.session.sessionId,
    });
    // Same shape the Anthropic API sends between events; clients already ignore it.
    this.stopHeartbeat = startHeartbeat(this.ctx, () => writeSse(this.ctx.res, "ping", { type: "ping" }));
  }

  private dead(): boolean {
    return this.ctx.res.destroyed || this.ctx.res.writableEnded;
  }
}
