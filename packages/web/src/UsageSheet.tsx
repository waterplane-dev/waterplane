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
import { BarChart3, Copy, RotateCcw } from "lucide-react";
import { BRAND, stateRel, type UiUsageDoc } from "@waterplane/shared";
import { fetchUsage, resetUsage } from "./usage";
import { copyText } from "./api";
import { ago } from "./format";
import { SheetHead } from "./Sheet";
import { useRemoteResource } from "./useRemoteResource";
import { Button } from "./kit/Button";
import { Row, RowTitle } from "./kit/Row";
import { Hint } from "./kit/Hint";

const ICON = 16;

interface Props {
  /** Every instrumented feature id, so unused ones can be listed too. */
  knownIds: string[];
  onClose: () => void;
  onToast: (text: string) => void;
}

export function UsageSheet({ knownIds, onClose, onToast }: Props) {
  const [armed, setArmed] = useState(false); // two-tap guard on reset
  // One host read, with its own loading/offline/error states — see
  // `useRemoteResource`. Not cached: this is an aggregate across every device,
  // and a stale copy of "what do I actually use" is worse than saying nothing.
  const usage = useRemoteResource<UiUsageDoc | null>("ui-usage", fetchUsage);
  const doc = usage.data;
  const loading = usage.state === "loading";
  const load = () => usage.reload();

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
      "## Never used",
      ...unused.map((r) => `- \`${r.id}\``),
    ];
    void copyText(lines.join("\n"));
    onToast("usage report copied");
  }

  return (
    <div className="sheet">
      <SheetHead title={"Feature usage"} onClose={onClose} />
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
            onClick={() => { if (!armed) { setArmed(true); return; } void resetUsage().then(() => { setArmed(false); load(); }); }}
          ><RotateCcw size={ICON} /> {armed ? "tap to confirm" : "reset"}</Button>
        </Row>
      </div>
      {loading && <Hint>loading…</Hint>}
      {/* "The host refused this" and "the host was not reachable" are different
          next actions, so they are different sentences — the rule the hook
          exists to keep. */}
      {usage.state === "offline" && <Hint>No connection — this is the host-side aggregate across every device, so there is nothing cached to show.</Hint>}
      {usage.state === "error" && <Hint style={{ color: "var(--dead)" }}>The host refused to report usage: {usage.error}</Hint>}
      <div className="list">
        {used.map((r) => (
          <Row key={r.id}>
            <RowTitle>{r.id}</RowTitle>
            <span className="muted" style={{ fontSize: 12 }}>{r.last ? ago(r.last) : "never"}</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{r.count}</span>
          </Row>
        ))}
        {unused.length > 0 && <div className="section">never used ({unused.length})</div>}
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
