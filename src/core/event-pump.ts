import type { Clock } from "../clock.js";
import { emptyTurn, sdkFailure, timeoutError, upstreamError } from "../errors.js";
import { messageId } from "../ids.js";
import type { AnthropicContentBlock, AssistantTurn, ToolUseBlock } from "../protocols/anthropic/types.js";
import type { SdkDeltaUpdate, SdkRun, SdkStreamEvent, SdkUsage } from "../sdk/port.js";
import { deferredUsage, fromSdkUsage } from "./usage.js";
import type { EarlyEvent, PendingCall, Session } from "./session.js";

export type PumpBoundary =
  | { type: "tools"; turn: AssistantTurn }
  | { type: "final"; turn: AssistantTurn }
  | { type: "error"; error: unknown };

export type DeltaRecord =
  | { kind: "text" | "thinking"; text: string }
  | { kind: "tool_use"; block: ToolUseBlock };

/** How the batch closed and how long after its last tool callback. */
export interface BatchClose {
  reason: "settle_timer" | "idle" | "step_completed" | "carried";
  waitedMs: number;
}

/** Clock stamps for one HTTP response segment; numbers only, never payloads. */
export interface SegmentTiming {
  startedAt: number;
  agentReadyAt?: number;
  firstEventAt?: number;
  firstDeliveryAt?: number;
  /** Latest content or token delta, or tool callback: the last thing the model produced. */
  lastDeltaAt?: number;
  /** First custom tool call the model started emitting, before its execute fired. */
  firstAnnounceAt?: number;
  firstToolAt?: number;
  lastToolAt?: number;
  turnEndedAt?: number;
  /** run.stream() drained and run.wait() settled; after publish when the final rode turn-ended. */
  runSettledAt?: number;
  publishedAt?: number;
  toolCount: number;
  /** Calls that arrived after the previous batch closed and opened this segment. */
  carriedCount?: number;
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
  private idleGeneration = 0;
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
  /**
   * SDK output that arrived after the current batch had already been
   * published, in arrival order. Tool calls open the next segment as its own
   * batch instead of failing the session, so a debounce that closed one call
   * too early costs the client one extra round trip and no model call; text
   * and thinking head that segment's journal. Closing the HTTP response never
   * discards model output.
   */
  private carried: Array<{ kind: "text" | "thinking"; text: string } | { kind: "tool"; call: PendingCall }> = [];
  /**
   * Custom tool calls the model has started emitting whose execute has not
   * fired yet. While any is outstanding the batch is still being generated,
   * so the idle close stays disarmed; the settle cap still applies.
   */
  private readonly announced = new Set<string>();
  /** The model call that produced the open batch has finished generating. */
  private stepCompleted = false;
  lastBatchClose?: BatchClose;
  timing: SegmentTiming;

  constructor(
    private readonly session: Session,
    private readonly run: SdkRun,
    private readonly clock: Clock,
    private readonly settleMs: number,
    private readonly firstEventTimeoutMs: number,
    timing?: Pick<SegmentTiming, "startedAt" | "agentReadyAt">,
    /** Close an open batch after this much SDK silence; 0 leaves only the settle timer. */
    private readonly idleMs = 0,
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
    const between = (from?: number, to?: number) => (from === undefined || to === undefined ? undefined : to - from);
    const fields: Record<string, number | undefined> = {
      agent_ready_ms: since(t.agentReadyAt),
      first_sdk_event_ms: since(t.firstEventAt),
      first_client_write_ms: since(t.firstDeliveryAt),
      turn_ended_ms: since(t.turnEndedAt),
      run_settled_ms: since(t.runSettledAt),
      duration_ms: since(t.publishedAt),
      // Gateway-visible wait between the model's last output and the published stop.
      publish_lag_ms: between(t.lastDeltaAt, t.publishedAt),
      ...(t.toolCount > 0
        ? {
            tool_count: t.toolCount,
            tool_spread_ms: between(t.firstToolAt, t.lastToolAt),
            // How far ahead of its execute the SDK announced the first call; absent when it never did.
            announce_lead_ms: between(t.firstAnnounceAt, t.firstToolAt),
            batch_close_wait_ms: this.lastBatchClose?.waitedMs,
            carried_count: t.carriedCount,
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
    this.stepCompleted = false;
    const now = this.clock.now();
    this.timing = { startedAt: now, agentReadyAt: now, toolCount: 0 };
    if (this.carried.length === 0) return;
    const carried = this.carried;
    this.carried = [];
    let calls = 0;
    for (const item of carried) {
      if (item.kind === "tool") {
        this.openCall(item.call);
        calls += 1;
      } else {
        this.record(item.kind, item.text);
      }
    }
    if (calls === 0) return;
    // The SDK is still waiting on these, so no new generation can interleave:
    // publish them as the whole next batch without waiting on anything.
    this.timing.carriedCount = calls;
    this.flushToolBatch("carried");
  }

  currentMessageId(): string {
    return this.segmentMessageId;
  }

  /** Tool ids of the batch the client has been shown for this segment. */
  publishedToolIds(): string[] {
    if (this.publishedBoundary?.type !== "tools") return [];
    return this.publishedBoundary.turn.blocks.filter((block) => block.type === "tool_use").map((block) => block.id);
  }

  notifyTool(call: PendingCall): void {
    this.announced.delete(call.toolUseId);
    if (this.publishedBoundary?.type === "tools") {
      this.carried.push({ kind: "tool", call });
      return;
    }
    this.markFirstEvent();
    this.openCall(call);
    this.evaluateClose();
    // Settle is the cap: it fires whatever the announce or step signals said.
    const generation = ++this.settleGeneration;
    const flush = () => {
      if (generation !== this.settleGeneration || this.finished) return;
      this.flushToolBatch("settle_timer");
    };
    if (this.settleMs <= 0) {
      queueMicrotask(flush);
      return;
    }
    void this.clock.sleep(this.settleMs).then(flush);
  }

  /**
   * Close an open batch as soon as the model is provably done with it: the
   * step that produced it completed, or no announced call is still waiting
   * for its execute and the SDK has gone quiet for the idle window. While an
   * announced call is outstanding nothing is armed; its execute re-evaluates.
   * A wrong close is survivable because a later call is carried into the next
   * batch, and the settle timer remains the cap.
   */
  private evaluateClose(): void {
    if (this.openBatch.length === 0 || this.finished) return;
    if (this.announced.size > 0) {
      this.idleGeneration += 1;
      return;
    }
    if (this.stepCompleted) {
      this.flushToolBatch("step_completed");
      return;
    }
    this.armIdleClose();
  }

  private armIdleClose(): void {
    if (this.idleMs <= 0) return;
    const generation = ++this.idleGeneration;
    void this.clock.sleep(this.idleMs).then(() => {
      if (generation !== this.idleGeneration || this.finished || this.openBatch.length === 0) return;
      if (this.announced.size > 0) return;
      this.flushToolBatch("idle");
    });
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
    this.markFirstEvent();
    if (update.type === "tool-call-announced") {
      // Already executed (or replayed): nothing is outstanding for this id.
      if (this.session.pending.has(update.callId)) return;
      this.announced.add(update.callId);
      this.timing.firstAnnounceAt ??= this.clock.now();
      // The batch is about to grow; a pending idle close is no longer authoritative.
      this.idleGeneration += 1;
      return;
    }
    if (update.type === "step-completed") {
      this.stepCompleted = true;
      this.evaluateClose();
      return;
    }
    if (update.type === "step-started") {
      this.stepCompleted = false;
      return;
    }
    if (update.type === "turn-ended") {
      this.timing.turnEndedAt = this.clock.now();
      this.stepCompleted = false;
      this.publishFinalFromTurnEnded(update.usage);
      return;
    }
    // Any delta while a batch is open means the model is still generating it.
    this.timing.lastDeltaAt = this.clock.now();
    this.stepCompleted = false;
    this.evaluateClose();
    if (update.type === "token-delta") return;
    if (!update.text) return;
    this.preferOnDelta = true;
    this.record(update.type === "thinking-delta" ? "thinking" : "text", update.text);
  }

  /**
   * `turn-ended` is the SDK's own end-of-turn signal and carries the turn's
   * usage; the run's stream EOF and wait() only confirm it later. Publish the
   * final boundary here when the streamed journal already holds the answer,
   * and leave the EOF path for turns whose text arrives only in the result.
   */
  private publishFinalFromTurnEnded(turnUsage?: SdkUsage): void {
    if (this.finished || this.openBatch.length > 0 || this.publishedBoundary) return;
    if (!this.journalHas("text")) return;
    // Never trade usage for latency: without a number here, wait() still reports one.
    const usage = turnUsage ?? this.run.usage;
    if (!usage) return;
    this.session.usageConfirmed = true;
    this.session.hasSemanticOutput = true;
    this.publish({
      type: "final",
      turn: {
        messageId: this.segmentMessageId,
        sessionId: this.session.sessionId,
        model: this.session.modelId,
        stopReason: "end_turn",
        blocks: blocksFromJournal(this.deltaHistory),
        usage: fromSdkUsage(usage),
      },
    });
  }

  /** Run liveness for the first-event timeout, plus the per-segment stamp. */
  private markFirstEvent(): void {
    this.firstEvent = true;
    this.timing.firstEventAt ??= this.clock.now();
  }

  /** Add a call to the open batch, the journal, and attached sinks. */
  private openCall(call: PendingCall): void {
    this.session.hasSemanticOutput = true;
    this.session.sawToolBatch = true;
    this.openBatch.push(call);
    this.lastCallAt = this.clock.now();
    this.timing.firstToolAt ??= this.lastCallAt;
    this.timing.lastToolAt = this.lastCallAt;
    this.timing.lastDeltaAt = this.lastCallAt;
    this.timing.toolCount += 1;
    const block = toolUseBlock(call);
    this.deltaHistory.push({ kind: "tool_use", block });
    this.deliver((sink) => sink.onToolUse?.(block));
  }

  /** Fan one event out to attached sinks and stamp the first client-visible write. */
  private deliver(send: (sink: ResponseSink) => void): void {
    if (this.sinks.size > 0) this.timing.firstDeliveryAt ??= this.clock.now();
    for (const sink of this.sinks) send(sink);
  }

  /**
   * Append one delta to the segment journal and fan it out. Text that trails a
   * closed tool batch belongs to a response that has already ended, so it is
   * carried to the head of the next segment instead.
   */
  private record(kind: "text" | "thinking", text: string): void {
    if (this.publishedBoundary?.type === "tools") {
      this.carried.push({ kind, text });
      return;
    }
    // A stream snapshot trailing a final that already rode turn-ended repeats streamed text.
    if (this.finished) return;
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
      this.timing.runSettledAt = this.clock.now();
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

  private flushToolBatch(reason: BatchClose["reason"]): void {
    if (this.openBatch.length === 0 || this.finished) return;
    const batch = this.openBatch;
    this.openBatch = [];
    // Invalidate any settle or idle timer still pending for this batch. An
    // announce the settle cap outran is dropped here; its execute is carried.
    this.settleGeneration += 1;
    this.idleGeneration += 1;
    this.announced.clear();
    this.stepCompleted = false;
    this.lastBatchClose = { reason, waitedMs: this.clock.now() - (this.lastCallAt ?? this.clock.now()) };
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
    // A final that rode turn-ended is terminal; the run's later EOF, wait() or
    // transport error must not replace what the client already received.
    if (this.publishedBoundary?.type === "final") return;
    if (boundary.type === "final") this.finished = true;
    if (boundary.type !== "error") this.timing.publishedAt = this.clock.now();
    this.publishedBoundary = boundary;
    const waiters = this.boundaryWaiters;
    this.boundaryWaiters = [];
    for (const waiter of waiters) waiter(boundary);
    for (const sink of this.sinks) sink.onBoundary?.(boundary);
  }
}
