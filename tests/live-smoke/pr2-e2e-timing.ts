#!/usr/bin/env node
/**
 * Same-work end-to-end: summarize this repo's PR #2 through the harness
 * protocol on this gateway versus official Cursor CLI. Receipts keep
 * timings, tool names, and report length — never report text or secrets.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyCliEvent,
  parseCliLine,
  parseCliModelIds,
  type CliMarks,
} from "./lib/cli-stream.js";
import { pickCatalogId, type HarnessProtocol } from "./lib/harness-stream.js";
import { readHarnessTurn } from "./lib/harness-turn.js";
import {
  anthropicInspectTools,
  executeInspectTool,
  responsesInspectTools,
  summaryPrompt,
} from "./lib/pr-inspect.js";
import { assertNoCanary, redactSecrets } from "./lib/redact.js";
import { liveSmokeGate } from "./lib/gate.js";
import { startChildGateway } from "./lib/spawn.js";
import { sampleReceipt, trimmedTiming, type RepeatSample, type TrimmedTiming } from "./lib/trimmed-mean.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const MIN_REPORT_CHARS = 200;
const MAX_ROUNDS = 8;

interface Pair {
  id: string;
  harness: "claude-code" | "codex" | "grok-build";
  protocol: HarnessProtocol;
  gatewayModels: string[];
  cliModels: string[];
  cliFastModels: string[];
}

interface SideResult {
  side: "gateway" | "cli";
  status: "pass" | "fail" | "catalog_missing";
  model?: string;
  fast: boolean;
  duration_ms?: number;
  first_byte_ms?: number;
  first_tool_ms?: number;
  stop_ms?: number;
  tool_count?: number;
  tool_names?: string[];
  rounds?: number;
  report_chars?: number;
  workspace_dirty?: boolean;
  error_type?: string;
  reason?: string;
}

interface PairResult {
  id: string;
  harness: Pair["harness"];
  protocol: HarnessProtocol;
  gateway: SideResult;
  cli: SideResult;
  gateway_samples?: RepeatSample[];
  cli_samples?: RepeatSample[];
  gateway_trimmed?: TrimmedTiming;
  cli_trimmed?: TrimmedTiming;
}

const PAIRS: Pair[] = [
  {
    id: "sonnet",
    harness: "claude-code",
    protocol: "messages",
    gatewayModels: ["claude-sonnet-4-6", "claude-4.6-sonnet-medium"],
    cliModels: ["claude-4.6-sonnet-medium"],
    cliFastModels: ["claude-4.6-sonnet-medium[fast=true]"],
  },
  {
    id: "luna",
    harness: "codex",
    protocol: "responses",
    gatewayModels: ["gpt-5.6-luna-high", "gpt-5.6-luna", "gpt-5.6-luna-medium"],
    cliModels: ["gpt-5.6-luna-high"],
    cliFastModels: ["gpt-5.6-luna-high-fast"],
  },
  {
    id: "grok",
    harness: "grok-build",
    protocol: "responses",
    gatewayModels: ["grok-4.6"],
    cliModels: ["cursor-grok-4.6-high"],
    cliFastModels: ["cursor-grok-4.6-high-fast"],
  },
];

const token = () => `tok-${randomBytes(4).toString("hex")}`;

function catalogHasFast(models: Array<{ id?: string; parameters?: Array<{ id?: string }> }>, modelId: string): boolean {
  const model = models.find((item) => item.id === modelId);
  return (model?.parameters ?? []).some((param) => param.id === "fast");
}

function porcelain(): string {
  return spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).stdout;
}

function restoreWorkspace(before: string): boolean {
  const after = porcelain();
  if (after === before) return false;
  const prior = new Set(before.split("\n").filter(Boolean));
  for (const line of after.split("\n").filter(Boolean)) {
    if (prior.has(line)) continue;
    const path = line.slice(3);
    if (!path) continue;
    if (line.startsWith("??")) spawnSync("git", ["clean", "-f", "--", path], { cwd: repoRoot });
    else spawnSync("git", ["checkout", "--", path], { cwd: repoRoot });
  }
  return true;
}

async function runGateway(input: {
  baseUrl: string;
  apiKey: string;
  pair: Pair;
  model: string;
  fast: boolean;
  timeoutMs: number;
  pr: number;
  prompt: string;
}): Promise<SideResult> {
  const started = Date.now();
  let sessionId: string | undefined;
  let first_byte_ms: number | undefined;
  let first_tool_ms: number | undefined;
  let stop_ms: number | undefined;
  const tool_names: string[] = [];
  let report_chars = 0;
  let rounds = 0;
  let error_type: string | undefined;
  let pendingResults: Array<{ id: string; output: string }> = [];

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    rounds = round + 1;
    const body = round === 0
      ? initialBody(input)
      : continueBody(input, pendingResults);
    const path = input.pair.protocol === "messages" ? "/v1/messages" : "/v1/responses";
    const headers: Record<string, string> = {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (sessionId) headers["x-cursor-session-id"] = sessionId;
    const res = await fetch(`${input.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    const marks = (res.headers.get("content-type") ?? "").includes("text/event-stream")
      ? await readHarnessTurn(res, started, input.pair.protocol)
      : { ...await jsonError(res), tool_items: [], tool_calls: [], text_chars: 0 };
    sessionId ??= marks.session_id;
    first_byte_ms ??= marks.first_byte_ms;
    first_tool_ms ??= marks.first_tool_ms;
    if (marks.stop_ms !== undefined) stop_ms = marks.stop_ms;
    tool_names.push(...marks.tool_items.map((item) => item.name));
    report_chars += marks.text_chars;
    if (marks.error_type) {
      error_type = marks.error_type;
      break;
    }
    if (res.status !== 200) {
      error_type = `http_${res.status}`;
      break;
    }
    if (marks.tool_calls.length === 0) break;
    const nextResults: Array<{ id: string; output: string }> = [];
    for (const call of marks.tool_calls) {
      const executed = await executeInspectTool(call.name, call.input, { repoRoot, pr: input.pr });
      nextResults.push({ id: call.id, output: executed.output });
    }
    pendingResults = nextResults;
  }

  const duration_ms = Date.now() - started;
  const ok = !error_type && first_byte_ms !== undefined && stop_ms !== undefined
    && tool_names.length >= 1 && report_chars >= MIN_REPORT_CHARS && rounds <= MAX_ROUNDS;
  return {
    side: "gateway",
    status: ok ? "pass" : "fail",
    model: input.model,
    fast: input.fast,
    duration_ms,
    first_byte_ms,
    first_tool_ms,
    stop_ms,
    tool_count: tool_names.length,
    tool_names,
    rounds,
    report_chars,
    error_type,
    reason: ok ? undefined : error_type ?? failReason({ tool_count: tool_names.length, report_chars, stop_ms }),
  };
}

function initialBody(input: {
  pair: Pair;
  model: string;
  fast: boolean;
  prompt: string;
}): Record<string, unknown> {
  if (input.pair.protocol === "messages") {
    return {
      model: input.model,
      max_tokens: 4096,
      stream: true,
      ...(input.fast ? { service_tier: "fast" } : {}),
      tools: anthropicInspectTools(),
      messages: [{ role: "user", content: input.prompt }],
    };
  }
  return {
    model: input.model,
    stream: true,
    ...(input.fast ? { cursor_model_params: [{ id: "fast", value: "true" }] } : {}),
    tools: responsesInspectTools(),
    input: input.prompt,
  };
}

function continueBody(
  input: { pair: Pair; model: string; fast: boolean },
  results: Array<{ id: string; output: string }>,
): Record<string, unknown> {
  if (input.pair.protocol === "messages") {
    return {
      model: input.model,
      max_tokens: 4096,
      stream: true,
      ...(input.fast ? { service_tier: "fast" } : {}),
      tools: anthropicInspectTools(),
      messages: [{
        role: "user",
        content: results.map((item) => ({
          type: "tool_result",
          tool_use_id: item.id,
          content: item.output,
        })),
      }],
    };
  }
  return {
    model: input.model,
    stream: true,
    ...(input.fast ? { cursor_model_params: [{ id: "fast", value: "true" }] } : {}),
    tools: responsesInspectTools(),
    input: results.map((item) => ({
      type: "function_call_output",
      call_id: item.id,
      output: item.output,
    })),
  };
}

async function jsonError(res: Response): Promise<{ error_type: string }> {
  const json = (await res.json().catch(() => ({}))) as { error?: { type?: string } };
  return { error_type: String(json.error?.type ?? `http_${res.status}`) };
}

function failReason(input: { tool_count: number; report_chars: number; stop_ms?: number }): string {
  if (input.stop_ms === undefined) return "no_stop";
  if (input.tool_count < 1) return "no_tool";
  if (input.report_chars < MIN_REPORT_CHARS) return "short_report";
  return "incomplete";
}

async function runCli(input: {
  bin: string;
  model: string;
  timeoutMs: number;
  prompt: string;
}): Promise<SideResult> {
  const before = porcelain();
  const started = Date.now();
  const marks: CliMarks = { tool_items: [] };
  const child = spawn(input.bin, [
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
    "--force",
    "--sandbox",
    "disabled",
    "--workspace",
    repoRoot,
    "--model",
    input.model,
    input.prompt,
  ], { cwd: repoRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    let index = stdout.indexOf("\n");
    while (index !== -1) {
      const line = stdout.slice(0, index);
      stdout = stdout.slice(index + 1);
      const event = parseCliLine(line);
      if (event) classifyCliEvent(event, marks, Date.now() - started);
      index = stdout.indexOf("\n");
    }
  });
  const exit_code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("cli_timeout"));
    }, input.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
  if (stdout.trim()) {
    const event = parseCliLine(stdout);
    if (event) classifyCliEvent(event, marks, Date.now() - started);
  }
  const workspace_dirty = restoreWorkspace(before);
  const duration_ms = Date.now() - started;
  const tool_names = marks.tool_items.map((item) => item.name);
  const ok = exit_code === 0 && !marks.error_type && marks.first_byte_ms !== undefined
    && marks.stop_ms !== undefined && tool_names.length >= 1
    && (marks.report_chars ?? 0) >= MIN_REPORT_CHARS;
  return {
    side: "cli",
    status: ok ? "pass" : "fail",
    model: input.model,
    fast: input.model.includes("fast"),
    duration_ms,
    first_byte_ms: marks.first_byte_ms,
    first_tool_ms: marks.tool_items[0]?.at_ms,
    stop_ms: marks.stop_ms,
    tool_count: tool_names.length,
    tool_names,
    rounds: 1,
    report_chars: marks.report_chars,
    workspace_dirty,
    error_type: marks.error_type,
    reason: ok ? undefined : marks.error_type ?? (exit_code === 0 ? failReason({
      tool_count: tool_names.length,
      report_chars: marks.report_chars ?? 0,
      stop_ms: marks.stop_ms,
    }) : `exit_${exit_code}`),
  };
}

async function listCliModels(bin: string, timeoutMs: number): Promise<string[]> {
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, ["--list-models"], { cwd: repoRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      text += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      text += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("cli_timeout"));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(text);
      else reject(new Error("cli_models_failed"));
    });
  });
  return parseCliModelIds(out);
}

function logSide(pairId: string, side: SideResult, extra = ""): void {
  console.log(
    `case ${pairId}/${side.side}${extra} ${side.status}${side.model ? ` model=${side.model}` : ""}${
      side.fast ? " fast" : ""
    }${side.duration_ms !== undefined ? ` ${Math.round(side.duration_ms)}ms` : ""}${
      side.first_byte_ms !== undefined ? ` first_byte=${Math.round(side.first_byte_ms)}ms` : ""
    }${side.first_tool_ms !== undefined ? ` first_tool=${Math.round(side.first_tool_ms)}ms` : ""}${
      side.tool_count !== undefined ? ` tools=${Math.round(side.tool_count)}` : ""
    }${side.rounds !== undefined ? ` rounds=${Math.round(side.rounds)}` : ""}${
      side.report_chars !== undefined ? ` report_chars=${Math.round(side.report_chars)}` : ""
    }${side.reason ? ` ${side.reason}` : ""}`,
  );
}

function appendProgress(path: string, canaries: string[], row: unknown): void {
  const line = `${JSON.stringify(row)}\n`;
  assertNoCanary(line, canaries);
  appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
}

function applyTrim(side: SideResult, samples: RepeatSample[]): SideResult {
  const trimmed = trimmedTiming(samples);
  const allPassed = trimmed.passed === samples.length && trimmed.passed > 0;
  return {
    ...side,
    status: allPassed ? "pass" : "fail",
    duration_ms: trimmed.duration_ms,
    first_byte_ms: trimmed.first_byte_ms,
    first_tool_ms: trimmed.first_tool_ms,
    tool_count: trimmed.tool_count,
    rounds: trimmed.rounds,
    report_chars: trimmed.report_chars,
    reason: allPassed ? undefined : trimmed.passed === 0 ? "no_pass_samples" : `passed_${trimmed.passed}_of_${samples.length}`,
  };
}

async function main(): Promise<void> {
  const gate = liveSmokeGate(process.env);
  if (!gate.ok) {
    console.error(gate.message);
    process.exit(gate.code);
  }
  const apiKey = process.env.CURSOR_API_KEY?.trim() ?? "";
  const canaries = [apiKey];
  const timeoutMs = Number.parseInt(process.env.LIVE_SMOKE_TIMEOUT_MS ?? "240000", 10);
  const repeats = Math.max(1, Number.parseInt(process.env.LIVE_E2E_REPEATS ?? "1", 10));
  const pr = Number.parseInt(process.env.LIVE_E2E_PR ?? "2", 10);
  const output = process.env.LIVE_SMOKE_OUTPUT?.trim() || join(tmpdir(), `cursor-sdk2api-pr-e2e-${Date.now()}.json`);
  const progressPath = `${output}.jsonl`;
  const bin = process.env.CURSOR_CLI_BIN?.trim() || "agent";
  const distEntry = join(repoRoot, "dist", "index.js");
  if (!existsSync(distEntry)) {
    console.error("dist/index.js is missing. Run npm run build before live:pr2-e2e.");
    process.exit(3);
  }

  const child = await startChildGateway({ repoRoot, distEntry, canaries });
  const pairs: PairResult[] = [];
  let exitCode = 1;
  try {
    const catalogRes = await fetch(`${child.baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const catalogJson = (await catalogRes.json()) as {
      data?: Array<{ id?: string; parameters?: Array<{ id?: string }> }>;
    };
    const catalog = catalogJson.data ?? [];
    const catalogIds = catalog.map((item) => item.id).filter((id): id is string => Boolean(id));
    if (catalogRes.status !== 200 || catalogIds.length === 0) throw new Error(`catalog unavailable (${catalogRes.status})`);
    const cliIds = await listCliModels(bin, Math.min(timeoutMs, 60000));

    for (const pair of PAIRS) {
      const gatewayModel = pickCatalogId(pair.gatewayModels, catalogIds);
      const cliListedFast = pair.cliFastModels.find((id) => cliIds.includes(id));
      const cliPlain = pair.cliModels.find((id) => cliIds.includes(id));
      const gatewaySamples: SideResult[] = [];
      const cliSamples: SideResult[] = [];
      let gateway: SideResult = { side: "gateway", status: "catalog_missing", fast: false };
      let cli: SideResult = { side: "cli", status: "catalog_missing", fast: false };

      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        const prompt = summaryPrompt(pr, token());
        if (gatewayModel) {
          gateway = await runGateway({
            baseUrl: child.baseUrl,
            apiKey,
            pair,
            model: gatewayModel,
            fast: catalogHasFast(catalog, gatewayModel),
            timeoutMs,
            pr,
            prompt,
          });
          gatewaySamples.push(gateway);
          logSide(pair.id, gateway, repeats > 1 ? ` r${repeat}/${repeats}` : "");
          appendProgress(progressPath, canaries, { id: pair.id, side: "gateway", repeat, sample: sampleReceipt(gateway) });
        }
        if (cliListedFast || cliPlain) {
          cli = await runCli({
            bin,
            model: cliListedFast ?? cliPlain ?? "",
            timeoutMs,
            prompt,
          });
          if (!cliListedFast) cli.fast = false;
          cliSamples.push(cli);
          logSide(pair.id, cli, repeats > 1 ? ` r${repeat}/${repeats}` : "");
          appendProgress(progressPath, canaries, { id: pair.id, side: "cli", repeat, sample: sampleReceipt(cli) });
        }
      }

      if (repeats > 1 && gatewaySamples.length > 0) {
        gateway = applyTrim(gateway, gatewaySamples.map(sampleReceipt));
        logSide(pair.id, gateway, " trimmed");
      }
      if (repeats > 1 && cliSamples.length > 0) {
        cli = applyTrim(cli, cliSamples.map(sampleReceipt));
        logSide(pair.id, cli, " trimmed");
      }
      pairs.push({
        id: pair.id,
        harness: pair.harness,
        protocol: pair.protocol,
        gateway,
        cli,
        ...(repeats > 1 ? {
          gateway_samples: gatewaySamples.map(sampleReceipt),
          cli_samples: cliSamples.map(sampleReceipt),
          gateway_trimmed: trimmedTiming(gatewaySamples.map(sampleReceipt)),
          cli_trimmed: trimmedTiming(cliSamples.map(sampleReceipt)),
        } : {}),
      });
    }

    const receipt = {
      schema: repeats > 1 ? "cursor-sdk2api.pr-e2e.v2" : "cursor-sdk2api.pr-e2e.v1",
      task: { pr, kind: "summary_report", repeats, trim: repeats > 1 ? "drop_min_max_per_metric" : "none" },
      ok: pairs.every((item) => item.gateway.status !== "fail" && item.cli.status !== "fail"),
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        runner: "tests/live-smoke/pr2-e2e-timing",
        cli_bin: bin,
      },
      pairs,
    };
    const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
    assertNoCanary(serialized, canaries);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, serialized, { encoding: "utf8", mode: 0o600 });
    console.log(`receipt ${output}`);
    console.log(`ok=${receipt.ok}`);
    exitCode = receipt.ok ? 0 : 1;
  } catch (error) {
    console.error(redactSecrets(error instanceof Error ? error.message : "pr e2e timing failed", canaries));
  } finally {
    await child.stop().catch(() => undefined);
    child.cleanup();
  }
  process.exit(exitCode);
}

void main();
