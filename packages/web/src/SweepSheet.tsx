/**
 * Clearing out a transport directory, as a decision a person makes once.
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 *
 * `.claude/outbox/` and `.claude/inbox/` accumulate for ever — nothing in this
 * app has ever removed anything from either. Measured across fourteen repos on
 * this desktop: 6.8 GB, 4.0 GB of it in ONE repo's outbox across 31 files, and
 * a 523-file inbox in another. The gallery's per-file delete has existed the
 * whole time and is the wrong instrument at that size.
 *
 * ── The four rules it is built out of ───────────────────────────────────────
 *
 *  - **Nothing applies itself** (CLAUDE.md). This sheet never deletes on open,
 *    on a timer, or on an age crossing. It plans, it says what the plan is, and
 *    a person taps twice. There is deliberately no "clean up automatically"
 *    switch: these directories hold the only copy of things nobody committed.
 *  - **A count on a control is a FILTER** (CLAUDE.md). The chip reading
 *    "27 · 3.9 GB" opens exactly those 27 rows — same predicate, `planSweep`,
 *    that produced the number (`shared/sweep.ts`). A second copy of the edge is
 *    how a badge becomes a liar.
 *  - **A count is not the decision; bytes are.** Every number here carries its
 *    byte total, because "27 of 31 files" reads as "most of the directory" when
 *    the fact that matters is that those 27 are 97% of its size.
 *  - **The list is the contract.** `onRun` sends the exact `relPath`s on
 *    screen, never the age — the host re-derives nothing (`files.ts
 *    sweepTransport`). A set re-cut on the desktop is a set nobody approved.
 *
 * ── The one thing that is NOT symmetric ─────────────────────────────────────
 *
 * Outbox and inbox are separate scopes and are never swept together. The outbox
 * is what an agent WROTE — re-derivable by running the thing again. The inbox is
 * what a phone UPLOADED, and may be the only copy of a photo. Offering "both"
 * would be offering one tap that destroys two very different kinds of thing.
 *
 * ── The second ladder: superseded builds ────────────────────────────────────
 *
 * An age is the right question for a transport directory in general and the
 * wrong one for what actually fills it. Measured here: 33 of picture-app's 38
 * outbox files are APKs across 13 build families; Tiptoi holds one family of
 * 72. "Older than 30 days" catches those and catches them BLINDLY — some of the
 * files it selects are the newest copy of a variant nothing has rebuilt since.
 *
 * So there is a second chip row (`shared/sweepfamilies.ts`), and three things
 * about it are deliberate:
 *
 *  - **Outbox only.** An inbox holds photos whose names are all-variable, so
 *    `familyKey` falls back to the exact path and nothing supersedes anything.
 *    A control that can only ever select nothing is worse than no control.
 *  - **Mutually exclusive with the age chips**, never combined. Two predicates
 *    feeding one number is two copies of the edge — the thing "a count on a
 *    control is a filter" exists to forbid.
 *  - **The family COUNT is said beside the file count.** "14 of 38" could be
 *    one family of 38 or nineteen families of two, and those are completely
 *    different decisions.
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import {
  FAMILY_KEEPS, FAMILY_KEEP_LABEL, SWEEP_AGES, SWEEP_AGE_LABEL, SWEEP_SCOPE_LABEL,
  familyButtonText, familyCount, familyCounts, familyKeepText, fmtBytes, planFamilySweep,
  planSweep, sweepCounts, tally, sweepButtonText, sweepKeepText, sweepResultText,
  type FamilyKeep, type SweepAge, type SweepPlan, type SweepResult, type SweepScope, type SweepTally,
} from "@waterplane/shared";
import { api, type FileEntry } from "./api";
import { SheetHead, ConfirmButton, Unavailable, FilterBar, CountChips, Button, Hint } from "./kit";
import { ago } from "./format";

interface Props {
  repoId: string;
  /** For the sentence at the top — a path is not a name. */
  repoName: string;
  /** Which transport directory. The caller opens the one you were looking at. */
  scope: SweepScope;
  onScope: (s: SweepScope) => void;
  /** Told so the gallery behind this can re-read its listing. */
  onDone: (r: SweepResult) => void;
  onClose: () => void;
}

type Plan = { rows: FileEntry[]; total: SweepTally; counts: Record<SweepAge, SweepTally> };

export function SweepSheet({ repoId, repoName, scope, onScope, onDone, onClose }: Props) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [age, setAge] = useState<SweepAge | null>(null);
  /** The other ladder. Never set at the same time as `age` — see the module
   *  note; the two setters below are the whole enforcement. */
  const [keep, setKeep] = useState<FamilyKeep | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SweepResult | null>(null);
  // `now` is frozen for the life of one plan, deliberately. A ticking clock
  // would move a row across the cut between the tap that selected it and the
  // tap that confirms it — the number on screen must describe the list on
  // screen for as long as it is on screen.
  const [now, setNow] = useState(() => Date.now());

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const d = await api.sweepPlan(repoId, scope);
      // **One clock for the number and for the cut.** The host also answers
      // `counts` and `total`, computed against ITS clock at serve time — and
      // `planSweep` below runs against the phone's, frozen. Sharing the
      // predicate but not the instant re-creates the two copies of the edge
      // CLAUDE.md's rule exists to forbid: clock skew or plain round-trip
      // latency puts a boundary file on different sides, so the chip says 27
      // and the tap opens 28. Both are derived here, from the rows, at one
      // instant; the host's own tallies are deliberately ignored.
      const at = Date.now();
      setPlan({ rows: d.rows, total: tally(d.rows), counts: sweepCounts(d.rows, at) });
      setNow(at);
    } catch {
      // Names the desktop rather than saying "empty": a transport directory the
      // phone cannot read is not a transport directory with nothing in it, and
      // this is the screen where that difference decides whether you tap.
      setError("Couldn’t read this repo’s files — the desktop didn’t answer.");
      setPlan(null);
    } finally {
      setLoading(false);
    }
  }

  // Re-read on every scope change, and drop the selection with it: an age
  // chosen against the outbox says nothing about the inbox, and carrying it
  // across would pre-arm a destructive control over rows nobody has looked at.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read on scope change only; `load` is a per-render closure
  useEffect(() => { setAge(null); setKeep(null); setResult(null); void load(); }, [repoId, scope]);

  /** Picking one ladder drops the other. Not two independent filters that
   *  happen not to combine — one selection, expressible two ways. */
  const pickAge = (a: SweepAge | null) => { setAge(a); setKeep(null); };
  const pickKeep = (k: FamilyKeep | null) => { setKeep(k); setAge(null); };

  const cut: SweepPlan | null = useMemo(() => {
    if (!plan) return null;
    if (age) return planSweep(plan.rows, age, now);
    if (keep) return planFamilySweep(plan.rows, keep);
    return null;
  }, [plan, age, keep, now]);

  // The family ladder is drawn on the outbox only, and its numbers come from
  // the same function the chip's tap uses.
  const families = useMemo(
    () => (plan && scope === "outbox" ? { counts: familyCounts(plan.rows), n: familyCount(plan.rows) } : null),
    [plan, scope],
  );

  async function run() {
    if (!cut || !cut.rows.length) return;
    setBusy(true);
    try {
      const paths = cut.rows.map((r) => r.relPath);
      const r = await api.sweepRun(repoId, paths);
      if (r.error) { setError(r.error); return; }
      const res: SweepResult = { deleted: r.deleted, bytes: r.bytes, missing: r.missing ?? [], failed: r.failed ?? [] };
      setResult(res);
      onDone(res);
      // Re-read rather than filtering the rows out locally: what the directory
      // holds now is the host's fact, and a list this screen edited by hand
      // would disagree with it the moment anything failed.
      setAge(null);
      setKeep(null);
      await load();
    } catch {
      setError("The sweep didn’t reach the desktop. Nothing here says whether it ran — re-open this sheet to see what is still there.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet">
      <SheetHead title="Clear out old files" onClose={onClose}>
        {loading && <Loader2 size={13} className="spin" />}
      </SheetHead>

      <Hint>
        {repoName} · {SWEEP_SCOPE_LABEL[scope]}. Pick how far back, look at what it would delete,
        then confirm. Nothing goes until you do.
      </Hint>

      {/* Which direction. Two chips and never a "both": see the module note. */}
      <div className="annot-tools">
        {(["outbox", "inbox"] as const).map((s) => (
          <Button key={s} className={scope === s ? "active" : ""} onClick={() => onScope(s)}>{s}</Button>
        ))}
        <Button onClick={() => void load()}><RefreshCw size={14} /> re-read</Button>
      </div>

      {error && <Hint tone="warn">{error}</Hint>}

      {/* The age ladder. Each chip is a COUNT and its BYTES, and tapping one
          opens exactly those rows — the number and the cut are one function. A
          bucket with nothing in it is still drawn, because "nothing here is
          older than a year" is an answer and a missing chip is not. */}
      {plan && (
        <CountChips className="annot-tools sweep-ages" keys={SWEEP_AGES} active={age} onPick={pickAge}
          label={(a) => SWEEP_AGE_LABEL[a]}
          bucket={(a) => ({ count: plan.counts[a].count, detail: fmtBytes(plan.counts[a].bytes) })} />
      )}

      {/* The second ladder — outbox only. Same rule as the age chips: the
          number and the cut are one function (`familyCounts` calls
          `planFamilySweep`), and an empty bucket is still a chip because
          "nothing here is superseded" is an answer. */}
      {plan && families && (
        <>
          <CountChips className="annot-tools sweep-ages" keys={FAMILY_KEEPS} active={keep} onPick={pickKeep}
            label={(k) => FAMILY_KEEP_LABEL[k]}
            bucket={(k) => ({ count: families.counts[k].count, detail: fmtBytes(families.counts[k].bytes) })} />
          {/* What a family IS, in one line — without it the chips above read as
              a second age ladder with strange numbers. */}
          <Hint>
            A build family is the same artifact across builds — the version, the hash and the build
            number vary, everything else is its name. {families.n} {families.n === 1 ? "family" : "families"} here.
          </Hint>
        </>
      )}

      {plan && !cut && (
        <Hint>
          {plan.total.count
            ? <>{plan.total.count} file{plan.total.count === 1 ? "" : "s"} here, {fmtBytes(plan.total.bytes)} in all. Pick a cut above to see what would go.</>
            : <>Nothing in this repo’s {scope}.</>}
        </Hint>
      )}

      {/* The filtered view SAYS what it is hiding — n of N against the
          unfiltered list — and carries its own way out (CLAUDE.md). */}
      {cut && (
        <FilterBar onClear={() => { setAge(null); setKeep(null); }}>
          {cut.count} of {plan!.total.count} files · {fmtBytes(cut.bytes)} of {fmtBytes(plan!.total.bytes)} — {age ? SWEEP_AGE_LABEL[age] : FAMILY_KEEP_LABEL[keep!]}
        </FilterBar>
      )}

      {cut && (
        <>
          <div className="list sweep-list">
            {cut.rows.map((r) => (
              <div key={r.relPath} className="row sweep-row">
                {/* The full worktree-relative path, never the bare name: two
                    transport directories can hold the same filename, and the
                    path is what is actually being deleted. */}
                <span className="sweep-path mono">{r.relPath}</span>
                <span className="sweep-meta">{fmtBytes(r.size)} · {ago(r.mtime)}</span>
              </div>
            ))}
          </div>

          <div className="form">
            {/* What STAYS — each ladder says it in its own terms, because "3
                newer files stay" and "the newest 3 of each of 13 families" are
                different facts and only one of them is true at a time. */}
            <Hint>
              {age ? sweepKeepText(cut, age) : familyKeepText(cut, keep!, families?.n ?? 0)}
            </Hint>
            {cut.count > 0 ? (
              // `ConfirmButton`, never `window.confirm` — a native modal blocks
              // the WebView's event loop (CLAUDE.md). The label restates the
              // WHOLE decision: how many, and how much.
              <ConfirmButton className="send danger" confirm={`Yes — delete ${cut.count} · ${fmtBytes(cut.bytes)}`}
                disabled={busy} onConfirm={() => void run()}>
                <Trash2 size={14} /> {busy ? "Deleting…" : age ? sweepButtonText(cut) : familyButtonText(cut)}
              </ConfirmButton>
            ) : (
              // Not a dimmed button: a refusal is a SENTENCE (CLAUDE.md,
              // `Unavailable.tsx`).
              <Unavailable className="form-hint" cants={[{
                label: "delete",
                reason: age
                  ? `nothing in this ${scope} is ${SWEEP_AGE_LABEL[age]}.`
                  : `every file here is among the newest ${keep} of its build family.`,
              }]} />
            )}
          </div>
        </>
      )}

      {/* What it DID, kept on screen after the re-read. "Already gone" is said
          apart from "could not be removed": one is the sweep succeeding by
          another route, the other is bytes still on disk. */}
      {result && (
        <div className="form">
          <Hint className={result.failed.length ? "warn" : ""}>{sweepResultText(result)}</Hint>
          {result.failed.length > 0 && (
            <div className="list">
              {result.failed.map((p) => <div key={p} className="row sweep-row"><span className="sweep-path mono">{p}</span></div>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
