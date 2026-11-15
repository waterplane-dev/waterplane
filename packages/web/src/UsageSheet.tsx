/**
 * Feature-usage viewer (Settings → feature usage).
 *
 * Shows the HOST-side aggregate (the host's ui-usage.json — all devices) so
 * you can see what you actually reach for and, more importantly, what you never
 * touch. `knownIds` is the catalog of instrumented features, so a feature with
 * ZERO uses still gets a row — that list is the point: it's the delete list.
 *
 * "copy report" yields a markdown summary to paste straight into a coding agent
 * ("remove everything under Never used").
 */
import { useState } from "react";
import { BarChart3, Copy, Loader2, RotateCcw } from "lucide-react";
import { BRAND, stateRel, type UiUsageDoc } from "@waterplane/shared";
import { fetchUsage, resetUsage } from "./usage";
import { copyText } from "./api";
import { ago } from "./format";
import { SheetHead } from "./Sheet";
import { useRemoteResource } from "./useRemoteResource";
import { Button } from "./kit/Button";
import { Row, RowTitle } from "./kit/Row";
import { Hint } from "./kit/Hint";
import { Empty } from "./Empty";
import { useOfflineGate } from "./kit/offlineGate";
import { StoreLossLine } from "./StoreLossLine";
import { lossHidesFigures, neverUsedHeading } from "./storeLoss";

const ICON = 16;

interface Props {
  /** Every instrumented feature id, so unused ones can be listed too. */
  knownIds: string[];
  onClose: () => void;
  /** Opens Settings › storage, where a lost record is listed and can be hidden. */
  onOpenStorage?: () => void;
  onToast: (text: string) => void;
}

export function UsageSheet({ knownIds, onClose, onToast, onOpenStorage }: Props) {
  const [armed, setArmed] = useState(false); // two-tap guard on reset
  // One host read, with its own loading/offline/error states — see
  // `useRemoteResource`. Cached like any host read: an aggregate across every device is
  // still true of the moment it was read, and it says how old it is (`Empty`).
  const usage = useRemoteResource<UiUsageDoc | null>("usage:ui-features", fetchUsage, { cache: { shape: 1 } });
  const gate = useOfflineGate();
  const doc = usage.data;
  const loading = usage.state === "loading";
  const load = () => usage.reload({ quiet: true });

  const features = doc?.features ?? {};
  // Catalog ∪ whatever the host has seen (ids from other clients / older builds).
  const ids = Array.from(new Set([...knownIds, ...Object.keys(features)]));
  const rows = ids
    .map((id) => ({ id, count: features[id]?.count ?? 0, last: features[id]?.last ?? 0 }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  const used = rows.filter((r) => r.count > 0);
  const unused = rows.filter((r) => r.count === 0);
  const total = used.reduce((n, r) => n + r.count, 0);

  function report() {
    const since = doc?.since ? new Date(doc.since).toISOString().slice(0, 10) : "?";
    const lines = [
      `# ${BRAND.name} feature usage (since ${since}, ${total} interactions)`,
      "",
      "## Used",
      ...used.map((r) => `- \`${r.id}\` — ${r.count}× (last ${r.last ? ago(r.last) : "never"})`),
      "",
      lossHidesFigures(doc?.loss) ? "## No count since the record was lost (not the same as never used)" : "## Never used",
      ...unused.map((r) => `- \`${r.id}\``),
    ];
    void copyText(lines.join("\n"));
    onToast("usage report copied");
  }

  return (
    <div className="sheet">
      <SheetHead title={"Feature usage"} onClose={onClose}>
        {usage.inflight && doc && <Loader2 size={13} className="spin" aria-label="refreshing" />}
      </SheetHead>
      {doc?.loss && <StoreLossLine loss={doc.loss} onOpenStorage={onOpenStorage} />}
      <div className="form">
        <Hint>
          <BarChart3 size={12} /> Counted on the host in <code>{stateRel("ui-usage.json")}</code> (all devices, never leaves this machine).
          {doc?.since ? ` Since ${new Date(doc.since).toLocaleDateString()}.` : ""} {total} interactions across {used.length} features.
        </Hint>
        <Row style={{ gap: 6 }}>
          <Button onClick={report}><Copy size={ICON} /> copy report</Button>
          <Button onClick={load}>refresh</Button>
          <div className="spacer" />
          <Button
            className={armed ? "danger" : ""}
            onClick={() => { if (!armed) { setArmed(true); return; } gate.guard("reset the counts", () => { void resetUsage().then(() => { setArmed(false); load(); }); })(); }}
          ><RotateCcw size={ICON} /> {armed ? "tap to confirm" : "reset"}</Button>
        </Row>
      </div>
      {loading && <Hint>loading…</Hint>}
      <Empty res={usage} empty={false} noun="usage report" />
      {gate.note}
      {/* "The host refused this" and "the host was not reachable" are different
          next actions, so they are different sentences — the rule the hook
          exists to keep. */}
      {usage.state === "offline" && <Hint>No connection — this is the host-side aggregate across every device, so and nothing was cached on this phone yet.</Hint>}
      {usage.state === "error" && <Hint style={{ color: "var(--dead)" }}>The host refused to report usage: {usage.error}</Hint>}
      <div className="list">
        {used.map((r) => (
          <Row key={r.id}>
            <RowTitle>{r.id}</RowTitle>
            <span className="muted" style={{ fontSize: 12 }}>{r.last ? ago(r.last) : "never"}</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{r.count}</span>
          </Row>
        ))}
        {neverUsedHeading(unused.length, doc?.loss) && <div className="section">{neverUsedHeading(unused.length, doc?.loss)}</div>}
        {unused.map((r) => (
          <Row key={r.id}>
            <RowTitle className="muted">{r.id}</RowTitle>
            <span className="muted">0</span>
          </Row>
        ))}
      </div>
    </div>
  );
}
