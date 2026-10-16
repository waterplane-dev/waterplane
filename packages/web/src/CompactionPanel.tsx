/**
 * The compaction panel, shared by the phone's context sheet and the VS Code extension's session view.
 * Imports are react-free pure shared words only — no api.ts / storage.ts / usage.ts, so a second shell can bundle it.
 */
import type { CompactionCost, CompactionLedger } from "@waterplane/shared";
import {
  compactionCostText, compactionCountText, compactionMethodText, compactionPendingText,
  compactionRatioText, compactionReading, compactionRowFacts, compactionRowLabel,
  compactionSavedText, compactionUnmeasuredText, compactionWindowText,
} from "@waterplane/shared";

/**
 * What compacting this conversation saved, and what it cost — in tokens and
 * in money.
 *
 * Two facts that live on the same screen for one reason: the context chart
 * already draws a tick at every compaction, and a tick is the one thing about
 * a compaction nobody has to be told. What it DID is the question, and it has
 * an answer the log can support — both sides of the drop are written down, and
 * every request after a boundary is a request that re-sent a smaller window.
 *
 * Split by trigger, because "was typing `/compact` worth it" is a different
 * question from "was the CLI right to compact when it did", and folded
 * together they cannot be told apart. A row is drawn only for a trigger that
 * actually ran: a `you typed /compact 0×` row is a control-shaped nothing.
 *
 * The SENTENCES are `shared/sessioncost.ts`'s. Nothing here derives a figure:
 * the arithmetic is the host's (`ctxlog.ts`, in the same pass that prices the
 * conversation) and the wording is shared's, so this screen cannot come to
 * disagree with a second surface that grows one later.
 */
export function CompactionPanel(
  { l, windowTok, tok }: { l: CompactionLedger; windowTok: number | null; tok: number | null },
) {
  const r = compactionReading(l);
  // Never compacted at all: nothing to draw. The values view already says "no
  // compactions in this conversation" beside the events, which is where an
  // absence belongs. A boundary the log could not describe still opens the
  // panel — its own sentence is the whole point of counting it.
  if (r.count <= 0 && r.unmeasured <= 0) return null;
  const count = compactionCountText(r);
  const saved = compactionSavedText(r) ?? compactionPendingText(r);
  const ratio = compactionRatioText(r);
  const cost = compactionCostText(r);
  const window = compactionWindowText(r, tok, windowTok);
  const unmeasured = compactionUnmeasuredText(r);
  const row = (kind: "auto" | "manual", c: CompactionCost) => c.count > 0 && (
    <div key={kind} className="row ctx-row ctx-val">
      <span className="row-title">{compactionRowLabel(kind, c.count)}</span>
      {/* Saved first: it is the bigger number and the one being asked about.
          Money beside each, never instead of it — the two sides are a cache
          read and a cache write, which differ by up to twenty times in price,
          so the token counts alone cannot be compared. A side with nothing in
          it is DROPPED by `compactionRowFacts`, never drawn as a zero. */}
      <span className="row-meta">
        {compactionRowFacts(c).map((f) => <span key={f} className="row-sub">{f}</span>)}
      </span>
    </div>
  );
  return (
    <>
      <div className="ctx-summary">What compacting saved</div>
      {count && <div className="empty ctx-note">{count}</div>}
      {row("manual", l.manual)}
      {row("auto", l.auto)}
      {/* The claim and its qualifier in one block: past the model's own window
          the figure is not what you would have paid, it is what those turns
          would have cost if they could have run at all — and a multiple read
          without that sentence beside it is a benchmark nobody can hit. */}
      {saved && <div className="empty ctx-note">{saved}{ratio ? ` ${ratio}` : ""}</div>}
      {window && <div className="empty ctx-note">{window}</div>}
      {cost && <div className="empty ctx-note">{cost}</div>}
      {/* HOW both figures were arrived at — the longest block on the panel and
          the one nobody reads twice, so it folds. Not deleted: it is the reason
          the ratio above can be trusted in the direction it will be used in
          (both estimates are biased against compacting looking worthwhile), and
          a reader who wants to argue with the number needs it. */}
      {(r.savedTok > 0 || r.rebuildTok > 0) && (
        <details className="hint-more ctx-method">
          <summary>how these two figures were arrived at</summary>
          <p>{compactionMethodText()}</p>
        </details>
      )}
      {unmeasured && <div className="empty ctx-note">{unmeasured}</div>}
    </>
  );
}
