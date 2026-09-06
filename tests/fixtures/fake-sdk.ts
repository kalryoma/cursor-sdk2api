import { randomUUID } from "node:crypto";
import {
  AMBIENT_DISALLOWED_TOOLS,
  apiProfileToolAllowlist,
  type CreateAgentInput,
  type ResumeAgentInput,
  type SdkAccountResult,
  type SdkAgent,
  type SdkCatalogResult,
  type SdkCustomTool,
  type SdkDeltaHandler,
  type SdkDeltaUpdate,
  type SdkRun,
  type SdkRunResult,
  type SdkRuntime,
  type SdkSendInput,
  type SdkStreamEvent,
  type SdkUsage,
} from "../../src/sdk/port.js";

export type FakeStep =
  | { type: "text"; chunks: string[]; pauseBetweenMs?: number; early?: boolean }
  | { type: "thinking"; chunks: string[]; early?: boolean }
  | { type: "send-tools"; calls: Array<{ name: string; input: Record<string, unknown>; id?: string }> }
  | {
      type: "tools";
      /** `delayMs` staggers a call's dispatch, as the live SDK does between calls of one generation. */
      calls: Array<{ name: string; input: Record<string, unknown>; id?: string; delayMs?: number }>;
      /** Text the model emits after requesting the tools, while their results are still pending. */
      trailingText?: string[];
      /** Delay before the trailing text; longer than the settle timer puts it after the batch closed. */
      trailingTextDelayMs?: number;
    }
  | { type: "silent-final"; text: string }
  | { type: "empty" }
  | { type: "error"; message: string }
  | { type: "send-error"; message: string; name?: string }
  | { type: "hang" };

export interface FakeSdkOptions {
  scripts?: FakeStep[][];
  /** Per-agent script sets, consumed in create/resume order. */
  agentScripts?: FakeStep[][][];
  models?: SdkCatalogResult;
  modelsByApiKey?: Record<string, SdkCatalogResult>;
  account?: SdkAccountResult;
  accountsByApiKey?: Record<string, SdkAccountResult>;
  sdkVersion?: string;
  finalUsage?: SdkUsage;
  liveUsage?: SdkUsage;
  createError?: { message: string; name?: string };
  createErrorsByApiKey?: Record<string, { message: string; name?: string } | Array<{ message: string; name?: string }>>;
  credentialProbeByApiKey?: Record<string, "valid" | "invalid" | "unavailable">;
  resumeError?: { message: string; name?: string };
  /** Invoke these custom tools synchronously inside resumeAgent(), before the Agent is returned. */
  resumeEarlyToolCalls?: Array<{ name: string; input: Record<string, unknown>; id?: string }>;
  /**
   * Mirror an account without SDK systemPrompt access: create/resume succeed and
   * the first run of an agent created with systemPrompt fails naming the flag.
   * Live SDK 1.0.31 reports it through the run stream ("run", default); "send"
   * rejects the send() promise instead.
   */
  systemPromptGated?: boolean | "run" | "send";
}

const SYSTEM_PROMPT_GATE_MESSAGE = "[invalid_argument] unknown option '--system-prompt'";

type FakeToolStep = Extract<FakeStep, { type: "tools" }>;

/** Steps the fake fires inside send(), before the run is returned. */
function firesDuringSend(step: FakeStep): boolean {
  return step.type === "send-tools" || ((step.type === "text" || step.type === "thinking") && step.early === true);
}

function configuredError(input: { message: string; name?: string }): Error {
  const error = new Error(input.message);
  if (input.name) error.name = input.name;
  return error;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(item: IteratorResult<T>) => void> = [];
  private ended = false;
  readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor() {
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined as T, done: true });
    }
    this.resolveDone();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift() as T, done: false });
        }
        if (this.ended) return Promise.resolve({ value: undefined as T, done: true });
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

export class FakeRun implements SdkRun {
  readonly id: string;
  requestId?: string;
  usage?: SdkUsage;
  streamStarts = 0;
  waitCalls = 0;
  cancelled = false;
  capturedToolResults: unknown[] = [];
  onDeltaCalls: SdkDeltaUpdate[] = [];
  streamSnapshots: SdkStreamEvent[] = [];
  private readonly events = new AsyncQueue<SdkStreamEvent>();
  private result: SdkRunResult;
  private scriptStarted = false;
  private hanging = false;
  private earlyOnDeltaRemaining = 0;

  constructor(
    private readonly script: FakeStep[],
    private readonly tools: Record<string, SdkCustomTool>,
    private readonly finalUsage: SdkUsage | undefined,
    liveUsage: SdkUsage | undefined,
    private readonly onDelta?: SdkDeltaHandler,
    earlyOnDeltaRemaining = 0,
  ) {
    this.id = `run_${randomUUID()}`;
    this.requestId = randomUUID();
    this.usage = liveUsage;
    this.result = { id: this.id, status: "finished" };
    this.earlyOnDeltaRemaining = earlyOnDeltaRemaining;
  }

  async emitEarlyForTest(update: SdkDeltaUpdate): Promise<void> {
    await this.emitDelta(update);
  }

  private async emitDelta(update: SdkDeltaUpdate): Promise<void> {
    this.onDeltaCalls.push(update);
    await this.onDelta?.(update);
  }

  /**
   * Mirrors the live SDK: calls of one generation are dispatched one after
   * another (optionally staggered by `delayMs`) and the run only proceeds once
   * every execute() promise has resolved. No delta marks the end of the batch.
   */
  private async runToolStep(step: FakeToolStep): Promise<void> {
    const calls = step.calls.map((call) => ({ ...call, id: call.id ?? `sdk_${randomUUID()}` }));
    const results = calls.map((call) =>
      (async () => {
        if (call.delayMs) await new Promise((resolve) => setTimeout(resolve, call.delayMs));
        const tool = this.tools[call.name];
        if (!tool) throw new Error(`fake sdk missing tool ${call.name}`);
        return Promise.resolve(tool.execute(call.input, { toolCallId: call.id }));
      })().then((result) => {
        this.capturedToolResults.push(result);
        return result;
      }),
    );
    // Rejections are observed by Promise.all(results) below; keep them handled meanwhile.
    for (const result of results) void result.catch(() => undefined);
    if (step.trailingText?.length && step.trailingTextDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, step.trailingTextDelayMs));
    }
    for (const chunk of step.trailingText ?? []) {
      await this.emitDelta({ type: "text-delta", text: chunk });
      const snapshot = { type: "assistant" as const, text: chunk };
      this.streamSnapshots.push(snapshot);
      this.events.push(snapshot);
    }
    await Promise.all(results);
  }

  stream(): AsyncIterable<SdkStreamEvent> {
    this.streamStarts += 1;
    if (this.streamStarts > 1) {
      throw new Error("SDK run.stream() is single-consumer");
    }
    if (!this.scriptStarted) {
      this.scriptStarted = true;
      void this.runScript();
    }
    return this.events;
  }

  async wait(): Promise<SdkRunResult> {
    this.waitCalls += 1;
    await this.events.done;
    return { ...this.result, usage: this.finalUsage };
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.result = { id: this.id, status: "cancelled" };
    this.events.end();
  }

  private async runScript(): Promise<void> {
    let finalText = "";
    try {
      for (const step of this.script) {
        if (this.cancelled) break;
        if (step.type === "text") {
          for (const [index, chunk] of step.chunks.entries()) {
            if (index > 0 && step.pauseBetweenMs) {
              await new Promise((resolve) => setTimeout(resolve, step.pauseBetweenMs));
            }
            if (this.cancelled) break;
            finalText += chunk;
            if (this.earlyOnDeltaRemaining > 0) this.earlyOnDeltaRemaining -= 1;
            else await this.emitDelta({ type: "text-delta", text: chunk });
            const snapshot = { type: "assistant" as const, text: chunk };
            this.streamSnapshots.push(snapshot);
            this.events.push(snapshot);
          }
        } else if (step.type === "thinking") {
          for (const chunk of step.chunks) {
            if (this.earlyOnDeltaRemaining > 0) this.earlyOnDeltaRemaining -= 1;
            else await this.emitDelta({ type: "thinking-delta", text: chunk });
            const snapshot = { type: "thinking" as const, text: chunk };
            this.streamSnapshots.push(snapshot);
            this.events.push(snapshot);
          }
        } else if (step.type === "tools") {
          await this.runToolStep(step);
        } else if (step.type === "silent-final") {
          finalText = step.text;
        } else if (step.type === "empty") {
          finalText = "";
        } else if (step.type === "error") {
          this.result = { id: this.id, status: "error", error: { message: step.message } };
          this.events.end();
          return;
        } else if (step.type === "hang") {
          this.hanging = true;
          return;
        }
      }
      this.result = {
        id: this.id,
        requestId: this.requestId,
        status: "finished",
        result: finalText || undefined,
        usage: this.finalUsage,
      };
      if (this.onDelta && finalText && this.finalUsage) {
        await this.emitDelta({ type: "turn-ended", usage: this.finalUsage });
      }
      this.events.end();
    } catch (error) {
      this.result = {
        id: this.id,
        status: "error",
        error: { message: error instanceof Error ? error.message : "fake run failed" },
      };
      this.events.end();
    } finally {
      if (!this.hanging) this.events.end();
    }
  }
}

export class FakeAgent implements SdkAgent {
  readonly agentId: string;
  readonly runs: FakeRun[] = [];
  lastSend?: SdkSendInput;
  closed = false;
  sendCount = 0;

  constructor(
    readonly input: CreateAgentInput,
    private readonly scripts: FakeStep[][],
    private readonly finalUsage: SdkUsage | undefined,
    private readonly liveUsage: SdkUsage | undefined,
    agentId?: string,
    private readonly systemPromptGated: boolean | "run" | "send" = false,
  ) {
    this.agentId = agentId ?? `agent-${randomUUID()}`;
  }

  async send(sendInput: SdkSendInput): Promise<SdkRun> {
    this.lastSend = sendInput;
    const gated = this.systemPromptGated && this.input.systemPrompt && this.sendCount === 0;
    if (gated && this.systemPromptGated === "send") {
      this.sendCount += 1;
      throw Object.assign(new Error(SYSTEM_PROMPT_GATE_MESSAGE), { code: "invalid_argument" });
    }
    const script = gated
      ? [{ type: "error" as const, message: SYSTEM_PROMPT_GATE_MESSAGE }]
      : this.scripts[Math.min(this.sendCount, this.scripts.length - 1)] ?? [{ type: "text", chunks: ["ok"] }];
    this.sendCount += 1;
    const sendError = script.find((step) => step.type === "send-error");
    if (sendError?.type === "send-error") {
      const error = new Error(sendError.message);
      if (sendError.name) error.name = sendError.name;
      throw error;
    }
    // The leading run of early steps fires here, in script order, so a test can
    // interleave early deltas and synchronous tool dispatch the way the live
    // SDK can before send() resolves.
    const leading: FakeStep[] = [];
    for (const step of script) {
      if (!firesDuringSend(step)) break;
      leading.push(step);
    }
    const earlyCount = leading.reduce((count, step) => count + ("chunks" in step ? step.chunks.length : 0), 0);
    const customTools = sendInput.customTools ?? this.input.customTools;
    const run = new FakeRun(script, customTools, this.finalUsage, this.liveUsage, sendInput.onDelta ?? sendInput.onEvent, earlyCount);
    this.runs.push(run);
    for (const step of leading) {
      if (step.type === "send-tools") {
        for (const call of step.calls) {
          const tool = customTools[call.name];
          if (!tool) throw new Error(`fake sdk missing tool ${call.name}`);
          void Promise.resolve(tool.execute(call.input, { toolCallId: call.id ?? `sdk_${randomUUID()}` })).then((result) => {
            run.capturedToolResults.push(result);
          });
        }
        continue;
      }
      if (step.type !== "text" && step.type !== "thinking") continue;
      const kind = step.type === "thinking" ? "thinking-delta" : "text-delta";
      for (const chunk of step.chunks) {
        await run.emitEarlyForTest({ type: kind, text: chunk });
      }
    }
    return run;
  }

  close(): void {
    this.closed = true;
  }
}

export class FakeSdk implements SdkRuntime {
  readonly sdkVersion: string;
  readonly agents: FakeAgent[] = [];
  readonly createCalls: CreateAgentInput[] = [];
  lastCreate?: CreateAgentInput;
  lastResume?: ResumeAgentInput;
  resumeCalls: ResumeAgentInput[] = [];
  lastAllowlist?: string[];
  lastDisallowed: readonly string[] = AMBIENT_DISALLOWED_TOOLS;
  models: SdkCatalogResult;
  account: SdkAccountResult;
  listModelsCalls = 0;
  readonly listModelsApiKeys: string[] = [];
  getAccountCalls = 0;
  readonly getAccountApiKeys: string[] = [];
  private agentScriptIndex = 0;
  private readonly keyedCreateErrorIndexes = new Map<string, number>();
  readonly credentialProbeCalls: string[] = [];

  constructor(private readonly options: FakeSdkOptions = {}) {
    this.sdkVersion = options.sdkVersion ?? "1.0.31";
    this.models = options.models ?? {
      ok: true,
      models: [{ id: "composer-2.5", displayName: "Composer 2.5" }],
    };
    this.account = options.account ?? {
      ok: true,
      identity: { apiKeyName: "test-key", userId: 1, createdAt: "2026-01-01T00:00:00.000Z" },
    };
  }

  private takeScripts(fallback: FakeStep[][]): FakeStep[][] {
    const queued = this.options.agentScripts;
    if (queued && this.agentScriptIndex < queued.length) {
      const next = queued[this.agentScriptIndex];
      this.agentScriptIndex += 1;
      if (next) return next;
    }
    return this.options.scripts ?? fallback;
  }

  async createAgent(input: CreateAgentInput): Promise<SdkAgent> {
    this.createCalls.push(input);
    const configured = this.options.createErrorsByApiKey?.[input.apiKey];
    const keyedError = Array.isArray(configured)
      ? configured[this.keyedCreateErrorIndexes.get(input.apiKey) ?? 0]
      : configured;
    if (Array.isArray(configured)) {
      this.keyedCreateErrorIndexes.set(input.apiKey, (this.keyedCreateErrorIndexes.get(input.apiKey) ?? 0) + 1);
    }
    if (keyedError) throw configuredError(keyedError);
    if (this.options.createError) throw configuredError(this.options.createError);
    this.lastCreate = input;
    this.lastAllowlist = apiProfileToolAllowlist(input.clientToolNames, input.hostedSearch === true);
    const agent = new FakeAgent(
      input,
      this.takeScripts([[{ type: "text", chunks: ["hello"] }]]),
      this.options.finalUsage,
      this.options.liveUsage,
      undefined,
      this.options.systemPromptGated ?? false,
    );
    this.agents.push(agent);
    return agent;
  }

  async resumeAgent(input: ResumeAgentInput): Promise<SdkAgent> {
    if (this.options.resumeError) throw configuredError(this.options.resumeError);
    this.lastResume = input;
    this.resumeCalls.push(input);
    this.lastAllowlist = apiProfileToolAllowlist(input.clientToolNames, input.hostedSearch === true);
    for (const call of this.options.resumeEarlyToolCalls ?? []) {
      const tool = input.customTools[call.name];
      if (!tool) throw new Error(`fake sdk missing resume tool ${call.name}`);
      void Promise.resolve(
        tool.execute(call.input, { toolCallId: call.id ?? `sdk_${randomUUID()}` }),
      ).catch(() => undefined);
    }
    const agent = new FakeAgent(
      input,
      this.takeScripts([[{ type: "text", chunks: ["resumed"] }]]),
      this.options.finalUsage,
      this.options.liveUsage,
      input.agentId,
      this.options.systemPromptGated ?? false,
    );
    this.agents.push(agent);
    return agent;
  }

  async listModels(apiKey: string): Promise<SdkCatalogResult> {
    this.listModelsCalls += 1;
    this.listModelsApiKeys.push(apiKey);
    return this.options.modelsByApiKey?.[apiKey] ?? this.models;
  }

  async getAccount(apiKey: string): Promise<SdkAccountResult> {
    this.getAccountCalls += 1;
    this.getAccountApiKeys.push(apiKey);
    return this.options.accountsByApiKey?.[apiKey] ?? this.account;
  }

  async probeCredential(apiKey: string): Promise<"valid" | "invalid" | "unavailable"> {
    this.credentialProbeCalls.push(apiKey);
    return this.options.credentialProbeByApiKey?.[apiKey] ?? "valid";
  }
}
