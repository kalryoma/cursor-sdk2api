import { expect, test } from "vitest";
import { mapDeltaUpdate } from "../../src/sdk/cursor-runtime.js";

// Shapes follow @cursor/sdk 1.0.31 `InteractionUpdate` (vendor delta-types.d.ts).
const mcpCall = {
  type: "mcp",
  args: { providerIdentifier: "custom-user-tools", toolName: "lookup", args: { q: "a" } },
};

test("custom tool call announcements map for both the partial and the started update", () => {
  expect(mapDeltaUpdate({ type: "partial-tool-call", callId: "call_1", toolCall: mcpCall, modelCallId: "m1" })).toEqual({
    type: "tool-call-announced",
    callId: "call_1",
    toolName: "lookup",
  });
  expect(mapDeltaUpdate({ type: "tool-call-started", callId: "call_1", toolCall: mcpCall, modelCallId: "m1" })).toEqual({
    type: "tool-call-announced",
    callId: "call_1",
    toolName: "lookup",
  });
});

test("ambient tool calls and completions stay internal", () => {
  const shell = { type: "shell", args: { command: "ls" } };
  expect(mapDeltaUpdate({ type: "tool-call-started", callId: "call_2", toolCall: shell, modelCallId: "m1" })).toBeUndefined();
  expect(mapDeltaUpdate({ type: "tool-call-completed", callId: "call_1", toolCall: mcpCall, modelCallId: "m1" })).toBeUndefined();
  expect(mapDeltaUpdate({ type: "partial-tool-call", callId: "", toolCall: mcpCall, modelCallId: "m1" })).toBeUndefined();
});

test("step lifecycle and turn end keep their numbers", () => {
  expect(mapDeltaUpdate({ type: "step-started", stepId: 3 })).toEqual({ type: "step-started", stepId: 3 });
  expect(mapDeltaUpdate({ type: "step-completed", stepId: 3, stepDurationMs: 1234 })).toEqual({
    type: "step-completed",
    stepId: 3,
    durationMs: 1234,
  });
  expect(
    mapDeltaUpdate({
      type: "turn-ended",
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 0 },
    }),
  ).toEqual({
    type: "turn-ended",
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 0 },
  });
  expect(mapDeltaUpdate({ type: "turn-ended" })).toEqual({ type: "turn-ended" });
});

test("content deltas and unknown updates are unchanged", () => {
  expect(mapDeltaUpdate({ type: "text-delta", text: "hi" })).toEqual({ type: "text-delta", text: "hi" });
  expect(mapDeltaUpdate({ type: "thinking-delta", text: "hm" })).toEqual({ type: "thinking-delta", text: "hm" });
  expect(mapDeltaUpdate({ type: "token-delta", tokens: 3 })).toEqual({ type: "token-delta", tokens: 3 });
  expect(mapDeltaUpdate({ type: "thinking-completed", thinkingDurationMs: 9 })).toBeUndefined();
  expect(mapDeltaUpdate({ type: "summary", summary: "x" })).toBeUndefined();
});
