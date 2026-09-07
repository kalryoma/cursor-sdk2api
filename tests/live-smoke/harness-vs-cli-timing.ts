#!/usr/bin/env node
/**
 * Same-work comparison: harness protocol through this gateway vs official
 * Cursor CLI, no HTTP proxy. Text-only PONG. Fast is requested on both
 * sides when the catalog exposes it. Receipts keep timings only.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyCliEvent,
  parseCliLine,
  parseCliModelIds,
  type CliMarks,
} from "./lib/cli-stream.js";
import { liveSmokeGate } from "./lib/gate.js";
import {
  classifyHarnessEvent,
  parseSseChunk,
  pickCatalogId,
  type HarnessMarks,
  type HarnessProtocol,
} from "./lib/harness-stream.js";
import { assertNoCanary, redactSecrets } from "./lib/redact.js";
import { startChildGateway } from "./lib/spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

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
  stop_ms?: number;
  error_type?: string;
  reason?: string;
}

interface PairResult {
  id: string;
  harness: Pair["harness"];
  protocol: HarnessProtocol;
  gateway: SideResult;
  cli: SideResult;
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
const prompt = () => `Reply with the single word PONG and nothing else. (${token()})`;

function catalogHasFast(models: Array<{ id?: string; parameters?: Array<{ id?: string }> }>, modelId: string): boolean {
  const model = models.find((item) => item.id === modelId);
  return (model?.parameters ?? []).some((param) => param.id === "fast");
}

async function readHarnessStream(res: Response, started: number, protocol: HarnessProtocol): Promise<HarnessMarks> {
  const marks: HarnessMarks = {};
  if (!res.body) return marks;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const drain = (final: boolean) => {
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (raw.trim()) classifyHarnessEvent(protocol, parseSseChunk(raw), marks, Date.now() - started);
      index = buffer.indexOf("\n\n");
    }
    if (final && buffer.trim()) classifyHarnessEvent(protocol, parseSseChunk(buffer), marks, Date.now() - started);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    drain(false);
  }
  buffer += decoder.decode();
  drain(true);
  return marks;
}

async function runGateway(input: {
  baseUrl: string;
  apiKey: string;
  pair: Pair;
  model: string;
  fast: boolean;
  timeoutMs: number;
}): Promise<SideResult> {
  const body = input.pair.protocol === "messages"
    ? {
        model: input.model,
        max_tokens: 64,
        stream: true,
        ...(input.fast ? { service_tier: "fast" } : {}),
        messages: [{ role: "user", content: prompt() }],
      }
    : {
        model: input.model,
        stream: true,
        ...(input.fast ? { cursor_model_params: [{ id: "fast", value: "true" }] } : {}),
        input: prompt(),
      };
  const path = input.pair.protocol === "messages" ? "/v1/messages" : "/v1/responses";
  const started = Date.now();
  const res = await fetch(`${input.baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  const marks = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? await readHarnessStream(res, started, input.pair.protocol)
    : { error_type: String(((await res.json().catch(() => ({}))) as { error?: { type?: string } }).error?.type ?? "error") };
  const duration_ms = Date.now() - started;
  const ok = res.status === 200 && !marks.error_type && marks.first_byte_ms !== undefined && marks.stop_ms !== undefined;
  return {
    side: "gateway",
    status: ok ? "pass" : "fail",
    model: input.model,
    fast: input.fast,
    duration_ms,
    first_byte_ms: marks.first_byte_ms,
    stop_ms: marks.stop_ms,
    error_type: marks.error_type,
    reason: ok ? undefined : marks.error_type ?? `http_${res.status}`,
  };
}

async function runCli(input: {
  bin: string;
  model: string;
  timeoutMs: number;
  canaries: string[];
}): Promise<SideResult> {
  const workspace = mkdtempSync(join(tmpdir(), "cursor-sdk2api-hvc-cli-"));
  const started = Date.now();
  const marks: CliMarks = { tool_items: [] };
  const child = spawn(input.bin, [
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
    "--sandbox",
    "enabled",
    "--mode",
    "ask",
    "--workspace",
    workspace,
    "--model",
    input.model,
    prompt(),
  ], { cwd: workspace, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
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
  rmSync(workspace, { recursive: true, force: true });
  const duration_ms = Date.now() - started;
  const ok = exit_code === 0 && !marks.error_type && marks.first_byte_ms !== undefined && marks.stop_ms !== undefined;
  return {
    side: "cli",
    status: ok ? "pass" : "fail",
    model: input.model,
    fast: input.model.includes("fast"),
    duration_ms,
    first_byte_ms: marks.first_byte_ms,
    stop_ms: marks.stop_ms,
    error_type: marks.error_type,
    reason: ok ? undefined : marks.error_type ?? `exit_${exit_code}`,
  };
}

async function listCliModels(bin: string, timeoutMs: number): Promise<string[]> {
  const workspace = mkdtempSync(join(tmpdir(), "cursor-sdk2api-hvc-models-"));
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(bin, ["--list-models"], { cwd: workspace, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
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
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const gate = liveSmokeGate(process.env);
  if (!gate.ok) {
    console.error(gate.message);
    process.exit(gate.code);
  }
  const apiKey = process.env.CURSOR_API_KEY?.trim() ?? "";
  const canaries = [apiKey];
  const timeoutMs = Number.parseInt(process.env.LIVE_SMOKE_TIMEOUT_MS ?? "180000", 10);
  const output = process.env.LIVE_SMOKE_OUTPUT?.trim() || join(tmpdir(), `cursor-sdk2api-harness-vs-cli-${Date.now()}.json`);
  const bin = process.env.CURSOR_CLI_BIN?.trim() || "agent";
  const distEntry = join(repoRoot, "dist", "index.js");
  if (!existsSync(distEntry)) {
    console.error("dist/index.js is missing. Run npm run build before live:harness-vs-cli.");
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
      const cliFast = pair.cliFastModels.find((id) => cliIds.includes(id.replace(/\[.*$/, "")));
      const cliPlain = pair.cliModels.find((id) => cliIds.includes(id));
      const cliModel = cliIds.includes(pair.cliFastModels[0] ?? "")
        ? pair.cliFastModels[0]
        : cliFast ?? (pair.cliFastModels[0] && pair.cliFastModels[0].includes("[") ? pair.cliFastModels[0] : cliPlain);

      const gateway = gatewayModel
        ? await runGateway({
            baseUrl: child.baseUrl,
            apiKey,
            pair,
            model: gatewayModel,
            fast: catalogHasFast(catalog, gatewayModel),
            timeoutMs,
          })
        : { side: "gateway" as const, status: "catalog_missing" as const, fast: false };
      const cli = cliModel
        ? await runCli({ bin, model: cliModel, timeoutMs, canaries })
        : { side: "cli" as const, status: "catalog_missing" as const, fast: false };
      pairs.push({ id: pair.id, harness: pair.harness, protocol: pair.protocol, gateway, cli });
      for (const side of [gateway, cli]) {
        console.log(
          `case ${pair.id}/${side.side} ${side.status}${side.model ? ` model=${side.model}` : ""}${
            side.fast ? " fast" : ""
          }${side.duration_ms !== undefined ? ` ${side.duration_ms}ms` : ""}${
            side.first_byte_ms !== undefined ? ` first_byte=${side.first_byte_ms}ms` : ""
          }${side.reason ? ` ${side.reason}` : ""}`,
        );
      }
    }

    const receipt = {
      schema: "cursor-sdk2api.harness-vs-cli.v1",
      ok: pairs.every((item) => item.gateway.status !== "fail" && item.cli.status !== "fail"),
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        runner: "tests/live-smoke/harness-vs-cli-timing",
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
    console.error(redactSecrets(error instanceof Error ? error.message : "harness vs cli timing failed", canaries));
  } finally {
    await child.stop().catch(() => undefined);
    child.cleanup();
  }
  process.exit(exitCode);
}

void main();
