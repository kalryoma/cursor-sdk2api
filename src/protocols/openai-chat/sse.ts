import type { ServerResponse } from "node:http";
import { toOpenAIErrorBody } from "../../errors.js";
import { applyHeaders, writeDataFrame } from "../../server/http-util.js";

export function beginChatSse(res: ServerResponse, requestId: string, sessionId: string): void {
  const headers = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-request-id": requestId,
    "x-accel-buffering": "no",
    "x-cursor-session-id": sessionId,
  };
  applyHeaders(res, headers);
  res.writeHead(200, headers);
}

export function writeChatFrame(res: ServerResponse, data: unknown): void {
  writeDataFrame(res, data);
}

export function writeChatDone(res: ServerResponse): void {
  writeDataFrame(res, "[DONE]");
}

export function writeChatStreamError(res: ServerResponse, error: unknown, requestId: string): void {
  writeDataFrame(res, toOpenAIErrorBody(error, requestId));
  writeChatDone(res);
}
