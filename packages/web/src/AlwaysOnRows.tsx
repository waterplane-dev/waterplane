/**
 * The repo-level always-on list, under the Setup sheet's `context-weight` row: every file this repo
 * and this desktop put in front of the agent, one row each, with what it weighs every turn, when a
 * matching file is touched, and on demand.
 *
 * Rules it holds (CLAUDE.md, skills `web-numbers`, `web-work`, `ux`):
 * - **Every word is shared's** (`alwaysOnRows`, `alwaysOnTotalsWords`, `instructionFileWeightWords`),
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
import { alwaysOnRows, alwaysOnTotalsWords, desktopPathWords, fmtCount, instructionFileWeightWords } from "@waterplane/shared";
import type { AlwaysOnRow, InstructionFile, RepoInstructionsDoc } from "@waterplane/shared";
import { AO_BAND_NAME, AO_SLOT, aoBandFigure, aoHeadWords, aoLeftOutWords, aoMarkerFold, aoPick, aoPlot, aoSegWords } from "./alwaysOnPlot";
import type { AoScope, AoSeg } from "./alwaysOnPlot";
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

/** The weight words for one row: shared's sentence for a sized row, the reason for an unsized one. */
function weightWords(r: AlwaysOnRow): string {
  if (r.unsized) return r.unsized;
  const always = r.always ?? 0, scoped = r.scoped ?? 0, onDemand = r.onDemand ?? 0;
  return instructionFileWeightWords({ kind: r.kind, chars: always + scoped + onDemand, always, scoped, onDemand }, fmtCount);
}


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
export function AlwaysOnStrip({ files, scopes, configDir }: { files: InstructionFile[]; scopes: readonly AoScope[]; configDir?: string }) {
  const p = aoPlot(files, scopes);
  const [pick, setPick] = useState<string | null>(null);
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
          <div className="ts-bar ao-bar" role="group" aria-label="where the every-turn characters go; the line under it reads the picked file"
            onPointerDown={(e) => { const k = at(e); const clear = k != null && k === pick; setPick(clear ? null : k); if (e.pointerType === "mouse") setHover(null); }}
            onPointerMove={(e) => {
              if (e.buttons) { const k = at(e); if (k != null) setPick(k); if (e.pointerType === "mouse") setHover(null); }
              else if (e.pointerType === "mouse") setHover(at(e));
            }}
            onPointerLeave={(e) => { if (e.pointerType === "mouse") setHover(null); }}>
            {p.segs.map((s) => (
              <span key={s.key} className={`ts-seg${s.seam ? " ao-seam" : ""}${s.key === lit ? " ao-on" : ""}`}
                style={{ left: `${s.x}%`, width: `${s.w}%`, background: SLOT[AO_SLOT[s.band]] }} />
            ))}
          </div>
          <div className="ao-readout">{picked ? aoSegWords(picked, p.total, pathWords, fmtCount) : <ScrubHint />}</div>
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
      <AlwaysOnStrip files={[...doc.files, ...(doc.desktop ?? [])]} scopes={shown} configDir={doc.configDir} />
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
            <ul className="ao-list">
              {list.map((r) => {
                const path = s === "desktop" ? desktopPathWords(r.path, doc.configDir) : r.path;
                const body = (
                  <>
                    <RowTitle className="ao-row-path">
                      {s === "repo" && onOpenFile && <FileText size={12} />} {path}
                    </RowTitle>
                    <RowSub as="div">
                      {r.kind}
                      {r.readers.length > 0 && !r.unsized ? ` · read by ${r.readers.join(", ")}` : ""}
                      {r.off ? ` · ${r.off}` : ""}
                      {s === "repo" && !r.counted && !r.unsized && r.readers.includes("claude") && (
                        <> <Tag>not under the threshold</Tag></>
                      )}
                    </RowSub>
                    <RowSub as="div" className={r.unsized ? "ao-unsized" : undefined}>{weightWords(r)}</RowSub>
                  </>
                );
                return (
                  <li key={`${s}:${r.path}:${r.kind}`}>
                    {s === "repo" && onOpenFile
                      ? <Row as="button" onClick={() => onOpenFile(repoId, r.path)}>{body}</Row>
                      : <Row>{body}</Row>}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {doorRow}
    </div>
  );
}
