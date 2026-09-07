/**
 * Client-side PR inspect tools for the E2E harness loop.
 * Execution stays local. Receipts keep names and byte lengths only.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PR_DIFF_MAX_CHARS = 80_000;
export const PR_FILE_MAX_CHARS = 40_000;

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;

export interface PrInspectContext {
  repoRoot: string;
  pr: number;
  runCommand?: CommandRunner;
}

const DENIED_FILE = /(^|\/)\.env(\.|$)|(^|\/)\.git\/|node_modules|(^|\/)[^/]*key[^/]*$/i;

export const PR_TOOL_SCHEMA = {
  type: "object",
  properties: {
    pr: { type: "number", description: "Pull request number. Only the tasked PR is in scope." },
  },
  required: ["pr"],
} as const;

export const READ_FILE_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Repository-relative file path." },
  },
  required: ["path"],
} as const;

export function inspectTools(): Array<{ name: string; description: string; schema: Record<string, unknown> }> {
  return [
    {
      name: "pr_metadata",
      description: "Read GitHub metadata for the tasked pull request (title, state, stats, body).",
      schema: PR_TOOL_SCHEMA,
    },
    {
      name: "pr_files",
      description: "List files changed in the tasked pull request.",
      schema: PR_TOOL_SCHEMA,
    },
    {
      name: "pr_diff",
      description: "Read a bounded unified diff for the tasked pull request.",
      schema: PR_TOOL_SCHEMA,
    },
    {
      name: "read_repo_file",
      description: "Read one text file from this repository. Paths stay inside the repo root.",
      schema: READ_FILE_SCHEMA,
    },
  ];
}

export function anthropicInspectTools(): Array<Record<string, unknown>> {
  return inspectTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.schema,
  }));
}

export function responsesInspectTools(): Array<Record<string, unknown>> {
  return inspectTools().map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.schema,
  }));
}

export function summaryPrompt(pr: number, nonce: string): string {
  return [
    `Generate a concise summary report of GitHub pull request #${pr} in this repository (cursor-sdk2api).`,
    "Use the available tools to inspect the PR: metadata, changed files, and a bounded diff. Do not guess from memory alone.",
    "Write the report to stdout only. Do not create, modify, or delete any files. Do not print secrets or credentials.",
    "Cover why the change exists, what landed, and the performance or correctness claims.",
    `Nonce: ${nonce}`,
  ].join(" ");
}

export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean; chars: number } {
  if (text.length <= maxChars) return { text, truncated: false, chars: text.length };
  return {
    text: `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`,
    truncated: true,
    chars: text.length,
  };
}

export function resolveRepoFile(repoRoot: string, rawPath: string): { ok: true; path: string } | { ok: false; reason: string } {
  const trimmed = rawPath.trim();
  if (!trimmed) return { ok: false, reason: "path_required" };
  if (trimmed.startsWith("/") || trimmed.includes("\0")) return { ok: false, reason: "path_denied" };
  const resolved = resolve(repoRoot, trimmed);
  const root = resolve(repoRoot);
  if (resolved !== root && !resolved.startsWith(root + sep)) return { ok: false, reason: "path_denied" };
  const relative = resolved.slice(root.length + 1);
  if (DENIED_FILE.test(relative)) return { ok: false, reason: "path_denied" };
  return { ok: true, path: resolved };
}

export async function defaultCommandRunner(file: string, args: string[], cwd?: string): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    });
    return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? "command_failed" };
  }
}

export async function executeInspectTool(
  name: string,
  input: Record<string, unknown>,
  ctx: PrInspectContext,
): Promise<{ ok: boolean; output: string; chars: number }> {
  const run = ctx.runCommand ?? ((file, args) => defaultCommandRunner(file, args, ctx.repoRoot));
  if (name === "read_repo_file") {
    const path = typeof input.path === "string" ? input.path : "";
    const resolved = resolveRepoFile(ctx.repoRoot, path);
    if (!resolved.ok) return { ok: false, output: resolved.reason, chars: resolved.reason.length };
    try {
      const raw = await readFile(resolved.path, "utf8");
      const cut = truncateText(raw, PR_FILE_MAX_CHARS);
      return { ok: true, output: cut.text, chars: cut.chars };
    } catch {
      return { ok: false, output: "read_failed", chars: 11 };
    }
  }

  const pr = Number(input.pr);
  if (pr !== ctx.pr) {
    const output = `only_pr_${ctx.pr}_in_scope`;
    return { ok: false, output, chars: output.length };
  }

  const args =
    name === "pr_metadata"
      ? ["pr", "view", String(pr), "--json", "number,title,state,mergedAt,additions,deletions,changedFiles,author,url,body"]
      : name === "pr_files"
        ? ["pr", "diff", String(pr), "--name-only"]
        : name === "pr_diff"
          ? ["pr", "diff", String(pr)]
          : null;
  if (!args) {
    const output = `unknown_tool_${name}`;
    return { ok: false, output, chars: output.length };
  }

  const result = await run("gh", args);
  const raw = result.ok ? result.stdout : result.stderr || "gh_failed";
  const max = name === "pr_diff" ? PR_DIFF_MAX_CHARS : PR_FILE_MAX_CHARS;
  const cut = truncateText(raw, max);
  return { ok: result.ok, output: cut.text, chars: cut.chars };
}
