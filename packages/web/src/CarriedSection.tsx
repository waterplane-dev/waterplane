/**
 * "What every turn carries": what the first request of ONE conversation actually carried, as the
 * CLI logged it (`ContextSeriesDoc.carried`, read off the transcript's attachment records by the
 * host's ctxlog cursor).
 *
 * PURE presentational — no `api`, `link` or `storage` import — so VS Code's webview can import it
 * the way it imports `ContextGraph` (P6). Rules it holds (CLAUDE.md, skills `web-numbers`, `ux`):
 * - **Every word is shared's** (`carriedRows`, `carriedWords`), so the phone and VS Code say one
 *   sentence. Chars are the fact; tokens per part are `~chars/4` and always worded `~`/"about".
 * - **A total is never printed without its split**: the first request's tokens lead, every part
 *   follows with its own figure, and the unattributed remainder is a NAMED row, never hidden.
 * - **An absence stays in the open; method folds.** No `carried` (an older host, or a log whose start
 *   held no attachment record) is one sentence in plain view; only the long name lists fold into
 *   `details.hint-more`.
 * - `prompt_snapshot` is undocumented: its two parts carry "(undocumented record)" in the label.
 * - Resumed logs: the initial set wins, so the section says "measured on this log's first request".
 * - **The strip leads** (`carriedPlot.ts`, pure and node-tested): the first request as one bar, the
 *   parts largest first and the remainder its own neutral segment last; colour is a CLASS (logged ·
 *   undocumented, hatched · the rest), identity is a tap's readout line and the list under it, which
 *   follows the strip's order and wears the same scale as a meter per row.
 * - Instruction files print `~`-shortened with the CLI's type as a tag; three names or fewer sit
 *   inline, a longer list folds.
 */
import type { SessionCarried } from "@waterplane/shared";
import { carriedRows, carriedWords, fmtCount } from "@waterplane/shared";
import { useState, type PointerEvent } from "react";
import { Row, RowSub, RowTitle } from "./kit/Row";
import { Tag } from "./kit/Tag";
import { ScrubHint } from "./kit/chart/ScrubHint";
import {
  CLASS_WORDS, carriedLegend, carriedOrder, carriedReadout, carriedStrip, classOf, namesInline,
  scaleNote, segAt, tildePath, type CarriedStrip,
} from "./carriedPlot";

type Fmt = (n: number) => string;

/** The sentence drawn where the document came back without `carried`. */
export const CARRIED_ABSENT =
  "This desktop did not measure what the first request carried (an older host, or a log whose start held no attachment record).";

export function CarriedSection({ carried, fmt = fmtCount }: {
  /** `ContextSeriesDoc.carried`; undefined ⇒ the absence sentence, never an empty list. */
  carried: SessionCarried | undefined;
  fmt?: Fmt;
}) {
  return (
    <>
      <div className="ctx-chart-title">What every turn carries</div>
      {!carried ? <div className="empty ctx-note">{CARRIED_ABSENT}</div> : <CarriedBody carried={carried} fmt={fmt} />}
    </>
  );
}

function CarriedBody({ carried, fmt }: { carried: SessionCarried; fmt: Fmt }) {
  const [picked, setPicked] = useState<string | null>(null);
  const rows = carriedOrder(carriedRows(carried, fmt));
  const strip = carriedStrip(rows, carried.firstRequestTok);
  const counts = new Map(carried.parts.map((p) => [p.kind, p.count]));
  const pick = (key: string) => setPicked((k) => (k === key ? null : key));
  // The strip's caption says the parts overshoot the request; the lead then does not say it again.
  const unplacedShown = !!strip && strip.scale === "parts" && carried.firstRequestTok != null;
  return (
    <>
      <div className="ctx-summary">{carriedWords(carried, fmt, { unplacedShown })}</div>
      {strip && <CarriedBar strip={strip} picked={picked} onPick={setPicked} firstRequestTok={carried.firstRequestTok} fmt={fmt} />}
      <div className="empty ctx-note">
        Measured on this log's first request{carried.firstRequestAt != null ? ` (${new Date(carried.firstRequestAt).toLocaleString()})` : ""}, not on what a new session would carry today.
      </div>
      {rows.length > 0 && (
        <ul className="carried-list">
          {rows.map((r) => {
            const total = r.key === "remainder" ? undefined : counts.get(r.key);
            const capped = r.names && total != null && total > r.names.length;
            const seg = strip?.segs.find((s) => s.key === r.key);
            return (
              <li key={r.key} className={picked === r.key ? "carried-picked" : undefined}>
                <Row>
                  <div className="carried-pick" role="button" tabIndex={0} aria-pressed={picked === r.key}
                    title="read this part on the strip above"
                    onClick={() => pick(r.key)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(r.key); } }}>
                    <div className="carried-head">
                      <RowTitle className="carried-label">{r.label}</RowTitle>
                      <RowSub className="carried-num">{r.words}</RowSub>
                    </div>
                    {seg && (
                      <span className="carried-meter" aria-hidden>
                        <span className={`carried-fill carried-${classOf(r)}`} style={{ width: seg.w > 0 ? `max(1px, ${seg.w}%)` : 0 }} />
                      </span>
                    )}
                  </div>
                  {r.files && r.files.length > 0 && (
                    <ul className="carried-files">
                      {r.files.map((f, i) => (
                        <li key={`${i}:${f.label}`} className="carried-head">
                          <RowSub className="carried-label">
                            <span className="carried-path">{tildePath(f.path)}</span> <Tag className="carried-type">{f.type}</Tag>
                          </RowSub>
                          <RowSub className="carried-num">{f.words}</RowSub>
                        </li>
                      ))}
                    </ul>
                  )}
                  {r.names && r.names.length > 0 && (namesInline(r.names, total) ? (
                    <RowSub className="carried-inline">{r.names.join(", ")}</RowSub>
                  ) : (
                    <details className="hint-more carried-names">
                      <summary>
                        {capped ? `the first ${r.names.length} of ${total} names` : `the ${r.names.length} names`}
                      </summary>
                      <p>{r.names.join(", ")}</p>
                    </details>
                  ))}
                </Row>
              </li>
            );
          })}
        </ul>
      )}
      {!carried.parts.length && (
        <div className="empty ctx-note">The log holds no attachment records before the first request, so no part can be named.</div>
      )}
    </>
  );
}

/**
 * The first request as one strip. Positioned segments (as `KindBar`), so a 0.05% sliver keeps the
 * width the geometry gave it; a tap or drag reads the segment under the finger in the text line
 * beneath (the context sheet's grammar), a second tap on the same segment clears it. A mouse
 * also reads by hovering, and the line returns to the pick when it leaves.
 */
function CarriedBar({ strip, picked, onPick, firstRequestTok, fmt }: {
  strip: CarriedStrip;
  picked: string | null;
  onPick: (key: string | null) => void;
  firstRequestTok: number | null;
  fmt: Fmt;
}) {
  const at = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return box.width > 0 ? segAt(strip.segs, (e.clientX - box.left) / box.width) : null;
  };
  // A mouse reads by hovering (VS Code's webview, a desktop browser); the readout falls back to the
  // pick when the pointer leaves. Touch never hovers, so the phone's grammar is unchanged.
  const [hover, setHover] = useState<string | null>(null);
  const shown = hover ?? picked;
  const sel = strip.segs.find((s) => s.key === shown) ?? null;
  const note = scaleNote(strip, firstRequestTok, fmt);
  return (
    <div className="carried-comp">
      <div className="carried-bar" role="group"
        aria-label={`${strip.scale === "request" ? "what the first request was made of" : "what the parts were made of"}; the line under it reads the picked part`}
        onPointerDown={(e) => { const s = at(e); onPick(s && s.key === picked ? null : s?.key ?? null); if (e.pointerType === "mouse") setHover(null); }}
        onPointerMove={(e) => {
          if (e.buttons) { const s = at(e); if (s) onPick(s.key); if (e.pointerType === "mouse") setHover(null); }
          else if (e.pointerType === "mouse") setHover(at(e)?.key ?? null);
        }}
        onPointerLeave={(e) => { if (e.pointerType === "mouse") setHover(null); }}>
        {strip.segs.map((s) => (
          <span key={s.key} className={`carried-seg carried-${s.cls}${s.key === shown ? " carried-on" : ""}`}
            style={{ left: `${s.x}%`, width: `${s.w}%` }} />
        ))}
      </div>
      <div className="ctx-readout carried-readout">{sel ? carriedReadout(sel, strip) : <ScrubHint />}</div>
      <div className="ctx-legend carried-legend">
        {carriedLegend(strip).map((c) => (
          <span key={c}><i className={`carried-swatch carried-${c}`} aria-hidden />{CLASS_WORDS[c]}</span>
        ))}
      </div>
      {note && <div className="empty ctx-note">{note}</div>}
    </div>
  );
}
