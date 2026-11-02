/**
 * The repo-level always-on list, under the Setup sheet's `context-weight` row: every file this repo
 * and this desktop put in front of the agent, one row each, with what it weighs every turn, when a
 * matching file is touched, and on demand.
 *
 * Rules it holds (CLAUDE.md, skills `web-numbers`, `web-work`, `ux`):
 * - **Every word is shared's** (`alwaysOnRows`, `alwaysOnTotalsWords`, `alwaysOnRowFigures`),
 *   so the phone and the VS Code Always-on view say the same sentence. Chars are the fact; tokens are
 *   `~chars/4` and always worded `~`.
 * - **The total never stands without its split** — the lead says what the threshold row counts and
 *   what is only listed beside it (D1: CLAUDE.local.md, subagent descriptions, MCP servers and this
 *   desktop's files are LISTED, never folded into the threshold). Said ONCE above the list; a row the
 *   threshold does not count wears a `Tag`, not a sentence of its own.
 * - **An unsized row (an MCP server) prints its sentence, never a 0.**
 * - **A count on a control is a filter**: `repo · N` / `desktop · N` come from ONE `bucket` call that
 *   also cuts the list (`kit/chips.ts` `chipRows`), and the chips sit ABOVE the rows.
 * - **Nothing applies itself**: this only reads and links. A repo row opens the file; a desktop row
 *   has no door (it lives outside the repo) and the hint says so once, never a greyed row.
 * - **Absent, never wrong**: an older host sends no `instructions`, a host whose read threw sends
 *   `why` — the list says which in a sentence and the context-weight row above stays the whole
 *   reading. An unreadable desktop has no chip (never `desktop · 0`). Desktop paths are worded by
 *   shared `desktopPathWords` against the host's real config dir (`doc.configDir`).
 * - **The strip** (`AlwaysOnStrip`, geometry in `alwaysOnPlot.ts`) sits under the chips and draws
 *   the SAME cut: one segment per file that reaches Claude on every turn, coloured by what the
 *   threshold does with it; an unsized row is a named outlined marker, never a length. A drag reads
 *   the file under the finger in a text line; a tap on the picked file clears it (ContextGraph's
 *   agent-lane grammar, the same as the carried strip).
 */
import { useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { BarChart3, Coins, FileText } from "lucide-react";
import { alwaysOnRowFigures, alwaysOnRows, alwaysOnTotalsWords, desktopPathWords, fmtCount } from "@waterplane/shared";
import type { AlwaysOnRow, InstructionFile, RepoInstructionsDoc } from "@waterplane/shared";
import { AO_BAND_NAME, AO_SLOT, aoBandFigure, aoHeadWords, aoLeftOutWords, aoMarkerFold, aoPick, aoPlot, aoSegWords } from "./alwaysOnPlot";
import type { AoPlot, AoScope, AoSeg } from "./alwaysOnPlot";
import { SLOT } from "./kit/chart/TokenComposition";
import { ScrubHint } from "./kit/chart/ScrubHint";
import { chipRows, toggleChip } from "./kit/chips";
import { FilterChip } from "./kit/FilterChip";
import { Row, RowSub, RowTitle } from "./kit/Row";
import { Tag } from "./kit/Tag";
import { Hint } from "./kit/Hint";
import { Button } from "./kit/Button";
import { Unavailable } from "./Unavailable";

type Scope = AlwaysOnRow["scope"];
/** The scope chips, in order; VS Code's Always-on view cuts by the same two. */
export const AO_SCOPES: readonly Scope[] = ["repo", "desktop"];
const SCOPES = AO_SCOPES;
// closed: keyed by this file's own scope list
const GROUP_HEAD: Record<Scope, string> = { repo: "In this repo", desktop: "On this desktop" };

/** A live session's door into what its own first request carried. */
export interface SessionDoor { id: string; title: string; open: () => void }

/** How many session doors are drawn before the rest are counted in a sentence. */
const DOORS_CAP = 3;

/**
 * The scope chips' ONE bucketing: the rows, the per-scope cut and the chip texts, from the same
 * call, so a chip's number and the list it cuts to cannot differ. VS Code's Always-on view uses it
 * too. An unreadable (or unread) desktop has no rows to count: its chip is left out rather than `desktop · 0`.
 */
export function aoScopeChips(doc: { files: InstructionFile[]; desktop?: InstructionFile[] | null }) {
  const rows = alwaysOnRows([...doc.files, ...(doc.desktop ?? [])]);
  const bucket = (s: Scope) => rows.filter((r) => r.scope === s);
  // `undefined` (VS Code before the desktop was read) is as unreadable as `null`: no chip.
  const chips = chipRows(SCOPES.filter((s) => s !== "desktop" || doc.desktop != null), (s) => ({ count: bucket(s).length }), (s) => s);
  return { rows, bucket, chips };
}

/**
 * Where the every-turn chars of the shown rows go, file by file; the chip cut decides which rows.
 * Exported for VS Code's Always-on view. A mouse also reads by hovering (the line returns to the
 * pick when it leaves); touch never hovers, so the phone's tap grammar is unchanged.
 */
export function AlwaysOnStrip({ files, scopes, configDir, pick: pickIn, onPick }: {
  files: InstructionFile[];
  scopes: readonly AoScope[];
  configDir?: string;
  /** The picked row, shared with `AoFileList` beside it (a row tap picks here); own state when absent. */
  pick?: string | null;
  onPick?: (key: string | null) => void;
}) {
  const p = aoPlot(files, scopes);
  const [pickOwn, setPickOwn] = useState<string | null>(null);
  const pick = onPick ? (pickIn ?? null) : pickOwn;
  const setPick = onPick ?? setPickOwn;
  const [hover, setHover] = useState<string | null>(null);
  const lit = hover ?? pick;
  const picked = p.segs.find((s) => s.key === lit) ?? null;
  const pathWords = (s: AoSeg) => (s.scope === "desktop" ? desktopPathWords(s.path, configDir) : s.path);
  const at = (e: ReactPointerEvent<HTMLDivElement>): string | null => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = r.width > 0 ? aoPick(p.segs, (e.clientX - r.left) / r.width) : null;
    return i != null ? p.segs[i].key : null;
  };
  const { shown, more } = aoMarkerFold(p.markers);
  const leftOut = aoLeftOutWords(p);
  if (!p.segs.length && !p.markers.length) return null;
  return (
    <div className="ao-strip">
      {/* The total is the lead sentence's; with segments drawn the legend's split is the head. */}
      {!p.segs.length && <div className="ao-strip-head">{aoHeadWords(p, fmtCount)}</div>}
      {p.segs.length > 0 && (
        <>
          {/* The carried strip's frame (`.carried-bar`/`.carried-seg`), so this and a session's
              "what every turn carries" are one bar; the hue is the threshold band, not ink. */}
          <div className="carried-bar" role="group" aria-label="where the every-turn characters go; the line under it reads the picked file"
            onPointerDown={(e) => { const k = at(e); const clear = k != null && k === pick; setPick(clear ? null : k); if (e.pointerType === "mouse") setHover(null); }}
            onPointerMove={(e) => {
              if (e.buttons) { const k = at(e); if (k != null) setPick(k); if (e.pointerType === "mouse") setHover(null); }
              else if (e.pointerType === "mouse") setHover(at(e));
            }}
            onPointerLeave={(e) => { if (e.pointerType === "mouse") setHover(null); }}>
            {p.segs.map((s) => (
              <span key={s.key} className={`carried-seg${s.key === lit ? " carried-on" : ""}`}
                style={{ left: `${s.x}%`, width: `${s.w}%`, background: SLOT[AO_SLOT[s.band]] }} />
            ))}
          </div>
          <div className="ctx-readout carried-readout">{picked ? aoSegWords(picked, p.total, pathWords, fmtCount) : <ScrubHint />}</div>
          <div className="ts-legend">
            {p.bands.map((b) => (
              <span key={b.band} className="ts-leg">
                <i style={{ background: SLOT[AO_SLOT[b.band]] }} />
                <b>{AO_BAND_NAME[b.band]}</b> {aoBandFigure(b, fmtCount)}
                <em>{b.files} {b.files === 1 ? "file" : "files"}</em>
              </span>
            ))}
          </div>
        </>
      )}
      {shown.length > 0 && (
        <div className="ao-marks" aria-label="rows with no size">
          <span className="ao-marks-lead">no size:</span>
          {shown.map((m) => <span key={m.key} className="ao-mark">{m.kind}</span>)}
          {more > 0 && <span className="ao-marks-lead">+{more} more</span>}
        </div>
      )}
      {leftOut && <div className="ao-strip-note">{leftOut}</div>}
    </div>
  );
}

/**
 * One scope's rows, drawn as a session's "what every turn carries" list (`CarriedSection`'s
 * `.carried-*` row: label left, figure right, a meter on the strip's scale), so the repo's file list,
 * this desktop's and VS Code's Always-on view read as one screen. Every word is shared's
 * (`alwaysOnRowFigures`). The rows follow the strip's order (largest first inside a band); a row the
 * strip does not draw (unsized, or nothing every turn) follows without a meter. A row's head picks
 * its segment on the strip (`pick`/`onPick`, shared with `AlwaysOnStrip`); a repo row opens its file
 * by its own `open` verb, a desktop row lives outside the repo and has none.
 */
export function AoFileList({ rows, plot, configDir, onOpen, pick = null, onPick }: {
  rows: AlwaysOnRow[];
  /** `aoPlot` over the same files and scopes as the strip above, for the meters and the order. */
  plot: AoPlot;
  configDir?: string;
  onOpen?: (path: string) => void;
  pick?: string | null;
  onPick?: (key: string | null) => void;
}) {
  const keyOf = (r: AlwaysOnRow) => `${r.scope}:${r.path}:${r.kind}`;
  const at = new Map(plot.segs.map((g, i) => [g.key, i]));
  const sorted = rows.map((r, i) => ({ r, i, o: at.get(keyOf(r)) ?? Infinity })).sort((x, y) => x.o - y.o || x.i - y.i).map((x) => x.r);
  const toggle = (k: string) => onPick?.(pick === k ? null : k);
  return (
    <ul className="carried-list ao-list">
      {sorted.map((r) => {
        const key = keyOf(r);
        const seg = plot.segs.find((g) => g.key === key);
        const fig = alwaysOnRowFigures(r, fmtCount);
        const path = r.scope === "desktop" ? desktopPathWords(r.path, configDir) : r.path;
        const who = [r.readers.length > 0 && !r.unsized ? `read by ${r.readers.join(", ")}` : null, r.off ?? null].filter(Boolean).join(" · ");
        const listedOnly = r.scope === "repo" && !r.counted && !r.unsized && r.readers.includes("claude");
        const head = (
          <>
            <div className="carried-head">
              <RowTitle className="carried-label">
                <span className="carried-path">{path}</span> <Tag className="carried-type">{r.kind}</Tag>
              </RowTitle>
              {fig.num && <RowSub className="carried-num">{fig.num}</RowSub>}
            </div>
            {seg && (
              <span className="carried-meter" aria-hidden>
                <span className="carried-fill" style={{ width: `max(1px, ${seg.w}%)`, background: SLOT[AO_SLOT[seg.band]] }} />
              </span>
            )}
          </>
        );
        return (
          <li key={key} className={seg && pick === key ? "carried-picked" : undefined}>
            <Row>
              {seg && onPick ? (
                <div className="carried-pick" role="button" tabIndex={0} aria-pressed={pick === key}
                  title="read this file on the strip above" onClick={() => toggle(key)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(key); } }}>
                  {head}
                </div>
              ) : <div className="carried-pick ao-still">{head}</div>}
              {(who || listedOnly) && (
                <RowSub as="div">{who}{listedOnly && <>{who ? " " : ""}<Tag>not under the threshold</Tag></>}</RowSub>
              )}
              {fig.rest && <RowSub as="div" className={r.unsized ? "ao-unsized" : undefined}>{fig.rest}</RowSub>}
              {onOpen && (
                // Raw link-btn, not kit `Button`: a text verb inside a list row, the way
                // `CarriedSection`'s name folds sit in theirs, not a boxed control.
                <button type="button" className="link-btn ao-open" onClick={() => onOpen(r.path)}>
                  <FileText size={12} /> open
                </button>
              )}
            </Row>
          </li>
        );
      })}
    </ul>
  );
}

export function AlwaysOnRows({ doc, repoId, onOpenFile, sessionDoors, onAllSessions }: {
  /** `ComplianceReport.instructions`; absent from an older host. */
  doc: RepoInstructionsDoc | undefined;
  repoId: string;
  /** Opens a repo-relative file in the viewer. Desktop rows never get it. */
  onOpenFile?: (repoId: string, relPath: string) => void;
  /** This repo's live sessions, each opening its own context sheet (what its turns carry).
   *  Absent = the caller has no session doors (no sentence either); `[]` = none live, said so. */
  sessionDoors?: SessionDoor[];
  /** The all-sessions token screen. */
  onAllSessions?: () => void;
}) {
  const [cut, setCut] = useState<Scope | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const doors = sessionDoors ?? [];
  const doorRow = (onAllSessions || sessionDoors) ? (
    <>
      <div className="sheet-actions ao-doors">
        {doors.slice(0, DOORS_CAP).map((d) => (
          <Button key={d.id} title={`Open the context sheet of ${d.title}: what its first request actually carried`}
            onClick={d.open}>
            <BarChart3 size={12} /> what {d.title} carries →
          </Button>
        ))}
        {onAllSessions && (
          <Button title="Every conversation on this desktop, with its token split"
            onClick={onAllSessions}>
            <Coins size={12} /> all sessions
          </Button>
        )}
      </div>
      {doors.length > DOORS_CAP && (
        <Hint>{`+${doors.length - DOORS_CAP} more live in this repo — open them from the launcher.`}</Hint>
      )}
      {sessionDoors && !doors.length && (
        <Unavailable cants={[{ label: "session view", reason: "no live session in this repo — open one to see what its turns carry" }]} />
      )}
    </>
  ) : null;

  if (!doc || doc.why) {
    return (
      <div className="ao-rows">
        <Hint>{doc?.why
          ? `${doc.why}; the sentence above is the whole reading.`
          : "This desktop did not send the per-file list (an older host); the sentence above is the whole reading."}</Hint>
        {doorRow}
      </div>
    );
  }

  const lead = alwaysOnTotalsWords([...doc.files, ...(doc.desktop ?? [])], fmtCount);
  // ONE bucketing function feeds the chip numbers AND the cut below.
  const { rows, bucket, chips } = aoScopeChips(doc);
  const shown = cut ? [cut] : SCOPES;
  const all = [...doc.files, ...(doc.desktop ?? [])];
  // ONE plot for the strip's segments and the rows' meters and order.
  const plot = aoPlot(all, shown);
  const listedOnly = rows.some((r) => r.scope === "repo" && !r.counted && !r.unsized && r.readers.includes("claude"));

  return (
    <div className="ao-rows">
      {lead && <div className="check-detail">{lead}</div>}
      <div className="ts-filter" role="group" aria-label="which files">
        {chips.map((c) => (
          <FilterChip key={c.key} on={cut === c.key} onClick={() => setCut(toggleChip(cut, c.key))}
            title={`Only the files ${c.key === "repo" ? "this repo" : "this desktop"} adds`}>
            {c.text}
          </FilterChip>
        ))}
      </div>
      {cut && <Hint>{`${bucket(cut).length} of ${rows.length} rows — tap the lit chip to show all.`}</Hint>}
      <AlwaysOnStrip files={all} scopes={shown} configDir={doc.configDir} pick={pick} onPick={setPick} />
      {listedOnly && (!cut || cut === "repo") && (
        <Hint>Rows tagged “not under the threshold” are listed beside the threshold row, not counted by it.</Hint>
      )}
      {shown.map((s) => {
        const list = bucket(s);
        if (s === "desktop" && doc.desktop === null) {
          return (
            <div key={s} className="ao-group">
              <div className="ao-group-head">{GROUP_HEAD[s]}</div>
              <Hint>{doc.desktopWhy ?? "This desktop's own files could not be read."}</Hint>
            </div>
          );
        }
        if (!list.length) return null;
        return (
          <div key={s} className="ao-group">
            <div className="ao-group-head">{GROUP_HEAD[s]}</div>
            {s === "desktop" && (
              <Hint>These live outside the repo, so they do not open from here. They are what this desktop's files show; plugin packs synced from claude.ai are not on disk — a session's own sheet (below) lists the skills it actually carried.</Hint>
            )}
            <AoFileList rows={list} plot={plot} configDir={doc.configDir} pick={pick} onPick={setPick}
              onOpen={s === "repo" && onOpenFile ? (p) => onOpenFile(repoId, p) : undefined} />
          </div>
        );
      })}
      {doorRow}
    </div>
  );
}
