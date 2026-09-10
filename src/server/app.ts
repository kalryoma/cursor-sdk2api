import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { CursorAccountPool } from "../auth/account-pool.js";
import {
  authorizeClient,
  managedAccountAuth,
  type AuthContext,
  type ClientAuthorization,
} from "../auth/credentials.js";
import { fetchCursorSandQuota } from "../account/cursor-dashboard.js";
import { readAccount } from "../account/service.js";
import { CursorAccountFileStore, type StoredCursorAccount } from "../account/file-store.js";
import {
  DEFAULT_RUNTIME_PROFILE,
  resolveRequestProfile,
  type RuntimeProfile,
} from "../core/runtime-profile.js";
import type { Clock } from "../clock.js";
import type { GatewayConfig } from "../config.js";
import { CompactAnchorStore } from "../core/compact-anchor.js";
import { RunCoordinator } from "../core/run-coordinator.js";
import type { PumpBoundary } from "../core/event-pump.js";
import { SystemPromptGate } from "../core/system-prompt-gate.js";
import { LineageStore } from "../core/lineage-store.js";
import { OrdinaryTurnJournal } from "../core/ordinary-turn-journal.js";
import {
  publicKeyHint,
  RequestLog,
  type RequestLogBegin,
  type RequestLogFinish,
  type RequestLogUsage,
} from "../core/request-log.js";
import { RuntimeLedger } from "../core/runtime-ledger.js";
import { inspectSandLoader, type SandLoaderHealth } from "../sdk/sand-loader.js";
import { SessionRegistry } from "../core/session-registry.js";
import {
  forbiddenError,
  GatewayError,
  invalidRequest,
  notFound,
  rateLimited,
  redactSecrets,
  sessionLost,
  toPublicErrorBody,
  upstreamError,
} from "../errors.js";
import { requestId as newRequestId } from "../ids.js";
import type { Logger } from "../log.js";
import { parseMessagesRequest } from "../protocols/anthropic/parse.js";
import type { ParsedMessages } from "../protocols/anthropic/types.js";
import { estimateAnthropicInputTokens } from "../protocols/anthropic/count-tokens.js";
import { writeSseError } from "../protocols/anthropic/sse.js";
import { parseChatCompletionsRequest } from "../protocols/openai-chat/parse.js";
import { writeChatStreamError } from "../protocols/openai-chat/sse.js";
import { createChatWriterFactory } from "../protocols/openai-chat/writer.js";
import {
  bindCompactContinuation,
  mintLocalCompact,
  writeLocalCompactResponse,
} from "../protocols/openai-responses/compact.js";
import { parseResponsesRequest } from "../protocols/openai-responses/parse.js";
import { writeResponsesStreamError } from "../protocols/openai-responses/sse.js";
import { createResponsesWriterFactory } from "../protocols/openai-responses/writer.js";
import type { SdkRuntime } from "../sdk/port.js";
import { ModelCatalog } from "../sdk/catalog.js";
import { headerValue, readJsonBody, requestPath, sendError, sendJson, sendOpenAIError } from "./http-util.js";
import { serveConsole } from "./console.js";

export interface App {
  config: GatewayConfig;
  registry: SessionRegistry;
  coordinator: RunCoordinator;
  catalog: ModelCatalog;
  lineage: LineageStore;
  ordinaryJournal: OrdinaryTurnJournal;
  accounts: CursorAccountFileStore;
  sdk: SdkRuntime;
  ledger?: RuntimeLedger;
  sandHealth: SandLoaderHealth;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  listen(): Server;
  beginShutdown(): void;
  close(): void;
}

async function listManagedModels(accounts: StoredCursorAccount[], catalog: ModelCatalog): Promise<{
  status: "ok" | "unavailable" | "stale";
  reason?: string;
  models: Awaited<ReturnType<ModelCatalog["list"]>>["models"];
  stale: boolean;
}> {
  if (accounts.length === 0) {
    return {
      status: "unavailable",
      reason: "cursor_account_pool_empty",
      models: [],
      stale: false,
    };
  }
  const results = await Promise.all(
    accounts.map((account) => catalog.list(account.apiKey, managedAccountAuth(account.apiKey).fingerprint)),
  );
  const models = new Map<string, Awaited<ReturnType<ModelCatalog["list"]>>["models"][number]>();
  for (const listed of results) {
    for (const model of listed.models) {
      if (!models.has(model.id)) models.set(model.id, model);
    }
  }
  const hasOk = results.some((listed) => listed.status === "ok");
  const hasStale = results.some((listed) => listed.status === "stale");
  const status = hasOk ? "ok" : hasStale ? "stale" : "unavailable";
  return {
    status,
    ...(status === "unavailable"
      ? { reason: results.map((listed) => listed.reason).find(Boolean) ?? "cursor_models_list_unavailable" }
      : {}),
    models: [...models.values()],
    stale: !hasOk && hasStale,
  };
}

function managedPreSemanticFailureCanFailover(error: unknown): boolean {
  if (!(error instanceof GatewayError)) return true;
  if (
    error.code === "authentication_error" ||
    error.code === "forbidden" ||
    error.code === "rate_limited" ||
    error.code === "cursor_timeout" ||
    error.code === "cursor_upstream_error"
  ) {
    return true;
  }
  return error.httpStatus >= 500;
}

function responseStarted(res: ServerResponse): boolean {
  return res.headersSent || res.writableEnded || res.destroyed;
}

function staleCredentialSessionError(error: unknown): boolean {
  if (!(error instanceof GatewayError) || error.code !== "authentication_error") return false;
  return !/invalid|revoked|expired|disabled|unauthorized api key/i.test(error.message);
}

export function createApp(input: {
  config: GatewayConfig;
  sdk: SdkRuntime;
  clock: Clock;
  logger: Logger;
  workspaceDir: string;
  beforeApplyBoundary?: (boundary: PumpBoundary) => Promise<void>;
  fetchSandQuota?: typeof fetchCursorSandQuota;
  sandHealth?: SandLoaderHealth;
  assertSandAccess?: (apiKey: string) => Promise<void>;
}): App {
  const { config, sdk, clock, logger, workspaceDir, beforeApplyBoundary } = input;
  const fetchSandQuota = input.fetchSandQuota ?? fetchCursorSandQuota;
  const sandHealth = input.sandHealth ?? inspectSandLoader();
  const assertSandAccess = input.assertSandAccess ?? (async (apiKey: string) => {
    const quota = await fetchSandQuota(apiKey);
    if (!quota.available) throw forbiddenError("Sand is unavailable until Grok Bot access is granted");
  });
  const registry = new SessionRegistry(clock, config.instanceId, {
    globalActiveRuns: config.globalActiveRuns,
    perCredentialActiveRuns: config.perCredentialActiveRuns,
    maxAwaitingSessions: config.maxAwaitingSessions,
    sessionTtlMs: config.sessionTtlMs,
    replayTtlMs: config.replayTtlMs,
    runDeadlineMs: config.runDeadlineMs,
  });
  const lineage = new LineageStore(config.stateDir, clock);
  const compactStore = new CompactAnchorStore(config.stateDir, clock);
  const ordinaryJournal = new OrdinaryTurnJournal(join(config.stateDir, "ordinary-turns.json"), {
    now: () => clock.now(),
  });
  const ledger = config.runtimeLedgerV2
    ? RuntimeLedger.open(config.stateDir, { clock, migrateLegacy: true })
    : undefined;
  const coordinator = new RunCoordinator({
    config,
    sdk,
    registry,
    clock,
    logger,
    workspaceDir,
    lineage,
    ordinaryJournal,
    ledger,
    sandHealth,
    assertSandAccess,
    beforeApplyBoundary,
  });
  const catalog = new ModelCatalog(sdk, clock, config.catalogCacheMs);
  const accounts = new CursorAccountFileStore(config.stateDir, config.managedCursorKey);
  const requestLog = new RequestLog(clock);

  const responseHeader = (res: ServerResponse, name: string): string | undefined => {
    const value = res.getHeader(name);
    if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
    return typeof value === "string" ? value : undefined;
  };

  const usageFromSession = (sessionId?: string): RequestLogUsage | undefined => {
    if (!sessionId) return undefined;
    const usage = registry.get(sessionId)?.replay?.turn.usage;
    if (!usage) return undefined;
    const out: RequestLogUsage = {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
    };
    if (usage.cache_creation_input_tokens != null) out.cache_creation_input_tokens = usage.cache_creation_input_tokens;
    if (usage.cache_read_input_tokens != null) out.cache_read_input_tokens = usage.cache_read_input_tokens;
    if (usage.reasoning_tokens != null) out.reasoning_tokens = usage.reasoning_tokens;
    if (usage.usage_status) out.usage_status = usage.usage_status;
    return out;
  };

  const finishRequestLog = (
    id: string,
    res: ServerResponse,
    error?: unknown,
    extra: RequestLogFinish = {},
  ) => {
    const sessionId = extra.session_id ?? responseHeader(res, "x-cursor-session-id");
    const session = sessionId ? registry.get(sessionId) : undefined;
    const stored = session ? accounts.findByFingerprint(session.credentialFingerprint) : undefined;
    const status = extra.status
      ?? (error instanceof GatewayError
        ? error.httpStatus
        : error
          ? (res.headersSent ? res.statusCode || 502 : 502)
          : (res.statusCode || 200));
    requestLog.finish(id, {
      status,
      session_id: sessionId,
      account_id: extra.account_id ?? stored?.id,
      key_hint: extra.key_hint ?? stored?.keyHint,
      runtime_profile: extra.runtime_profile ?? session?.runtimeProfile,
      model: extra.model,
      stream: extra.stream,
      usage: extra.usage ?? usageFromSession(sessionId),
      error_type: extra.error_type ?? (
        error instanceof GatewayError ? error.code : error ? "cursor_upstream_error" : undefined
      ),
      error: extra.error ?? (error
        ? redactSecrets(error instanceof Error ? error.message : String(error ?? "Unexpected error"))
        : undefined),
    });
  };
  const accountPool = new CursorAccountPool();
  const accountPayload = (apiKey: string, defaultProfile?: RuntimeProfile) =>
    readAccount(sdk, apiKey, {
      fetchSandQuota,
      defaultProfile: defaultProfile ?? config.runtimePolicy.defaultProfile ?? DEFAULT_RUNTIME_PROFILE,
      sandLoaderReady: sandHealth.ready,
    });
  const publicAccount = (account: StoredCursorAccount) => ({
    id: account.id,
    key_hint: account.keyHint,
    added_at: account.addedAt,
    default_profile: account.defaultProfile,
    paused: account.paused,
  });

  const boundCredentialFingerprint = (parsed: ParsedMessages, sessionHint?: string): string | undefined => {
    if (parsed.continuation) {
      const ids = parsed.continuation.map((result) => result.toolUseId);
      const lookup = registry.lookupByToolIds(ids);
      if (!lookup.mixed && lookup.session) return lookup.session.credentialFingerprint;
      const record = lineage.findByToolIds(ids);
      if (record) return record.credentialFingerprint;
    }
    if (sessionHint) {
      return registry.get(sessionHint)?.credentialFingerprint ?? lineage.get(sessionHint)?.credentialFingerprint;
    }
    return undefined;
  };

  const resolveManagedAuth = async (
    parsed?: ParsedMessages,
    sessionHint?: string,
    excludedFingerprints: ReadonlySet<string> = new Set(),
  ): Promise<AuthContext> => {
    const boundFingerprint = parsed ? boundCredentialFingerprint(parsed, sessionHint) : undefined;
    if (boundFingerprint && !excludedFingerprints.has(boundFingerprint)) {
      const bound = accounts.findByFingerprint(boundFingerprint);
      if (bound) return managedAccountAuth(bound.apiKey, bound.defaultProfile);
      // A self-contained tool continuation can cold-branch from its full
      // transcript when the originally bound managed account was removed.
      // Completed session follow-ups still require their original account.
      if (!parsed?.continuation) {
        throw sessionLost("The Cursor account bound to this session is no longer configured");
      }
    }

    const configured = accounts.list();
    if (configured.length === 0) {
      throw upstreamError("No Cursor accounts are configured in the gateway pool", 503);
    }
    // Paused accounts are removed from new-run placement only; sessions
    // already bound to them keep resolving through the branch above.
    const routable = configured.filter((account) => !account.paused);
    if (routable.length === 0) {
      throw upstreamError("All Cursor accounts in the gateway pool are paused", 503);
    }
    let candidates = routable;
    if (parsed) {
      const checked = await Promise.all(
        routable.map(async (account) => ({
          account,
          catalog: await catalog.list(account.apiKey, managedAccountAuth(account.apiKey).fingerprint),
        })),
      );
      candidates = checked
        .filter(({ catalog: listed }) => listed.models.some((model) => model.id === parsed.model))
        .map(({ account }) => account);
      if (candidates.length === 0) {
        if (checked.some(({ catalog: listed }) => listed.status === "unavailable")) {
          throw upstreamError("Cursor model catalogs are unavailable across the configured account pool", 503);
        }
        throw forbiddenError(`Model ${parsed.model} is unavailable across the configured Cursor accounts`);
      }
    }

    candidates = candidates.filter(
      (account) =>
        !excludedFingerprints.has(managedAccountAuth(account.apiKey).fingerprint) &&
        registry.activeRunCountForCredential(managedAccountAuth(account.apiKey).fingerprint) <
        config.perCredentialActiveRuns,
    );
    if (candidates.length === 0) {
      throw rateLimited(
        parsed
          ? `All Cursor accounts compatible with ${parsed.model} are at active run capacity`
          : "All Cursor accounts are at active run capacity",
      );
    }

    const selected = accountPool.pick(candidates, parsed?.model ?? "account");
    if (!selected) throw upstreamError("No Cursor account is available", 503);
    return managedAccountAuth(selected.apiKey, selected.defaultProfile);
  };

  const resolveAuth = async (
    client: ClientAuthorization,
    parsed?: ParsedMessages,
    sessionHint?: string,
    excludedFingerprints: ReadonlySet<string> = new Set(),
  ): Promise<AuthContext> => client.mode === "byok"
    ? client.auth
    : resolveManagedAuth(parsed, sessionHint, excludedFingerprints);
  const credentialProbes = new Map<string, Promise<"valid" | "invalid" | "unavailable">>();
  const probeCredential = (auth: AuthContext): Promise<"valid" | "invalid" | "unavailable"> => {
    const existing = credentialProbes.get(auth.fingerprint);
    if (existing) return existing;
    const probe = sdk.probeCredential(auth.cursorApiKey);
    credentialProbes.set(auth.fingerprint, probe);
    void probe.finally(() => {
      if (credentialProbes.get(auth.fingerprint) === probe) credentialProbes.delete(auth.fingerprint);
    }).catch(() => undefined);
    return probe;
  };

  const runWithProviderRecovery = async (
    res: ServerResponse,
    client: ClientAuthorization,
    parsed: ParsedMessages,
    sessionHint: string | undefined,
    run: (auth: AuthContext) => Promise<void>,
  ): Promise<void> => {
    const first = await resolveAuth(client, parsed, sessionHint);
    try {
      await run(first);
      return;
    } catch (initialError) {
      let error = initialError;
      if (!responseStarted(res) && SystemPromptGate.matches(error)) {
        // The account is not enabled for the SDK systemPrompt; remember that and send the prompt inline.
        coordinator.systemPromptGate.markGated(first.fingerprint);
        logger.warn(
          { model: parsed.model, fallback_reason: "system_prompt_gated" },
          "retrying pre-semantic Cursor request with the inline system prompt",
        );
        try {
          await run(first);
          return;
        } catch (retryError) {
          error = retryError;
        }
      }
      if (!responseStarted(res) && staleCredentialSessionError(error)) {
        const probe = await probeCredential(first);
        if (probe === "valid") {
          logger.warn(
            { model: parsed.model, error_type: "authentication_error" },
            "retrying pre-semantic Cursor request after credential probe",
          );
          try {
            await run(first);
            return;
          } catch (retryError) {
            error = retryError;
          }
        }
      }
      if (
        client.mode !== "managed" ||
        responseStarted(res) ||
        !managedPreSemanticFailureCanFailover(error)
      ) {
        throw error;
      }
      let alternate: AuthContext;
      try {
        alternate = await resolveAuth(client, parsed, sessionHint, new Set([first.fingerprint]));
      } catch {
        throw error;
      }
      logger.warn(
        { model: parsed.model, error_type: error instanceof GatewayError ? error.code : "cursor_upstream_error" },
        "retrying pre-semantic Cursor request on another managed account",
      );
      await run(alternate);
    }
  };

  const runtimeProfileFor = (req: IncomingMessage, client: ClientAuthorization, auth?: AuthContext) => {
    try {
      return resolveRequestProfile({
        header: headerValue(req, "x-cursor-runtime-profile"),
        policy: config.runtimePolicy,
        authMode: client.mode,
        accountDefaultProfile: auth?.defaultProfile,
      });
    } catch (error) {
      throw invalidRequest(error instanceof Error ? error.message : "Invalid runtime profile");
    }
  };

  let shuttingDown = false;
  const sweepTimer = setInterval(() => {
    try {
      registry.sweep();
      lineage.sweep();
      compactStore.sweep();
      coordinator.sweepOrdinaryState();
    } catch {
      // sweep must not crash the process
    }
  }, Math.max(20, config.sweepIntervalMs));
  sweepTimer.unref();

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = headerValue(req, "x-request-id") || newRequestId();
    const path = requestPath(req);
    const method = (req.method ?? "GET").toUpperCase();
    const withRequestLog = async (
      meta: RequestLogBegin,
      work: (logId: string) => Promise<void>,
    ): Promise<void> => {
      const entry = requestLog.begin(meta);
      try {
        await work(entry.id);
        finishRequestLog(entry.id, res);
      } catch (error) {
        finishRequestLog(entry.id, res, error);
        throw error;
      }
    };
    const rememberAccount = (logId: string, client: ClientAuthorization, auth: AuthContext) => {
      const stored = accounts.findByFingerprint(auth.fingerprint);
      let profile: RuntimeProfile | undefined;
      try {
        profile = runtimeProfileFor(req, client, auth);
      } catch {
        profile = auth.defaultProfile;
      }
      requestLog.patch(logId, {
        ...(stored
          ? { account_id: stored.id, key_hint: stored.keyHint }
          : client.mode === "byok"
            ? { key_hint: publicKeyHint(client.auth.cursorApiKey) }
            : {}),
        ...(profile ? { runtime_profile: profile } : {}),
      });
    };
    try {
      if (
        (method === "GET" || method === "HEAD") &&
        serveConsole(res, path, requestId, config.consoleDir, method === "HEAD")
      ) {
        return;
      }

      if (method === "GET" && path === "/health") {
        sendJson(
          res,
          200,
          {
            status: shuttingDown ? "not_ready" : "ok",
            service: "cursor-sdk2api",
            version: config.version,
            sdk_version:
              sdk.sdkVersion && sdk.sdkVersion !== "unavailable" ? sdk.sdkVersion : config.sdkVersion,
            network: {
              proxy_configured: config.proxyConfigured,
              agent_transport: config.agentTransport,
              fetch_transport: config.fetchTransport,
            },
            runtime: "local",
            instance_id: config.instanceId,
            profiles: {
              default: config.runtimePolicy.defaultProfile,
              sdk: {
                ready: true,
                sdk_version:
                  sdk.sdkVersion && sdk.sdkVersion !== "unavailable" ? sdk.sdkVersion : config.sdkVersion,
              },
              sand: {
                ready: sandHealth.ready,
                sdk_version: sandHealth.sdk_version,
                patch_contract_version: sandHealth.patch_contract_version,
                ...(sandHealth.ready || !sandHealth.reason ? {} : { reason: sandHealth.reason }),
              },
            },
            readiness: {
              accepting_sessions: !shuttingDown && !registry.shuttingDown,
              shutting_down: shuttingDown,
            },
            capabilities: {
              ...config.capabilities,
              agent_resume: config.capabilities.agent_resume,
              pending_tool_restart_resume: config.capabilities.pending_tool_restart_resume,
              ordinary_turn_coordinator: config.ordinaryTurnCoordinator,
              store_backend: config.capabilities.store_backend ?? "jsonl",
            },
            verification: {
              live_smoke: false,
              chat_completions: "contract_tested_unverified_live",
              responses: "contract_tested_unverified_live",
              streaming: "sdk_onDelta",
              thinking: "implemented_unverified_live",
              images: "implemented_unverified_live",
              parallel_tools: "implemented_unverified_live",
            },
          },
          requestId,
        );
        return;
      }

      if (path === "/v0/management/logs" && method === "GET") {
        const raw = new URL(req.url ?? "/", "http://localhost").searchParams.get("limit");
        const limit = raw == null || raw === "" ? 200 : Number(raw);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
          throw invalidRequest("limit is invalid");
        }
        sendJson(
          res,
          200,
          {
            generated_at: clock.now(),
            total: requestLog.size,
            logs: requestLog.list(limit),
          },
          requestId,
        );
        return;
      }

      if (path === "/v0/management/accounts/probe" && method === "GET") {
        const id = new URL(req.url ?? "/", "http://localhost").searchParams.get("id")?.trim() ?? "";
        if (!id) throw invalidRequest("id is required");
        const stored = accounts.get(id);
        if (!stored) throw notFound("Persistent account was not found");
        const auth = managedAccountAuth(stored.apiKey, stored.defaultProfile);
        const [models, account] = await Promise.all([
          catalog.list(stored.apiKey, auth.fingerprint),
          accountPayload(stored.apiKey, stored.defaultProfile),
        ]);
        sendJson(res, 200, {
          models: {
            object: "list",
            data: models.models.map((model) => ({
              id: model.id,
              object: "model",
              display_name: model.displayName,
              description: model.description,
              parameters: model.parameters,
              variants: model.variants,
            })),
            status: models.status,
            ...(models.reason ? { reason: models.reason } : {}),
            cache: { stale: models.stale, ...(models.stale ? { reason: models.reason ?? "refresh_failed" } : {}) },
          },
          account,
        }, requestId);
        return;
      }

      if (path === "/v0/management/accounts/run" && method === "POST") {
        const body = await readJsonBody(req, config.maxBodyBytes) as {
          account_id?: unknown;
          protocol?: unknown;
          request?: unknown;
        } | undefined;
        const id = typeof body?.account_id === "string" ? body.account_id.trim() : "";
        const protocol = body?.protocol;
        if (!id) throw invalidRequest("account_id is required");
        const stored = accounts.get(id);
        if (!stored) throw notFound("Persistent account was not found");
        if (!body || body.request === undefined) throw invalidRequest("request is required");
        if (protocol !== "messages" && protocol !== "chat" && protocol !== "responses") {
          throw invalidRequest("protocol must be messages, chat, or responses");
        }
        const auth = managedAccountAuth(stored.apiKey, stored.defaultProfile);
        await withRequestLog({
          protocol,
          path,
          method,
          request_id: requestId,
          account_id: stored.id,
          key_hint: stored.keyHint,
        }, async (logId) => {
          if (protocol === "messages") {
            const parsed = parseMessagesRequest(body.request);
            requestLog.patch(logId, { model: parsed.model, stream: parsed.stream });
            await coordinator.handleMessages(req, res, auth, parsed, requestId);
            return;
          }
          if (protocol === "chat") {
            const chat = parseChatCompletionsRequest(body.request);
            requestLog.patch(logId, { model: chat.parsed.model, stream: chat.parsed.stream });
            await coordinator.handleMessages(
              req,
              res,
              auth,
              chat.parsed,
              requestId,
              undefined,
              createChatWriterFactory({ includeUsage: chat.includeUsage }),
            );
            return;
          }
          const responses = parseResponsesRequest(body.request, {
            hostedSearchMode: config.runtimePolicy.hostedSearchMode,
          });
          requestLog.patch(logId, { model: responses.parsed.model, stream: responses.parsed.stream });
          await coordinator.handleMessages(
            req,
            res,
            auth,
            responses.parsed,
            requestId,
            undefined,
            createResponsesWriterFactory(),
          );
        });
        return;
      }

      if (path === "/v0/management/accounts/default_profile" && method === "PUT") {
        const body = await readJsonBody(req, config.maxBodyBytes) as {
          id?: unknown;
          default_profile?: unknown;
        } | undefined;
        const id = typeof body?.id === "string" ? body.id.trim() : "";
        if (!id) throw invalidRequest("id is required");
        const stored = accounts.get(id);
        if (!stored) throw notFound("Persistent account was not found");
        const rawProfile = typeof body?.default_profile === "string" ? body.default_profile.trim().toLowerCase() : "";
        if (rawProfile !== "sdk" && rawProfile !== "sand") {
          throw invalidRequest("default_profile is invalid");
        }
        const grokBot = await fetchSandQuota(stored.apiKey).catch(() => ({ available: false as const }));
        if (rawProfile === "sand" && !grokBot.available) {
          throw invalidRequest("Sand is unavailable until Grok Bot access is granted");
        }
        const updated = accounts.setDefaultProfile(id, rawProfile);
        if (!updated) throw notFound("Persistent account was not found");
        sendJson(res, 200, {
          ...publicAccount(updated),
          account: await accountPayload(updated.apiKey, updated.defaultProfile),
        }, requestId);
        return;
      }

      if (path === "/v0/management/accounts/paused" && method === "PUT") {
        const body = await readJsonBody(req, config.maxBodyBytes) as { id?: unknown; paused?: unknown } | undefined;
        const id = typeof body?.id === "string" ? body.id.trim() : "";
        if (!id) throw invalidRequest("id is required");
        if (typeof body?.paused !== "boolean") throw invalidRequest("paused is invalid");
        const updated = accounts.setPaused(id, body.paused);
        if (!updated) throw notFound("Persistent account was not found");
        sendJson(res, 200, { account: publicAccount(updated) }, requestId);
        return;
      }

      if (path === "/v0/management/accounts") {
        if (method === "GET") {
          sendJson(
            res,
            200,
            {
              accounts: accounts.list().map(publicAccount),
            },
            requestId,
          );
          return;
        }
        if (method === "POST") {
          const body = await readJsonBody(req, config.maxBodyBytes) as { api_key?: unknown } | undefined;
          const apiKey = typeof body?.api_key === "string" ? body.api_key.trim() : "";
          if (!apiKey) throw invalidRequest("api_key is required");
          const account = accounts.add(apiKey);
          sendJson(
            res,
            201,
            {
              account: publicAccount(account),
            },
            requestId,
          );
          return;
        }
        if (method === "DELETE") {
          const id = new URL(req.url ?? "/", "http://localhost").searchParams.get("id")?.trim() ?? "";
          if (!id) throw invalidRequest("id is required");
          if (!accounts.remove(id)) throw notFound("Persistent account was not found");
          sendJson(res, 200, { deleted: true }, requestId);
          return;
        }
      }

      if (method === "GET" && path === "/v1/models") {
        const client = authorizeClient(req, config);
        const listed = client.mode === "byok"
          ? await catalog.list(client.auth.cursorApiKey, client.auth.fingerprint)
          : await listManagedModels(accounts.list(), catalog);
        sendJson(
          res,
          listed.status === "unavailable" ? 200 : 200,
          {
            object: "list",
            data: listed.models.map((model) => ({
              id: model.id,
              object: "model",
              display_name: model.displayName,
              description: model.description,
              parameters: model.parameters,
              variants: model.variants,
            })),
            status: listed.status,
            ...(listed.reason ? { reason: listed.reason } : {}),
            cache: listed.stale
              ? { stale: true, reason: listed.reason ?? "refresh_failed" }
              : { stale: false },
            ...(client.mode === "managed" ? { account_pool_size: accounts.list().length } : {}),
          },
          requestId,
        );
        return;
      }

      if (method === "GET" && path === "/v1/account") {
        const client = authorizeClient(req, config);
        if (client.mode === "byok") {
          const account = await accountPayload(client.auth.cursorApiKey);
          sendJson(res, 200, account, requestId);
        } else {
          const configured = accounts.list();
          const details = await Promise.all(
            configured.map(async (account) => ({
              id: account.id,
              key_hint: account.keyHint,
              account: await accountPayload(account.apiKey, account.defaultProfile),
            })),
          );
          sendJson(res, 200, { pool: true, account_count: details.length, accounts: details }, requestId);
        }
        return;
      }

      if (method === "POST" && path === "/v1/messages/count_tokens") {
        authorizeClient(req, config);
        const body = await readJsonBody(req, config.maxBodyBytes);
        if (body === undefined) throw invalidRequest("JSON body is required");
        const parsed = parseMessagesRequest(body);
        res.setHeader("x-cursor-sdk2api-token-count", "estimated");
        sendJson(res, 200, { input_tokens: estimateAnthropicInputTokens(body, parsed) }, requestId);
        return;
      }

      if (method === "POST" && path === "/v1/messages") {
        await withRequestLog({ protocol: "messages", path, method, request_id: requestId }, async (logId) => {
          const client = authorizeClient(req, config);
          if (client.mode === "byok") {
            requestLog.patch(logId, { key_hint: publicKeyHint(client.auth.cursorApiKey) });
          }
          const body = await readJsonBody(req, config.maxBodyBytes);
          if (body === undefined) throw invalidRequest("JSON body is required");
          const parsed = parseMessagesRequest(body);
          requestLog.patch(logId, { model: parsed.model, stream: parsed.stream });
          const sessionHint = headerValue(req, "x-cursor-session-id");
          await runWithProviderRecovery(res, client, parsed, sessionHint, (auth) => {
            rememberAccount(logId, client, auth);
            return coordinator.handleMessages(req, res, auth, parsed, requestId, sessionHint);
          });
        });
        return;
      }

      if (method === "POST" && path === "/v1/chat/completions") {
        await withRequestLog({ protocol: "chat", path, method, request_id: requestId }, async (logId) => {
          const client = authorizeClient(req, config);
          if (client.mode === "byok") {
            requestLog.patch(logId, { key_hint: publicKeyHint(client.auth.cursorApiKey) });
          }
          const body = await readJsonBody(req, config.maxBodyBytes);
          if (body === undefined) throw invalidRequest("JSON body is required");
          const chat = parseChatCompletionsRequest(body);
          requestLog.patch(logId, { model: chat.parsed.model, stream: chat.parsed.stream });
          const sessionHint = headerValue(req, "x-cursor-session-id");
          await runWithProviderRecovery(res, client, chat.parsed, sessionHint, (auth) => {
            rememberAccount(logId, client, auth);
            return coordinator.handleMessages(
              req,
              res,
              auth,
              chat.parsed,
              requestId,
              sessionHint,
              createChatWriterFactory({ includeUsage: chat.includeUsage }),
            );
          });
        });
        return;
      }

      if (method === "POST" && path === "/v1/responses") {
        await withRequestLog({ protocol: "responses", path, method, request_id: requestId }, async (logId) => {
          const client = authorizeClient(req, config);
          if (client.mode === "byok") {
            requestLog.patch(logId, { key_hint: publicKeyHint(client.auth.cursorApiKey) });
          }
          const body = await readJsonBody(req, config.maxBodyBytes);
          if (body === undefined) throw invalidRequest("JSON body is required");
          const responses = parseResponsesRequest(body, {
            hostedSearchMode: config.runtimePolicy.hostedSearchMode,
          });
          requestLog.patch(logId, { model: responses.parsed.model, stream: responses.parsed.stream });
          const sessionHint = headerValue(req, "x-cursor-session-id");
          if (responses.compaction.trigger) {
            const auth = await resolveAuth(client, responses.parsed, sessionHint);
            rememberAccount(logId, client, auth);
            const minted = mintLocalCompact({
              store: compactStore,
              account: auth.fingerprint,
              profile: runtimeProfileFor(req, client, auth),
              parsed: responses,
              sessionHint,
            });
            writeLocalCompactResponse({
              res,
              clock,
              requestId,
              stream: responses.parsed.stream,
              model: responses.parsed.model,
              token: minted.token,
              compactId: minted.record.compactId,
              sessionId: sessionHint,
            });
            return;
          }
          await runWithProviderRecovery(res, client, responses.parsed, sessionHint, (auth) => {
            rememberAccount(logId, client, auth);
            let hint = sessionHint;
            if (responses.compaction.encryptedContent) {
              const bound = bindCompactContinuation({
                store: compactStore,
                token: responses.compaction.encryptedContent,
                account: auth.fingerprint,
                profile: runtimeProfileFor(req, client, auth),
                parsed: responses,
              });
              hint = sessionHint ?? bound.sessionId;
            }
            return coordinator.handleMessages(
              req,
              res,
              auth,
              responses.parsed,
              requestId,
              hint,
              createResponsesWriterFactory(),
            );
          });
        });
        return;
      }

      if (method === "POST" && path === "/v1/responses/compact") {
        await withRequestLog({ protocol: "responses", path, method, request_id: requestId }, async (logId) => {
          const client = authorizeClient(req, config);
          if (client.mode === "byok") {
            requestLog.patch(logId, { key_hint: publicKeyHint(client.auth.cursorApiKey) });
          }
          const body = await readJsonBody(req, config.maxBodyBytes);
          if (body === undefined) throw invalidRequest("JSON body is required");
          const responses = parseResponsesRequest(body, {
            hostedSearchMode: config.runtimePolicy.hostedSearchMode,
          });
          requestLog.patch(logId, { model: responses.parsed.model, stream: responses.parsed.stream });
          const sessionHint = headerValue(req, "x-cursor-session-id");
          const auth = await resolveAuth(client, responses.parsed, sessionHint);
          rememberAccount(logId, client, auth);
          const minted = mintLocalCompact({
            store: compactStore,
            account: auth.fingerprint,
            profile: runtimeProfileFor(req, client, auth),
            parsed: responses,
            sessionHint,
          });
          writeLocalCompactResponse({
            res,
            clock,
            requestId,
            stream: responses.parsed.stream,
            model: responses.parsed.model,
            token: minted.token,
            compactId: minted.record.compactId,
            sessionId: sessionHint,
          });
        });
        return;
      }

      throw notFound(`No route for ${method} ${path}`);
    } catch (error) {
      logger.warn(
        {
          request_id: requestId,
          path,
          method,
          status: error instanceof GatewayError ? error.httpStatus : 502,
          error_type: error instanceof GatewayError ? error.code : "cursor_upstream_error",
          error: redactSecrets(error instanceof Error ? error.message : String(error ?? "Unexpected error")),
        },
        "request failed",
      );
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) {
        if (path === "/v1/chat/completions") writeChatStreamError(res, error, requestId);
        else if (path === "/v1/responses" || path === "/v1/responses/compact") writeResponsesStreamError(res, error, requestId);
        else writeSseError(res, toPublicErrorBody(error, requestId));
        res.end();
        return;
      }
      if (path === "/v1/chat/completions" || path === "/v1/responses" || path === "/v1/responses/compact") sendOpenAIError(res, error, requestId);
      else sendError(res, error, requestId);
    }
  };

  return {
    config,
    registry,
    coordinator,
    catalog,
    lineage,
    ordinaryJournal,
    accounts,
    sdk,
    ledger,
    sandHealth,
    handler,
    listen() {
      const server = createServer((req, res) => {
        void handler(req, res);
      });
      server.listen(config.port, config.host);
      return server;
    },
    beginShutdown() {
      shuttingDown = true;
      clearInterval(sweepTimer);
      registry.beginShutdown();
    },
    close() {
      ledger?.close();
    },
  };
}
