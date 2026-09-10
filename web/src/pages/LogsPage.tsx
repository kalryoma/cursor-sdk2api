import { useEffect, useRef, useState } from "react";
import { getRequestLogs } from "../api";
import { Button } from "../bflabs/Button";
import { StatusTag, type StatusTagTone } from "../bflabs/StatusTag";
import { Tabs } from "../bflabs/Tabs";
import type { RequestLogEntry, RequestLogUsage } from "../types";
import { PageFrame } from "./shared";

export const LOGS_POLL_INTERVAL_MS = 2000;

export type LogsCopy = {
  kicker: string;
  title: string;
  autoRefresh: string;
  refresh: string;
  refreshing: string;
  empty: string;
  error: string;
  running: string;
  details: string;
  detail: string;
  raw: string;
  close: string;
  headers: [string, string, string, string, string, string, string, string];
  fieldTime: string;
  fieldProtocol: string;
  fieldModel: string;
  fieldStatus: string;
  fieldDuration: string;
  fieldTokens: string;
  fieldAccount: string;
  fieldRequest: string;
  fieldSession: string;
  fieldPath: string;
  fieldMethod: string;
  fieldStream: string;
  fieldProfile: string;
  fieldError: string;
  fieldErrorType: string;
  yes: string;
  no: string;
};

export function LogsPage({ t, locale }: { t: LogsCopy; locale: "en" | "zh" }) {
  const [logs, setLogs] = useState<RequestLogEntry[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<RequestLogEntry | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const load = async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const body = await getRequestLogs();
      setLogs(body.logs);
      setError("");
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : t.error);
    } finally {
      if (!quiet) setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      void load(true);
    }, LOGS_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [autoRefresh]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (detail && !dialog.open) dialog.showModal();
    if (!detail && dialog.open) dialog.close();
  }, [detail]);

  return (
    <PageFrame
      kicker={t.kicker}
      title={t.title}
      actions={(
        <>
          <label className="log-auto">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
            />
            {t.autoRefresh}
          </label>
          <Button variant="secondary" size="sm" loading={refreshing} disabled={refreshing} onClick={() => void load()}>
            {refreshing ? t.refreshing : t.refresh}
          </Button>
        </>
      )}
    >
      {error ? <p className="empty" role="alert">{error}</p> : null}
      {logs.length === 0 && !error ? <p className="empty">{t.empty}</p> : null}
      {logs.length > 0 ? (
        <div className="table-wrap">
          <table className="grid-table">
            <thead>
              <tr>
                {t.headers.map((label) => <th key={label}>{label}</th>)}
              </tr>
            </thead>
            <tbody>
              {logs.map((entry) => (
                <tr
                  key={entry.id}
                  className="log-row"
                  tabIndex={0}
                  onClick={() => setDetail(entry)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setDetail(entry);
                    }
                  }}
                >
                  <td>{formatTime(entry.started_at, locale)}</td>
                  <td>{entry.protocol}</td>
                  <td className="mono">{entry.model || "—"}</td>
                  <td>
                    <StatusTag tone={statusTone(entry.status)}>
                      {entry.status === "running" ? t.running : String(entry.status)}
                    </StatusTag>
                  </td>
                  <td>{entry.duration_ms == null ? "—" : `${entry.duration_ms} ms`}</td>
                  <td>{formatTokens(entry.usage)}</td>
                  <td className="mono">{entry.key_hint || entry.account_id || "—"}</td>
                  <td className="mono">{shortId(entry.request_id)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <dialog
        ref={dialogRef}
        className="log-modal"
        onClose={() => setDetail(null)}
      >
        {detail ? (
          <>
            <header className="log-modal-head">
              <h2>{t.details}</h2>
              <Button variant="quiet" size="sm" onClick={() => dialogRef.current?.close()}>{t.close}</Button>
            </header>
            <Tabs
              label={t.details}
              items={[
                {
                  value: "detail",
                  label: t.detail,
                  content: <LogDetail t={t} locale={locale} entry={detail} />,
                },
                {
                  value: "raw",
                  label: t.raw,
                  content: <pre className="log-raw">{JSON.stringify(detail, null, 2)}</pre>,
                },
              ]}
            />
          </>
        ) : null}
      </dialog>
    </PageFrame>
  );
}

function LogDetail({ t, locale, entry }: { t: LogsCopy; locale: "en" | "zh"; entry: RequestLogEntry }) {
  const rows: Array<[string, string]> = [
    [t.fieldTime, formatTime(entry.started_at, locale)],
    [t.fieldProtocol, entry.protocol],
    [t.fieldModel, entry.model || "—"],
    [t.fieldStatus, entry.status === "running" ? t.running : String(entry.status)],
    [t.fieldDuration, entry.duration_ms == null ? "—" : `${entry.duration_ms} ms`],
    [t.fieldTokens, formatTokens(entry.usage)],
    [t.fieldAccount, entry.key_hint || entry.account_id || "—"],
    [t.fieldRequest, entry.request_id],
    [t.fieldSession, entry.session_id || "—"],
    [t.fieldMethod, entry.method],
    [t.fieldPath, entry.path],
    [t.fieldStream, entry.stream == null ? "—" : entry.stream ? t.yes : t.no],
    [t.fieldProfile, entry.runtime_profile || "—"],
    [t.fieldErrorType, entry.error_type || "—"],
    [t.fieldError, entry.error || "—"],
  ];
  return (
    <dl className="detail-list">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className="mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function statusTone(status: RequestLogEntry["status"]): StatusTagTone {
  if (status === "running") return "progress";
  if (status >= 200 && status < 300) return "success";
  if (status >= 400) return "danger";
  return "neutral";
}

function formatTokens(usage?: RequestLogUsage): string {
  if (!usage) return "—";
  if (usage.usage_status === "deferred") return "~";
  if (usage.usage_status === "unavailable") return "—";
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  if (!input && !output) return "—";
  return `${input} / ${output}`;
}

function formatTime(startedAt: number, locale: "en" | "zh"): string {
  return new Date(startedAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US");
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-4)}` : value;
}
