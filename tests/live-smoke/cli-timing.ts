#!/usr/bin/env node
/**
 * Opt-in Cursor CLI baseline: same models as live:timing, API key on the
 * official `agent` binary, no HTTP gateway. Stdout and the receipt hold
 * timings and event names only; no prompt, tool payload, or credential.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { liveSmokeGate } from "./lib/gate.js";
import {
  classifyCliEvent,
  parseCliLine,
  parseCliModelIds,
  resolveCliModel,
  type CliMarks,
} from "./lib/cli-stream.js";
import { redactSecrets, assertNoCanary } from "./lib/redact.js";

const DEFAULT_MODELS = "claude-sonnet-4-6,grok-4.6,composer-2.5";

interface TimingCase {
  id: string;
  model: string;
  cli_model?: string;
  protocol: "cli";
  status: "pass" | "fail" | "catalog_missing";
  duration_ms?: number;
  first_byte_ms?: number;
  first_tool_ms?: number;
  last_tool_ms?: number;
  tool_spread_ms?: number;
  tool_names?: string[];
  stop_ms?: number;
  stop_reason?: string;
  tool_lead_ms?: number;
  cli_duration_ms?: number;
  error_type?: string;
  reason?: string;
}

const token = () => `tok-${randomBytes(4).toString("hex")}`;

export function resolveCliBin(env: NodeJS.ProcessEnv): string {
  return env.CURSOR_CLI_BIN?.trim() || "agent";
}

function cliVersion(bin: string): string | undefined {
  const result = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000 });
  const version = result.stdout.trim();
  return version || undefined;
}

function toolCase(
  id: string,
  model: string,
  cliModel: string,
  r: { duration_ms: number; marks: CliMarks },
  minTools: number,
): TimingCase {
  const first = r.marks.tool_items[0]?.at_ms;
  const last = r.marks.tool_items.at(-1)?.at_ms;
  const ok = !r.marks.error_type && r.marks.tool_items.length >= minTools && first !== undefined && r.marks.stop_ms !== undefined;
  return {
    id,
    model,
    cli_model: cliModel,
    protocol: "cli",
    status: ok ? "pass" : "fail",
    duration_ms: r.duration_ms,
    first_byte_ms: r.marks.first_byte_ms,
    first_tool_ms: first,
    last_tool_ms: last,
    tool_spread_ms: first !== undefined && last !== undefined ? last - first : undefined,
    tool_names: r.marks.tool_items.map((item) => item.name),
    stop_ms: r.marks.stop_ms,
    stop_reason: r.marks.stop_reason,
    tool_lead_ms: first !== undefined && r.marks.stop_ms !== undefined ? r.marks.stop_ms - first : undefined,
    cli_duration_ms: r.marks.cli_duration_ms,
    error_type: r.marks.error_type,
    reason: ok ? undefined : r.marks.error_type ?? (r.marks.tool_items.length < minTools ? "expected_tool_batch" : "no_stop"),
  };
}

async function runAgent(options: {
  bin: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  canaries: string[];
}): Promise<{ duration_ms: number; marks: CliMarks; exit_code: number; stderr: string }> {
  const started = Date.now();
  const marks: CliMarks = { tool_items: [] };
  const child = spawn(options.bin, options.args, {
    cwd: options.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
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
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exit_code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("cli_timeout"));
    }, options.timeoutMs);
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
  if (exit_code !== 0 && !marks.error_type) marks.error_type = "cli_exit";
  return {
    duration_ms: Date.now() - started,
    marks,
    exit_code,
    stderr: redactSecrets(stderr.slice(0, 400), options.canaries),
  };
}

async function listCliModels(bin: string, timeoutMs: number, canaries: string[]): Promise<string[]> {
  const workspace = mkdtempSync(join(tmpdir(), "cursor-sdk2api-cli-models-"));
  try {
    for (const args of [["--list-models"], ["models"]]) {
      try {
        const result = await new Promise<string>((resolve, reject) => {
          const child = spawn(bin, args, { cwd: workspace, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
          let out = "";
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            out += chunk;
          });
          child.stderr.on("data", (chunk: string) => {
            out += chunk;
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
            if (code === 0 && out.trim()) resolve(out);
            else reject(new Error("cli_models_failed"));
          });
        });
        const ids = parseCliModelIds(redactSecrets(result, canaries));
        if (ids.length > 0) return ids;
      } catch {
        // try the next listing flag
      }
    }
    return [];
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
  const models = (process.env.LIVE_SMOKE_MODELS?.trim() || DEFAULT_MODELS)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const output = process.env.LIVE_SMOKE_OUTPUT?.trim() || join(tmpdir(), `cursor-sdk2api-cli-timing-${Date.now()}.json`);
  const bin = resolveCliBin(process.env);
  const cases: TimingCase[] = [];
  let exitCode = 1;
  const root = mkdtempSync(join(tmpdir(), "cursor-sdk2api-cli-timing-"));

  try {
    const catalogIds = await listCliModels(bin, Math.min(timeoutMs, 60000), canaries);
    for (const model of models) {
      const resolved = catalogIds.length > 0 ? resolveCliModel(model, catalogIds) : { requested: model, id: model, how: "exact" as const };
      if (!resolved.id) {
        cases.push({ id: `${model}/cli`, model, protocol: "cli", status: "catalog_missing" });
        continue;
      }
      const cliModel = resolved.id;
      const textDir = mkdtempSync(join(root, "text-"));
      const text = await runAgent({
        bin,
        args: [
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
          textDir,
          "--model",
          cliModel,
          `Reply with the single word PONG and nothing else. (${token()})`,
        ],
        cwd: textDir,
        timeoutMs,
        canaries,
      });
      cases.push({
        id: `${model}/cli/text`,
        model,
        cli_model: cliModel,
        protocol: "cli",
        status: text.exit_code === 0 && !text.marks.error_type && text.marks.first_byte_ms !== undefined && text.marks.stop_ms !== undefined
          ? "pass"
          : "fail",
        duration_ms: text.duration_ms,
        first_byte_ms: text.marks.first_byte_ms,
        stop_ms: text.marks.stop_ms,
        stop_reason: text.marks.stop_reason,
        cli_duration_ms: text.marks.cli_duration_ms,
        error_type: text.marks.error_type,
        reason: text.marks.error_type ?? (text.exit_code !== 0 ? `exit_${text.exit_code}` : undefined),
      });

      const singleDir = mkdtempSync(join(root, "single-"));
      writeFileSync(join(singleDir, "marker.txt"), "ok\n", { mode: 0o600 });
      const single = await runAgent({
        bin,
        args: [
          "--print",
          "--output-format",
          "stream-json",
          "--stream-partial-output",
          "--trust",
          "--sandbox",
          "enabled",
          "--workspace",
          singleDir,
          "--model",
          cliModel,
          `Read the file marker.txt using your file tool once. Then reply with the single word DONE. Do not write files. (${token()})`,
        ],
        cwd: singleDir,
        timeoutMs,
        canaries,
      });
      cases.push(toolCase(`${model}/cli/single_tool`, model, cliModel, single, 1));

      const parallelDir = mkdtempSync(join(root, "parallel-"));
      writeFileSync(join(parallelDir, "alpha.txt"), "a\n", { mode: 0o600 });
      writeFileSync(join(parallelDir, "beta.txt"), "b\n", { mode: 0o600 });
      const parallel = await runAgent({
        bin,
        args: [
          "--print",
          "--output-format",
          "stream-json",
          "--stream-partial-output",
          "--trust",
          "--sandbox",
          "enabled",
          "--workspace",
          parallelDir,
          "--model",
          cliModel,
          `Read both independent files alpha.txt and beta.txt now, in the same turn, before answering. Then reply with DONE. Do not write files. (${token()})`,
        ],
        cwd: parallelDir,
        timeoutMs,
        canaries,
      });
      cases.push(toolCase(`${model}/cli/parallel_tools`, model, cliModel, parallel, 2));
    }

    const receipt = {
      schema: "cursor-sdk2api.cli-timing.v1",
      ok: cases.every((item) => item.status === "pass" || item.status === "catalog_missing"),
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        runner: "tests/live-smoke/cli-timing",
        cli_bin: bin,
        cli_version: cliVersion(bin),
      },
      cases,
    };
    const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
    assertNoCanary(serialized, canaries);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, serialized, { encoding: "utf8", mode: 0o600 });
    for (const item of cases) {
      console.log(
        `case ${item.id} ${item.status}${item.duration_ms !== undefined ? ` ${item.duration_ms}ms` : ""}${
          item.first_byte_ms !== undefined ? ` first_byte=${item.first_byte_ms}ms` : ""
        }${item.first_tool_ms !== undefined ? ` first_tool=${item.first_tool_ms}ms` : ""}${
          item.tool_spread_ms !== undefined ? ` spread=${item.tool_spread_ms}ms` : ""
        }${item.tool_lead_ms !== undefined ? ` tool_lead=${item.tool_lead_ms}ms` : ""}${
          item.reason ? ` ${item.reason}` : ""
        }`,
      );
    }
    console.log(`receipt ${output}`);
    console.log(`ok=${receipt.ok}`);
    exitCode = receipt.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error && error.message === "cli_timeout"
      ? "cli_timeout"
      : error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "Cursor CLI binary not found. Install agent and/or set CURSOR_CLI_BIN."
        : error instanceof Error
          ? error.message
          : "cli timing failed";
    console.error(redactSecrets(message, canaries));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

void main();
