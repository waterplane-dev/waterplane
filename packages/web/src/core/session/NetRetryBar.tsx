import { useEffect, useState, type ReactNode } from "react";
import { ToggleLeft, WifiOff, X } from "lucide-react";
import { netRetryLine, type SessionNetRetry } from "@waterplane/shared";

/**
 * The desktop retrying a turn the CLI gave up on a transient API error
 * (`SessionInfo.netRetry`, host `sessions/apiretry.ts`, R-connection-024): one
 * line — "Network error — retrying in 40s (2/8)" — and the one verb that calls it
 * off. The wording is shared's `netRetryLine`, so the host's log and this line
 * say the same thing. The countdown ticks on the PHONE's clock, and only while a
 * retry is waiting.
 *
 * `cancel` while it is waiting or sent; `dismiss` once it gave up (both are the
 * same message: the host drops the field and types nothing). `turn off` is the
 * host-wide switch (Settings › Sessions › retry on network errors), offered
 * only while a retry is still pending — it cancels this one and every other.
 */
export function NetRetryBar({ retry, onCancel, onTurnOff }: { retry: SessionNetRetry; onCancel: () => void; onTurnOff?: () => void }): ReactNode {
  const [now, setNow] = useState(() => Date.now());
  const ticking = retry.state === "waiting" && retry.nextAt != null;
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  const line = netRetryLine(retry, now);
  if (!line) return null;
  const verb = retry.state === "gaveup" ? "dismiss" : "cancel";
  return (
    <div className="approve netretry" role="status">
      <div className="approve-opts">
        <span className="netretry-line">
          <WifiOff size={14} aria-hidden="true" /> {line}
        </span>
        <button className="approve-btn" onClick={onCancel}
          title={retry.state === "gaveup" ? "hide this line" : "stop the desktop retrying this turn — it types nothing"}>
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
