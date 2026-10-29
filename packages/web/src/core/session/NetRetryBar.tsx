import { useEffect, useState, type ReactNode } from "react";
import { PlugZap, ToggleLeft, WifiOff, X } from "lucide-react";
import { NET_RETRY_NOW_NOTE, netRetryLine, type SessionNetRetry } from "@waterplane/shared";

/**
 * The desktop retrying a turn the CLI gave up on a transient API error
 * (`SessionInfo.netRetry`, host `sessions/apiretry.ts`, R-connection-024): one
 * line — "Network error — retrying in 40s (2/8)" — and the one verb that calls it
 * off. The wording is shared's `netRetryLine`, so the host's log and this line
 * say the same thing. The countdown ticks on the PHONE's clock, and only while a
 * retry is waiting.
 *
 * `cancel` while it is waiting or sent; `dismiss` once it gave up (both are the
 * same message). A dismissed gave-up line is only HIDDEN (`retry.dismissed`):
 * work waiting on the session stays stalled, keeps its note on its own row and
 * is never failed for the silence. Cancel on a stall probe stops the probing
 * and keeps the stall. `turn off` is the
 * host-wide switch (Settings › Sessions › retry on network errors), offered
 * only while a retry is still pending — it cancels this one and every other.
 * `retry now` once it gave up: `session.netRetryNow`, the same message as a
 * stalled backlog/Activity row's (`NetStalled.tsx`) — the ladder starts again
 * at try 1 and the host types `continue` its own way.
 */
export function NetRetryBar({ retry, onCancel, onTurnOff, onRetryNow }: { retry: SessionNetRetry; onCancel: () => void; onTurnOff?: () => void; onRetryNow?: () => void }): ReactNode {
  const [now, setNow] = useState(() => Date.now());
  const ticking = retry.nextAt != null && !retry.dismissed;
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  const line = netRetryLine(retry, now);
  if (!line || retry.dismissed) return null;
  const verb = retry.state === "gaveup" ? "dismiss" : "cancel";
  return (
    <div className="approve netretry" role="status">
      <div className="approve-opts">
        <span className="netretry-line">
          <WifiOff size={14} aria-hidden="true" /> {line}
        </span>
        {onRetryNow && retry.state === "gaveup" && (
          <button className="approve-btn" onClick={onRetryNow} title={NET_RETRY_NOW_NOTE}>
            <PlugZap size={14} aria-hidden="true" /> retry now
          </button>
        )}
        <button className="approve-btn" onClick={onCancel}
          title={retry.state === "gaveup" ? "hide this line — work waiting on this session stays stalled, with its note on its own row" : "stop the desktop retrying this turn — it types nothing"}>
          <X size={14} aria-hidden="true" /> {verb}
        </button>
        {onTurnOff && retry.state !== "gaveup" && (
          <button className="approve-btn" onClick={onTurnOff}
            title="stop the desktop retrying network errors in every session — Settings › Sessions brings it back">
            <ToggleLeft size={14} aria-hidden="true" /> turn off
          </button>
        )}
      </div>
      <div className="approve-hint">{retry.error}</div>
    </div>
  );
}
