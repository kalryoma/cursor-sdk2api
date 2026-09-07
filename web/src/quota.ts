import type { AccountPayload } from "./types.js";

function compactValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(compactValue).filter(Boolean).join(", ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .slice(0, 4)
      .map(([key, inner]) => `${key} ${compactValue(inner)}`)
      .join(" · ");
  }
  return "";
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function usd(value: number): string {
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatQuota(account?: AccountPayload): string {
  if (!account) return "";
  const remaining = finiteNumber(account.limits?.remaining_usd);
  const limit = finiteNumber(account.limits?.limit_usd);
  if (remaining === 0 && limit === 0) return "";
  if (remaining !== undefined && limit !== undefined) return `${usd(remaining)} / ${usd(limit)}`;
  if (remaining !== undefined) return usd(remaining);
  const parts: string[] = [];
  if (account.capabilities.spending && account.spending) parts.push(compactValue(account.spending));
  if (account.capabilities.limits && account.limits) parts.push(compactValue(account.limits));
  return parts.filter(Boolean).join(" · ");
}

export function formatQuotaBreakdown(account?: AccountPayload): string {
  if (!account?.capabilities.limits || !account.limits) return "";
  const cursor = finiteNumber(account.limits.cursor_models_percent_used);
  const other = finiteNumber(account.limits.other_models_percent_used);
  const parts: string[] = [];
  if (cursor !== undefined) parts.push(`Cursor Models ${cursor.toFixed(1)}%`);
  if (other !== undefined) parts.push(`Other Models ${other.toFixed(1)}%`);
  return parts.join(" · ");
}

export function cursorUsedPercent(account?: AccountPayload): number | undefined {
  if (!account?.capabilities.limits || !account.limits) return undefined;
  return finiteNumber(account.limits.used_percent);
}

export function grokBotUsedPercent(account?: AccountPayload): number | undefined {
  if (!account?.grok_bot || account.grok_bot.available !== true) return undefined;
  return finiteNumber(account.grok_bot.used_percent);
}

export function grokBotRemainingPercent(account?: AccountPayload): number | undefined {
  if (!account?.grok_bot || account.grok_bot.available !== true) return undefined;
  return finiteNumber(account.grok_bot.remaining_percent);
}

export function formatGrokBotQuota(account?: AccountPayload): string {
  const used = grokBotUsedPercent(account);
  if (used === undefined) return "";
  const plan = typeof account?.grok_bot?.plan_label === "string" ? account.grok_bot.plan_label.trim() : "";
  return plan ? `${formatPercent(used)} · ${plan}` : formatPercent(used);
}

export function parseResetDate(value: unknown): Date | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return fromEpoch(value);
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return fromEpoch(Number(text));
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function fromEpoch(value: number): Date | undefined {
  const ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : Number.NaN;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function formatResetAt(value: unknown, prefix: string): string {
  const date = parseResetDate(value);
  if (!date) return "";
  return `${prefix} ${date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}

export function formatCursorReset(account: AccountPayload | undefined, prefix: string): string {
  return formatResetAt(account?.limits?.billing_cycle_end, prefix);
}

export function formatGrokBotReset(account: AccountPayload | undefined, prefix: string): string {
  return formatResetAt(account?.grok_bot?.next_reset_timestamp_utc, prefix);
}

export function formatPercent(value: number): string {
  const clamped = Math.min(100, Math.max(0, value));
  return `${clamped.toFixed(clamped % 1 === 0 ? 0 : 1)}%`;
}

export function sandSelectable(account?: AccountPayload, catalogReady = false): boolean {
  return Boolean(catalogReady && account?.grok_bot?.available === true && account.runtime?.sand_selectable !== false);
}

export function currentProfile(account?: AccountPayload): "sdk" | "sand" {
  return account?.runtime?.default_profile === "sand" ? "sand" : "sdk";
}
