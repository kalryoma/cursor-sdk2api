import type { Clock } from "../clock.js";
import { emptyTurn, sdkFailure, timeoutError, upstreamError } from "../errors.js";
import { messageId } from "../ids.js";
import type { AnthropicContentBlock, AssistantTurn, ToolUseBlock } from "../protocols/anthropic/types.js";
import type { SdkDeltaUpdate, SdkRun, SdkStreamEvent } from "../sdk/port.js";
import { deferredUsage, fromSdkUsage } from "./usage.js";
import type { EarlyEvent, PendingCall, Session } from "./session.js";

export type PumpBoundary =
  | { type: "tools"; turn: AssistantTurn }
  | { type: "final"; turn: AssistantTurn }
  | { type: "error"; error: unknown };

export type DeltaRecord =
  | { kind: "text" | "thinking"; text: string }
  | { kind: "tool_use"; block: ToolUseBlock };

/** How long the batch waited after its last tool callback before closing. */
export interface BatchClose {
  waitedMs: number;
}

/** Clock stamps for one HTTP response segment; numbers only, never payloads. */
export interface SegmentTiming {
  startedAt: number;
  agentReadyAt?: number;
  firstEventAt?: number;
  firstDeliveryAt?: number;
  firstToolAt?: number;
  lastToolAt?: number;
  publishedAt?: number;
  toolCount: number;
}

export interface ResponseSink {
  onThinking?(text: string): void;
  onText?(text: string): void;
  /** A client tool call with its final input, emitted as soon as the SDK requests it. */
  onToolUse?(block: ToolUseBlock): void;
  onBoundary?(boundary: PumpBoundary): void;
}

function toolUseBlock(call: PendingCall): ToolUseBlock {
  return {
    type: "tool_use",
    id: call.toolUseId,
    name: call.name,
    input: call.input,
    ...(call.toolKind ? { tool_kind: call.toolKind } : {}),
    ...(call.namespace ? { namespace: call.namespace } : {}),
  };
}

/**
 * Content blocks in arrival order: consecutive text or thinking deltas fold
 * into one block, tool calls stay where the SDK requested them. Streams, the
 * non-stream body, and replays all derive from this same sequence.
 */
export function blocksFromJournal(records: readonly DeltaRecord[]): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  for (const record of records) {
    if (record.kind === "tool_use") {
      blocks.push(record.block);
      continue;
    }
    const last = blocks.at(-1);
    if (record.kind === "text") {
      if (last?.type === "text") last.text += record.text;
      else blocks.push({ type: "text", text: record.text });
      continue;
    }
    if (last?.type === "thinking") last.thinking += record.text;
    else blocks.push({ type: "thinking", thinking: record.text });
  }
  return blocks;
}

export class EventPump {
  private readonly sinks = new Set<ResponseSink>();
  private openBatch: PendingCall[] = [];
  private settleGeneration = 0;
  private boundaryWaiters: Array<(boundary: PumpBoundary) => void> = [];
  private finished = false;
  private consumer: Promise<void> | undefined;
  private firstEvent = false;
  private error: unknown;
  /** Current response-segment boundary. All same-segment waiters read this. */
  private publishedBoundary?: PumpBoundary;
  /** Deltas for the current HTTP response segment. Replayed to every attach. */
  private readonly deltaHistory: DeltaRecord[] = [];
  /** Once official onDelta is seen, ignore stream assistant/thinking snapshots. */
  private preferOnDelta = false;
  private segmentMessageId = messageId();
  private lastCallAt?: number;
  lastBatchClose?: BatchClose;
  timing: SegmentTiming;

  constructor(
    private readonly session: Session,
    private readonly run: SdkRun,
    private readonly clock: Clock,
    private readonly settleMs: number,
    private readonly firstEventTimeoutMs: number,
    timing?: Pick<SegmentTiming, "startedAt" | "agentReadyAt">,
  ) {
    const now = clock.now();
    this.timing = { startedAt: timing?.startedAt ?? now, agentReadyAt: timing?.agentReadyAt ?? now, toolCount: 0 };
  }

  start(): void {
    if (this.consumer) return;
    this.consumer = this.loop();
  }

  attach(sink: ResponseSink): void {
    this.sinks.add(sink);
    if (this.deltaHistory.length > 0) this.timing.firstDeliveryAt ??= this.clock.now();
    for (const delta of this.deltaHistory) {
      if (delta.kind === "tool_use") sink.onToolUse?.(delta.block);
      else if (delta.kind === "thinking") sink.onThinking?.(delta.text);
      else sink.onText?.(delta.text);
    }
  }

  /** Segment timings relative to the request, for structured logs. */
  timingSummary(): Record<string, number> {
    const t = this.timing;
    const since = (at?: number) => (at === undefined ? undefined : at - t.startedAt);
    const fields: Record<string, number | undefined> = {
      agent_ready_ms: since(t.agentReadyAt),
      first_sdk_event_ms: since(t.firstEventAt),
      first_client_write_ms: since(t.firstDeliveryAt),
      duration_ms: since(t.publishedAt),
      ...(t.toolCount > 0
        ? {
            tool_count: t.toolCount,
            tool_spread_ms: t.lastToolAt !== undefined && t.firstToolAt !== undefined ? t.lastToolAt - t.firstToolAt : undefined,
            batch_close_wait_ms: this.lastBatchClose?.waitedMs,
          }
        : {}),
    };
    return Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, number] => entry[1] !== undefined));
  }

  detach(sink: ResponseSink): void {
    this.sinks.delete(sink);
  }

  /**
   * Start a new HTTP response segment. Only the first real tool_result
   * continuation (awaiting -> resuming) should call this.
   */
  beginNextSegment(): void {
    this.publishedBoundary = undefined;
    this.error = undefined;
    this.deltaHistory.length = 0;
    this.boundaryWaiters = [];
    this.segmentMessageId = messageId();
    this.lastCallAt = undefined;
    this.lastBatchClose = undefined;
    const now = this.clock.now();
    this.timing = { startedAt: now, agentReadyAt: now, toolCount: 0 };
  }

  currentMessageId(): string {
    return this.segmentMessageId;
  }

  notifyTool(call: PendingCall): void {
    if (this.publishedBoundary?.type === "tools") {
      call.resolved = true;
      const error = upstreamError("SDK emitted a tool call after the assistant tool batch closed");
      call.reject(error);
      this.session.state = "failed";
      void this.run.cancel().catch(() => undefined);
      this.fail(error);
      return;
    }
    this.markFirstEvent();
    this.session.hasSemanticOutput = true;
    this.session.sawToolBatch = true;
    this.openBatch.push(call);
    this.lastCallAt = this.clock.now();
    this.timing.firstToolAt ??= this.lastCallAt;
    this.timing.lastToolAt = this.lastCallAt;
    this.timing.toolCount += 1;
    const block = toolUseBlock(call);
    this.deltaHistory.push({ kind: "tool_use", block });
    this.deliver((sink) => sink.onToolUse?.(block));
    const generation = ++this.settleGeneration;
    const flush = () => {
      if (generation !== this.settleGeneration || this.finished) return;
      this.flushToolBatch();
    };
    if (this.settleMs <= 0) {
      queueMicrotask(flush);
      return;
    }
    void this.clock.sleep(this.settleMs).then(flush);
  }

  waitForBoundary(): Promise<PumpBoundary> {
    if (this.publishedBoundary) {
      return Promise.resolve(this.publishedBoundary);
    }
    return new Promise((resolve) => {
      this.boundaryWaiters.push(resolve);
    });
  }

  /** Replay events that arrived before this pump existed, in arrival order. */
  ingestEarly(events: EarlyEvent[]): void {
    for (const event of events) {
      if (event.type === "tool") this.notifyTool(event.call);
      else this.ingestDelta(event.update);
    }
  }

  ingestDelta(update: SdkDeltaUpdate): void {
    if (update.type === "turn-ended") {
      // Per-turn usage is diagnostic only. Cumulative usage is confirmed via run.wait().
      this.markFirstEvent();
      return;
    }
    if (update.type !== "text-delta" && update.type !== "thinking-delta") return;
    if (!update.text) return;
    this.preferOnDelta = true;
    this.markFirstEvent();
    this.record(update.type === "thinking-delta" ? "thinking" : "text", update.text);
  }

  /** Run liveness for the first-event timeout, plus the per-segment stamp. */
  private markFirstEvent(): void {
    this.firstEvent = true;
    this.timing.firstEventAt ??= this.clock.now();
  }

  /** Fan one event out to attached sinks and stamp the first client-visible write. */
  private deliver(send: (sink: ResponseSink) => void): void {
    if (this.sinks.size > 0) this.timing.firstDeliveryAt ??= this.clock.now();
    for (const sink of this.sinks) send(sink);
  }

  /**
   * Append one delta to the segment journal and fan it out. Text that trails a
   * closed tool batch belongs to a response that has already ended; it is
   * dropped rather than leaking into the next segment.
   */
  private record(kind: "text" | "thinking", text: string): void {
    if (this.publishedBoundary?.type === "tools") return;
    this.session.hasSemanticOutput = true;
    this.deltaHistory.push({ kind, text });
    this.deliver((sink) => (kind === "thinking" ? sink.onThinking?.(text) : sink.onText?.(text)));
  }

  private journalHas(kind: DeltaRecord["kind"]): boolean {
    return this.deltaHistory.some((record) => record.kind === kind);
  }

  ingestDeltas(updates: SdkDeltaUpdate[]): void {
    for (const update of updates) this.ingestDelta(update);
  }

  private async loop(): Promise<void> {
    const firstTimer = this.clock.sleep(this.firstEventTimeoutMs).then(() => {
      if (!this.firstEvent && !this.finished) {
        this.fail(timeoutError("Timed out waiting for the first SDK event"));
      }
    });
    try {
      for await (const event of this.run.stream()) {
        this.markFirstEvent();
        this.handle(event);
      }
      // Stream EOF is progress; do not empty-fail before wait().
      this.markFirstEvent();
      const result = await this.run.wait();
      if (this.finished) return;
      if (result.status === "error") {
        this.fail(sdkFailure(result.error?.message ?? "SDK run error"));
        return;
      }
      if (result.status === "cancelled") {
        this.fail(upstreamError("SDK run cancelled", 499));
        return;
      }
      // Streamed text is what the client already saw, so it stays authoritative;
      // the SDK's final result only fills in when nothing streamed.
      if (!this.journalHas("text") && result.result) this.record("text", result.result);
      const blocks = blocksFromJournal(this.deltaHistory);
      if (blocks.length === 0) {
        this.fail(emptyTurn());
        return;
      }
      if (!this.session.usageConfirmed) {
        this.session.usageConfirmed = true;
      }
      this.session.hasSemanticOutput = true;
      this.publish({
        type: "final",
        turn: {
          messageId: this.segmentMessageId,
          sessionId: this.session.sessionId,
          model: this.session.modelId,
          stopReason: "end_turn",
          blocks,
          usage: fromSdkUsage(result.usage),
        },
      });
    } catch (error) {
      this.fail(sdkFailure(error));
    } finally {
      this.finished = true;
      void firstTimer;
    }
  }

  private handle(event: SdkStreamEvent): void {
    if (this.preferOnDelta && (event.type === "thinking" || event.type === "assistant")) {
      return;
    }
    if (event.type === "thinking" && event.text) this.record("thinking", event.text);
    else if (event.type === "assistant" && event.text) this.record("text", event.text);
  }

  private flushToolBatch(): void {
    if (this.openBatch.length === 0 || this.finished) return;
    const batch = this.openBatch;
    this.openBatch = [];
    // Invalidate any settle timer still pending for this batch.
    this.settleGeneration += 1;
    this.lastBatchClose = { waitedMs: this.clock.now() - (this.lastCallAt ?? this.clock.now()) };
    this.lastCallAt = undefined;
    const blocks = blocksFromJournal(this.deltaHistory);
    const journaled = new Set(blocks.filter((block) => block.type === "tool_use").map((block) => block.id));
    for (const call of batch) {
      if (!journaled.has(call.toolUseId)) blocks.push(toolUseBlock(call));
    }
    this.publish({
      type: "tools",
      turn: {
        messageId: this.segmentMessageId,
        sessionId: this.session.sessionId,
        model: this.session.modelId,
        stopReason: "tool_use",
        blocks,
        usage: deferredUsage(),
      },
    });
  }

  private fail(error: unknown): void {
    this.error = error;
    this.publish({ type: "error", error });
  }

  private publish(boundary: PumpBoundary): void {
    if (boundary.type === "final") this.finished = true;
    if (boundary.type !== "error") this.timing.publishedAt = this.clock.now();
    this.publishedBoundary = boundary;
    const waiters = this.boundaryWaiters;
    this.boundaryWaiters = [];
    for (const waiter of waiters) waiter(boundary);
    for (const sink of this.sinks) sink.onBoundary?.(boundary);
  }
}
