import type { Clock } from "../clock.js";
import { redactSecrets } from "../errors.js";
import { requestId as newRequestId } from "../ids.js";
import type { RuntimeProfile } from "./runtime-profile.js";

export type RequestLogProtocol = "messages" | "chat" | "responses";

export interface RequestLogUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  reasoning_tokens?: number;
  usage_status?: "sdk" | "unavailable" | "deferred";
}

export interface RequestLogEntry {
  id: string;
  started_at: number;
  finished_at?: number;
  duration_ms?: number;
  protocol: RequestLogProtocol;
  path: string;
  method: string;
  model?: string;
  stream?: boolean;
  status: "running" | number;
  request_id: string;
  session_id?: string;
  account_id?: string;
  key_hint?: string;
  runtime_profile?: RuntimeProfile;
  usage?: RequestLogUsage;
  error_type?: string;
  error?: string;
}

export interface RequestLogBegin {
  protocol: RequestLogProtocol;
  path: string;
  method: string;
  request_id: string;
  model?: string;
  stream?: boolean;
  account_id?: string;
  key_hint?: string;
  runtime_profile?: RuntimeProfile;
}

export interface RequestLogPatch {
  protocol?: RequestLogProtocol;
  model?: string;
  stream?: boolean;
  account_id?: string;
  key_hint?: string;
  runtime_profile?: RuntimeProfile;
  session_id?: string;
}

export interface RequestLogFinish extends RequestLogPatch {
  status?: number;
  usage?: RequestLogUsage;
  error_type?: string;
  error?: string;
}

const DEFAULT_CAPACITY = 500;

/** Last-four hint; never the credential itself. */
export function publicKeyHint(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 4 ? "••••" : `••••${trimmed.slice(-4)}`;
}

/** Process-local protocol request ring. Newest first. No payloads or secrets. */
export class RequestLog {
  private readonly entries: RequestLogEntry[] = [];

  constructor(
    private readonly clock: Clock,
    readonly capacity = DEFAULT_CAPACITY,
  ) {}

  get size(): number {
    return this.entries.length;
  }

  begin(input: RequestLogBegin): RequestLogEntry {
    const entry: RequestLogEntry = {
      id: newRequestId().replace(/^req_/, "log_"),
      started_at: this.clock.now(),
      protocol: input.protocol,
      path: input.path,
      method: input.method,
      request_id: input.request_id,
      status: "running",
      ...(input.model ? { model: input.model } : {}),
      ...(input.stream !== undefined ? { stream: input.stream } : {}),
      ...(input.account_id ? { account_id: input.account_id } : {}),
      ...(input.key_hint ? { key_hint: input.key_hint } : {}),
      ...(input.runtime_profile ? { runtime_profile: input.runtime_profile } : {}),
    };
    this.entries.unshift(entry);
    this.evict();
    return entry;
  }

  patch(id: string, update: RequestLogPatch): RequestLogEntry | undefined {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return undefined;
    applyPatch(entry, update);
    return entry;
  }

  finish(id: string, update: RequestLogFinish = {}): RequestLogEntry | undefined {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return undefined;
    applyPatch(entry, update);
    if (entry.status === "running") {
      entry.status = update.status ?? 200;
    } else if (update.status !== undefined) {
      entry.status = update.status;
    }
    if (update.usage) entry.usage = update.usage;
    if (update.error_type) entry.error_type = update.error_type;
    if (update.error) entry.error = redactSecrets(update.error);
    if (entry.finished_at === undefined) {
      entry.finished_at = this.clock.now();
      entry.duration_ms = Math.max(0, entry.finished_at - entry.started_at);
    }
    return entry;
  }

  list(limit = 200): RequestLogEntry[] {
    const count = Math.min(Math.max(0, limit), this.entries.length);
    return this.entries.slice(0, count).map((entry) => ({ ...entry, usage: entry.usage ? { ...entry.usage } : undefined }));
  }

  private evict(): void {
    while (this.entries.length > this.capacity) this.entries.pop();
  }
}

function applyPatch(entry: RequestLogEntry, update: RequestLogPatch): void {
  if (update.protocol) entry.protocol = update.protocol;
  if (update.model) entry.model = update.model;
  if (update.stream !== undefined) entry.stream = update.stream;
  if (update.account_id) entry.account_id = update.account_id;
  if (update.key_hint) entry.key_hint = update.key_hint;
  if (update.runtime_profile) entry.runtime_profile = update.runtime_profile;
  if (update.session_id) entry.session_id = update.session_id;
}
