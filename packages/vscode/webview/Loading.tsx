import { RefreshCw } from "lucide-react";

/**
 * "Still reading" — the sentence every view shows while its reading has not arrived. It is never an
 * `Absent`: absent means a reading came back with nothing (and says why); loading means none came back yet.
 * With `done`/`total` it is a determinate bar, above whatever (possibly older) figures follow it.
 */
export function Loading({ children, done, total }: { children: React.ReactNode; done?: number; total?: number }) {
  const bar = done != null && total != null && total > 0;
  return (
    <div className="empty loading" role={bar ? undefined : "status"}>
      <div className="loading-line">
        <RefreshCw size={14} className="spin" aria-hidden /> <span>{children}</span>
      </div>
      {bar && (
        <div className="loading-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.min(done, total)} aria-label="Log scan progress">
          <div className="loading-fill" style={{ width: `${Math.min(100, (done / total) * 100)}%` }} />
        </div>
      )}
    </div>
  );
}
