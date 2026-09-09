import { expect, test } from "vitest";
import { FakeClock } from "../../src/clock.js";
import { publicKeyHint, RequestLog } from "../../src/core/request-log.js";

test("public key hint never returns the credential", () => {
  expect(publicKeyHint("ab")).toBe("••••");
  expect(publicKeyHint("test-key-a")).toBe("••••ey-a");
  expect(publicKeyHint("sk-canary-SECRET-123456789")).toBe("••••6789");
});

test("request log is a newest-first ring with running then completed status", () => {
  const clock = new FakeClock(1_000_000);
  const log = new RequestLog(clock, 2);
  const first = log.begin({
    protocol: "messages",
    path: "/v1/messages",
    method: "POST",
    request_id: "req_1",
    model: "composer-2.5",
  });
  expect(first.status).toBe("running");
  clock.advance(25);
  log.finish(first.id, { status: 200, session_id: "ses_1" });

  const second = log.begin({
    protocol: "chat",
    path: "/v1/chat/completions",
    method: "POST",
    request_id: "req_2",
  });
  log.finish(second.id, { status: 400, error_type: "invalid_request", error: "model is required" });

  log.begin({
    protocol: "responses",
    path: "/v1/responses",
    method: "POST",
    request_id: "req_3",
  });

  expect(log.size).toBe(2);
  const listed = log.list(10);
  expect(listed.map((entry) => entry.request_id)).toEqual(["req_3", "req_2"]);
  expect(listed[0]?.status).toBe("running");
  expect(listed[1]).toMatchObject({
    status: 400,
    error_type: "invalid_request",
    error: "model is required",
    duration_ms: 0,
  });
  expect(log.list(1)).toHaveLength(1);
});
