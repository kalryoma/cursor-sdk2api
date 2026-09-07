/**
 * Cursor Agent CLI `stream-json` timings. Marks keep event names and clocks
 * only — never prompt text, tool args, or tool results.
 */

export interface CliMarks {
  first_byte_ms?: number;
  tool_items: Array<{ name: string; at_ms: number }>;
  stop_ms?: number;
  stop_reason?: string;
  error_type?: string;
  cli_duration_ms?: number;
  model?: string;
  /** Final result length only — never the report text. */
  report_chars?: number;
}

export function parseCliLine(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export function toolNameFromCall(toolCall: unknown): string {
  if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return "tool";
  const record = toolCall as Record<string, unknown>;
  const fn = record.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof (fn as { name?: unknown }).name === "string") {
    return (fn as { name: string }).name;
  }
  const key = Object.keys(record).find((name) => name.endsWith("ToolCall"));
  return key ? key.replace(/ToolCall$/, "") : "tool";
}

/** First assistant delta: timestamped partial without model_call_id, else first assistant. */
export function isAssistantFirstByte(event: Record<string, unknown>): boolean {
  if (event.type !== "assistant") return false;
  if (event.timestamp_ms !== undefined && event.model_call_id !== undefined) return false;
  return true;
}

export function classifyCliEvent(event: Record<string, unknown>, marks: CliMarks, now: number): void {
  const type = String(event.type ?? "");
  if (type === "system" && event.subtype === "init" && typeof event.model === "string") {
    marks.model = event.model;
    return;
  }
  if (type === "thinking" && event.subtype === "delta") {
    marks.first_byte_ms ??= now;
    return;
  }
  if (isAssistantFirstByte(event)) {
    marks.first_byte_ms ??= now;
    return;
  }
  if (type === "tool_call" && event.subtype === "started") {
    marks.tool_items.push({ name: toolNameFromCall(event.tool_call), at_ms: now });
    return;
  }
  if (type === "result") {
    marks.stop_ms ??= now;
    marks.stop_reason = String(event.subtype ?? "result");
    if (typeof event.duration_ms === "number") marks.cli_duration_ms = event.duration_ms;
    if (typeof event.result === "string") marks.report_chars = event.result.length;
    if (event.is_error === true) marks.error_type = "cli_error";
  }
}

/** Gateway / live:timing ids → official Cursor CLI slugs, first match wins. */
export const CLI_MODEL_ALIASES: Record<string, readonly string[]> = {
  "claude-sonnet-4-6": ["claude-4.6-sonnet-medium", "claude-4.6-sonnet-medium-thinking"],
  "grok-4.6": ["cursor-grok-4.6-medium", "cursor-grok-4.6-high", "cursor-grok-4.6-medium-fast"],
  "composer-2.5": ["composer-2.5"],
};

export function resolveCliModel(
  requested: string,
  catalogIds: readonly string[],
): { requested: string; id?: string; how: "exact" | "alias" | "missing" } {
  if (catalogIds.includes(requested)) return { requested, id: requested, how: "exact" };
  for (const alias of CLI_MODEL_ALIASES[requested] ?? []) {
    if (catalogIds.includes(alias)) return { requested, id: alias, how: "alias" };
  }
  return { requested, how: "missing" };
}

export function parseCliModelIds(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return collectModelIds(parsed);
    } catch {
      // fall through to line scan
    }
  }
  const skip = new Set(["available", "model", "models", "name", "tip"]);
  const ids = new Set<string>();
  for (const line of trimmed.split("\n")) {
    const listed = line.match(/^([a-z0-9][a-z0-9._-]{2,})\s+-/i);
    if (listed?.[1]) {
      ids.add(listed[1]);
      continue;
    }
    const match = line.match(/\b([a-z0-9][a-z0-9._-]{2,})\b/i);
    if (!match?.[1] || skip.has(match[1].toLowerCase())) continue;
    ids.add(match[1]);
  }
  return [...ids];
}

function collectModelIds(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string" && /[a-z0-9].*[.-]/.test(value)) out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectModelIds(item, out));
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string") out.push(record.id);
    else if (typeof record.model === "string") out.push(record.model);
    else Object.values(record).forEach((item) => collectModelIds(item, out));
  }
  return [...new Set(out)];
}
