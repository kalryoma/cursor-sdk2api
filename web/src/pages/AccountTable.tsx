import { Button } from "../bflabs/Button";
import { catalogHasFable5 } from "../fable5";
import { hrefFor } from "../nav";
import { formatCursorReset, formatGrokBotQuota, formatGrokBotReset, formatQuota, formatQuotaBreakdown } from "../quota";
import { identityLabel, type RosterItem } from "../roster";
import { ActionLink } from "./shared";

export function AccountTable({
  items,
  quotaMissing,
  grokBotQuota,
  grokBotMissing,
  resetPrefix,
  fableOn,
  fableOff,
  fableUnknown,
  testing,
  test,
  testFail,
  open,
  remove,
  pause,
  resume,
  paused,
  headers,
  onTest,
  onRemove,
  onTogglePaused,
}: {
  items: RosterItem[];
  quotaMissing: string;
  grokBotQuota: string;
  grokBotMissing: string;
  resetPrefix: string;
  fableOn: string;
  fableOff: string;
  fableUnknown: string;
  testing: string;
  test: string;
  testFail: string;
  open: string;
  remove?: string;
  pause?: string;
  resume?: string;
  paused?: string;
  headers: [string, string, string, string];
  onTest: (id: string) => void;
  onRemove?: (id: string) => void;
  onTogglePaused?: (id: string) => void;
}) {
  return (
    <div className="table-wrap">
      <table className="grid-table">
        <thead>
          <tr>
            {headers.map((label) => <th key={label}>{label}</th>)}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const quota = formatQuota(item.account);
            const quotaBreakdown = formatQuotaBreakdown(item.account);
            const cursorReset = formatCursorReset(item.account, resetPrefix);
            const grokQuota = formatGrokBotQuota(item.account);
            const grokReset = formatGrokBotReset(item.account, resetPrefix);
            const fable = item.models ? (catalogHasFable5(item.models) ? fableOn : fableOff) : fableUnknown;
            const probe =
              item.testState === "testing"
                ? testing
                : item.testState === "pass"
                  ? `${item.testMs ?? 0} ms`
                  : item.testState === "fail"
                    ? item.testError || testFail
                    : "—";
            return (
              <tr key={item.id}>
                <td>
                  <a className="row-link" href={hrefFor("account", item.id)}>
                    <strong>{identityLabel(item.account, item.keyHint)}</strong>
                    <span className="sub">{item.account?.identity?.api_key_name || item.keyHint}</span>
                    {item.paused && paused ? <span className="sub">{paused}</span> : null}
                  </a>
                </td>
                <td>
                  <span>{quota || quotaMissing}</span>
                  {quotaBreakdown ? <span className="sub quota-breakdown">{quotaBreakdown}</span> : null}
                  {cursorReset ? <span className="sub quota-breakdown">{cursorReset}</span> : null}
                  <span className="sub quota-breakdown">{grokBotQuota} {grokQuota || grokBotMissing}</span>
                  {grokReset ? <span className="sub quota-breakdown">{grokReset}</span> : null}
                </td>
                <td>{fable}</td>
                <td>{probe}</td>
                <td className="row-actions">
                  <div className="row-action-group">
                    <Button variant="secondary" size="sm" disabled={item.testState === "testing"} onClick={() => onTest(item.id)}>
                      {item.testState === "testing" ? testing : test}
                    </Button>
                    <ActionLink href={hrefFor("account", item.id)}>{open}</ActionLink>
                    {onTogglePaused && pause && resume ? (
                      <Button variant="secondary" size="sm" onClick={() => onTogglePaused(item.id)}>
                        {item.paused ? resume : pause}
                      </Button>
                    ) : null}
                    {onRemove && remove ? (
                      <Button variant="quiet" size="sm" onClick={() => onRemove(item.id)}>{remove}</Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
