import type { Clock } from "../clock.js";
import type { AnthropicTool } from "../protocols/anthropic/types.js";
import type {
  SdkAgent,
  SdkCustomToolResult,
  SdkDeltaUpdate,
  SdkRuntime,
} from "../sdk/port.js";
import { EventPump } from "./event-pump.js";
import type { Session } from "./session.js";
import { mapClientTools } from "./tool-bridge.js";

export type SdkAgentSource =
  | { type: "create"; apiKey: string; workspaceDir: string }
  | { type: "resume"; agentId: string; apiKey: string; workspaceDir: string }
  | { type: "existing"; agent: SdkAgent };

export interface DriveSdkRunInput {
  session: Session;
  tools: AnthropicTool[];
  agent: SdkAgentSource;
  send: {
    text: string;
    images?: Array<{ data: string; mimeType: string }>;
    force?: boolean;
  };
  completedResults?: Map<string, SdkCustomToolResult[]>;
  afterAgentReady?: (agent: SdkAgent) => void;
  /** Clock time the request was admitted; anchors the segment timing fields. */
  startedAt?: number;
}

export interface SdkRunDriverDeps {
  sdk: SdkRuntime;
  clock: Clock;
  toolBatchSettleMs: number;
  firstEventTimeoutMs: number;
}

export class SdkRunDriver {
  constructor(private readonly deps: SdkRunDriverDeps) {}

  async start(input: DriveSdkRunInput): Promise<EventPump> {
    const { session } = input;
    session.run = undefined;
    session.pump = undefined;
    const customTools = mapClientTools(
      input.tools,
      session,
      this.deps.clock,
      () => undefined,
      input.completedResults,
    );
    const agent = await this.resolveAgent(input, customTools);
    session.agent = agent;
    session.sdkAgentId = agent.agentId;
    input.afterAgentReady?.(agent);

    // Deltas and tool callbacks that fire before the pump exists share one
    // queue with the tool bridge, so their relative order survives the attach.
    const onDelta = (update: SdkDeltaUpdate) => {
      if (session.pump) session.pump.ingestDelta(update);
      else session.earlyEvents.push({ type: "delta", update });
    };
    const run = await agent.send({
      text: input.send.text,
      images: input.send.images,
      customTools,
      force: input.send.force,
      onDelta,
    });
    session.run = run;
    const agentReadyAt = this.deps.clock.now();
    const pump = new EventPump(
      session,
      run,
      this.deps.clock,
      this.deps.toolBatchSettleMs,
      this.deps.firstEventTimeoutMs,
      { startedAt: input.startedAt ?? agentReadyAt, agentReadyAt },
    );
    session.pump = pump;
    pump.ingestEarly(session.earlyEvents.splice(0));
    return pump;
  }

  private resolveAgent(
    input: DriveSdkRunInput,
    customTools: ReturnType<typeof mapClientTools>,
  ): Promise<SdkAgent> {
    const common = {
      modelId: input.session.modelId,
      modelParams: input.session.modelParams,
      clientToolNames: input.tools.map((tool) => tool.name),
      customTools,
      runtimeProfile: input.session.runtimeProfile,
      hostedSearch: input.session.hostedSearch,
    };
    if (input.agent.type === "existing") return Promise.resolve(input.agent.agent);
    if (input.agent.type === "resume") {
      return this.deps.sdk.resumeAgent({
        ...common,
        agentId: input.agent.agentId,
        apiKey: input.agent.apiKey,
        workspaceDir: input.agent.workspaceDir,
      });
    }
    return this.deps.sdk.createAgent({
      ...common,
      apiKey: input.agent.apiKey,
      workspaceDir: input.agent.workspaceDir,
    });
  }
}
