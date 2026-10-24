import { useMemo, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import type { RepoTarget } from "@waterplane/shared";
import { branchLabel, repoBranchLabel } from "@waterplane/shared";
import { Empty } from "./Empty";
import { RowTitle, RowSub } from "./kit/Row";
import { Hint } from "./kit/Hint";

/**
 * **Which repo?** — asked once, in one place.
 *
 * Seven sheets asked it and seven sheets answered it differently: the backlog
 * with a `<select>`, the pad with a row list, the resend editor with a row list
 * that drew a different icon, the queue sheet with a copy of the resend
 * editor's, the fan-out with a checklist plus its own worktree filter, the
 * schedule editor with a second checklist plus a second worktree filter, the
 * archive with another `<select>`. Nothing in that is a bug on its own. What it
 * cost is the two rules that only some of them knew:
 *
 *  - **A note that already knows its repo says so.** A retired send carries the
 *    `cwd` its words were written against, and every picker was still asking a
 *    note that had already answered. `PadSheet` fixed that for itself; nothing
 *    else inherited it. So `home` sorts that repo FIRST and labels the row with
 *    why it is first — and never preselects it, because a note may legitimately
 *    be re-aimed and a picker that acts on its own is worse than one that
 *    guesses.
 *  - **A worktree is a repo you can pick, and usually not the one you mean.**
 *    Listing every worktree buries the eleven repos under thirty rows; hiding
 *    them means the parallel checkout this app exists to make cannot be
 *    targeted. So the list is primaries by default with a toggle — and a
 *    worktree that is already SELECTED stays visible and counted while the list
 *    is filtered, because hiding a row must never silently drop it from a run.
 *
 * Two exports, deliberately. `RepoPicker` is the row LIST (single or
 * multi-select) — a full-width target list, which is what a sheet uses when
 * picking the repo IS the screen. `RepoSelect` is the same rules in a
 * `<select>`, for a form where the repo is one field among several and a
 * thirty-row list would push everything else off the phone. Sharing the rules
 * and not the markup is the point: they cannot drift, and neither one is forced
 * into the other's shape.
 */

/** Primaries, plus any worktree that is currently picked (never hide a choice). */
export function visibleRepos(repos: RepoTarget[], withWorktrees: boolean, keep: readonly string[] = []): RepoTarget[] {
  if (withWorktrees) return repos;
  const keepSet = new Set(keep);
  return repos.filter((r) => r.isPrimary || keepSet.has(r.worktreePath));
}

/** `home` first, everything else in the order it arrived. */
export function orderRepos(repos: RepoTarget[], home?: string | null): RepoTarget[] {
  if (!home) return repos;
  const at = repos.findIndex((r) => r.worktreePath === home);
  if (at < 0) return repos;
  return [repos[at], ...repos.slice(0, at), ...repos.slice(at + 1)];
}

/** The title a repo row carries: its name, or its branch when it is a worktree. */
export const repoTitle = (r: RepoTarget) => (r.isPrimary ? r.repoName : r.branch);
/** The line under it — the other half of the same two facts, or nothing when
 *  the branch is the ordinary one (`shared/naming.ts`'s `branchLabel`). */
export const repoBranchLine = (r: RepoTarget) => (r.isPrimary ? (branchLabel(r) ?? "") : `worktree · ${r.repoName}`);
/** The `<option>` label: both facts on one line, since a select has one. */
export const repoOptionLabel = (r: RepoTarget) => repoBranchLabel(r);

/** Does this list hold anything the worktree toggle would reveal? */
const hasWorktrees = (repos: RepoTarget[]) => repos.some((r) => !r.isPrimary);

interface CommonProps {
  repos: RepoTarget[];
  /**
   * The repo these words already came from. Sorted first and LABELLED — marked,
   * never preselected.
   */
  home?: string | null;
  /** Offer the primaries-only filter. Off for a list that is already short. */
  worktreeFilter?: boolean;
  /** What to say when there is nothing to pick. */
  emptyText?: string;
}

interface PickerProps extends CommonProps {
  /** Multi-select: rows toggle, and the heading grows "all" / "none". */
  multi?: boolean;
  /** Multi only — the picked `worktreePath`s. */
  selected?: readonly string[];
  /** Multi only. */
  onChange?: (dirs: string[]) => void;
  /** Single only. Called with the repo, not the path: every caller wanted both. */
  onPick?: (repo: RepoTarget) => void;
  /** Single only — the row drawn as current, when the sheet tracks one. */
  value?: string | null;
  /** Drawn before the row title (the queue/resend lists mark a work item). */
  icon?: ReactNode;
  /** The sentence above the list ("Which repo's work items?"). */
  hint?: ReactNode;
  /** A section head with a label, the count and the controls. Omit for a bare list. */
  label?: string;
  /** Appended to the section head's count ("· a fresh session in each"). */
  countHint?: string;
  /** Extra words after the branch line — a per-repo item count, say. */
  note?: (r: RepoTarget) => string | undefined;
  /** Words BEFORE the branch line — "work item", where picking a repo rather
   *  than a session is what changes the kind of send. */
  subLead?: string;
  /** The class the list sits in. Sheets differ: `.pad-pick`, `.queue-aim`, `.list`. */
  listClass?: string;
}

export function RepoPicker({
  repos, home, worktreeFilter = true, emptyText = "No repos under host root.",
  multi, selected = [], onChange, onPick, value, icon, hint, label, countHint, note, subLead,
  listClass = "list",
}: PickerProps) {
  const [withWorktrees, setWithWorktrees] = useState(false);
  const offerFilter = worktreeFilter && hasWorktrees(repos);
  const ordered = useMemo(() => orderRepos(repos, home), [repos, home]);
  // Never filter away a row that is already an ANSWER: everything picked, the
  // current value, and the note's own repo. `home` is the one that bites — a
  // note written in a worktree would have had its own repo hidden by the
  // primaries-only default, which is the exact opposite of what `home` is for.
  const keep = useMemo(
    () => [...selected, home, value].filter((x): x is string => !!x),
    [selected, home, value],
  );
  const listed = useMemo(
    () => visibleRepos(ordered, !offerFilter || withWorktrees, keep),
    [ordered, offerFilter, withWorktrees, keep],
  );
  const sel = useMemo(() => new Set(selected), [selected]);

  const toggle = (r: RepoTarget) => {
    if (!multi) { onPick?.(r); return; }
    const next = new Set(sel);
    if (next.has(r.worktreePath)) next.delete(r.worktreePath); else next.add(r.worktreePath);
    onChange?.([...next]);
  };

  return (
    <>
      {hint && <Hint>{hint}</Hint>}
      {(label || offerFilter || multi) && (
        <div className="section section-head">
          {/* A single-select picker usually has a `hint` above it already, so
              its head is the worktree toggle alone — a second "Repos" line
              would be a heading for a list that just said what it is. */}
          <span>
            {label ?? (multi ? "Repos" : "")}
            {multi && <span className="section-hint"> · {sel.size} selected{countHint ? ` ${countHint}` : ""}</span>}
          </span>
          {/* `.head-acts`, not bare siblings: `.link-btn` is negative-margined,
              so three of them side by side render as one run-together word. */}
          <span className="head-acts">
            {multi && <button className="link-btn" onClick={() => onChange?.(listed.map((r) => r.worktreePath))}>all</button>}
            {multi && <button className="link-btn" onClick={() => onChange?.([])}>none</button>}
            {offerFilter && (
              <button className={`link-btn ${withWorktrees ? "active" : ""}`} onClick={() => setWithWorktrees((v) => !v)}>
                {withWorktrees ? "primaries only" : "worktrees"}
              </button>
            )}
          </span>
        </div>
      )}
      <div className={listClass}>
        {listed.map((r) => {
          const isHome = !!home && r.worktreePath === home;
          const on = multi ? sel.has(r.worktreePath) : value === r.worktreePath;
          const extra = note?.(r);
          return (
            <button
              key={r.id}
              className={`row${on ? " sched-on" : ""}${isHome ? " home" : ""}`}
              onClick={() => toggle(r)}
            >
              <RowTitle>
                {multi ? (on ? <Check size={14} /> : null) : icon}{" "}
                {repoTitle(r)}
              </RowTitle>
              <RowSub>
                {subLead ? `${subLead} · ` : ""}{repoBranchLine(r)}
                {/* Why this row is at the top. Said on the row rather than in a
                    legend: the ordering is only useful if it explains itself. */}
                {isHome ? " · where these words came from" : ""}
                {extra ? ` · ${extra}` : ""}
              </RowSub>
            </button>
          );
        })}
        {listed.length === 0 && <Empty>{emptyText}</Empty>}
      </div>
    </>
  );
}

interface SelectProps extends CommonProps {
  /** The chosen `worktreePath`. */
  value: string;
  onChange: (dir: string) => void;
  /** Extra words on the option ("· 4" for a repo's item count). */
  note?: (r: RepoTarget) => string | undefined;
  /**
   * A directory the caller must keep offerable even though it is not in
   * `repos` — a backlog item whose repo has since gone. Dropping it from the
   * options silently RE-AIMS the item at whatever sorts first.
   */
  keepValue?: boolean;
  /** Prepended blank option, for a field that starts unanswered. */
  placeholder?: string;
  /** The select's own classes, for a sheet whose row wants it to `grow`. */
  className?: string;
  "aria-label"?: string;
}

/**
 * `worktreeFilter` is OFF by default here and ON in `RepoPicker`, which is not
 * an inconsistency: a `<select>` IS a disclosure. Thirty options behind a
 * dropdown cost a scroll; thirty full-width rows cost the screen the rest of
 * the form was going to use. A sheet that wants the primaries-only default
 * (the secret writer) asks for it.
 */
export function RepoSelect({
  repos, home, worktreeFilter = false, value, onChange, note, keepValue, placeholder,
  className = "search", "aria-label": ariaLabel,
}: SelectProps) {
  const [withWorktrees, setWithWorktrees] = useState(false);
  const offerFilter = worktreeFilter && hasWorktrees(repos);
  const ordered = useMemo(() => orderRepos(repos, home), [repos, home]);
  // The current value is always listed, worktree or not — see `visibleRepos`.
  const listed = useMemo(
    () => visibleRepos(ordered, !offerFilter || withWorktrees, value ? [value] : []),
    [ordered, offerFilter, withWorktrees, value],
  );
  const orphan = keepValue && value && !repos.some((r) => r.worktreePath === value) ? value : null;

  return (
    <>
      <select className={className} value={value} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value)}>
        {placeholder && <option value="">{placeholder}</option>}
        {orphan && <option value={orphan}>{orphan.split(/[/\\]/).filter(Boolean).pop() || orphan} (gone)</option>}
        {listed.map((r) => (
          <option key={r.id} value={r.worktreePath}>
            {repoOptionLabel(r)}
            {home && r.worktreePath === home ? " · where these words came from" : ""}
            {note?.(r) ? ` · ${note(r)}` : ""}
          </option>
        ))}
      </select>
      {offerFilter && (
        <button className="linkish" onClick={() => setWithWorktrees((v) => !v)}>
          {withWorktrees ? "primaries only" : "show worktrees"}
        </button>
      )}
    </>
  );
}
