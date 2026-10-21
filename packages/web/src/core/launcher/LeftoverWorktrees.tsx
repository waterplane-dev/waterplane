/**
 * Worktrees no session is using — said out loud, checked, and removable.
 *
 * They used to sit above a repo's sessions as bare rows: a branch name and
 * "worktree of myrepo", nothing on why they were there or whether they mattered.
 * They are almost always an agent's checkout whose session ended before its
 * own cleanup ran. Each one is asked of the host (`host/worktreeleftover.ts`):
 * is anything in it that exists ONLY there? The answer is the row's line, and
 * a remove is offered only when the answer is "nothing" — the host re-checks
 * on the remove itself, so a stale reading cannot delete work.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleCheck, TriangleAlert, Trash2 } from "lucide-react";
import type { RepoTarget, WorktreeLeftover } from "@waterplane/shared";
import { api } from "../../api";
import { ConfirmButton } from "../../Confirm";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { RowSub } from "../../kit/Row";

type Reading = { state: "loading" } | { state: "error"; error: string } | { state: "ok"; v: WorktreeLeftover };

/** One host read per worktree id, re-asked when the set of ids changes. */
export function useLeftovers(ids: string[]): { readings: Map<string, Reading>; recheck: () => void } {
  const [readings, setReadings] = useState<Map<string, Reading>>(new Map());
  const [nonce, setNonce] = useState(0);
  const key = ids.join(",");
  useEffect(() => {
    if (!ids.length) return;
    let live = true;
    setReadings(new Map(ids.map((id) => [id, { state: "loading" } as Reading])));
    for (const id of ids) {
      api.worktreeLeftover(id).then(
        (v) => { if (live) setReadings((m) => new Map(m).set(id, { state: "ok", v })); },
        (e: unknown) => { if (live) setReadings((m) => new Map(m).set(id, { state: "error", error: e instanceof Error ? e.message : String(e) })); },
      );
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is `ids`, by value
  }, [key, nonce]);
  return { readings, recheck: useCallback(() => setNonce((n) => n + 1), []) };
}

const safe = (r: Reading | undefined): boolean => r?.state === "ok" && r.v.blockers.length === 0;

/** Remove each, one after another, and say what happened in one toast. */
async function removeAll(ts: RepoTarget[], done: () => void): Promise<void> {
  let removed = 0;
  const refused: string[] = [];
  const notes: string[] = [];
  for (const t of ts) {
    try {
      const r = await api.removeWorktree(t.id);
      if (r.ok) { removed++; if (r.note) notes.push(r.note); } else refused.push(`${t.branch}: ${r.error ?? "refused"}`);
    } catch (e) {
      refused.push(`${t.branch}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const head = removed ? `Removed ${removed} worktree${removed === 1 ? "" : "s"} and ${removed === 1 ? "its branch" : "their branches"}.` : "Nothing removed.";
  showToast([head, ...notes, ...(refused.length ? [`Kept ${refused.join("; ")}`] : [])].join(" "));
  done();
}

/** The line above a repo's session-less worktrees: what they are and the one-tap cleanup. */
export function LeftoverHead({ wts, readings, onChanged }: {
  wts: RepoTarget[]; readings: Map<string, Reading>; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!wts.length) return null;
  const n = wts.length;
  const ok = wts.filter((t) => safe(readings.get(t.id)));
  const pending = wts.some((t) => readings.get(t.id)?.state === "loading");
  const kept = n - ok.length;
  return (
    <div className="wt-leftover-head">
      <RowSub as="div">
        No session is using {n === 1 ? "this worktree" : `these ${n} worktrees`}. A worktree is a second checkout
        of the repo, usually made for an agent; {n === 1 ? "it" : "they"} outlived the session that made {n === 1 ? "it" : "them"}.
        {pending ? " Checking what is in them…" : ok.length === n
          ? ` Every commit in ${n === 1 ? "it" : "them"} is already on ${firstBase(ok, readings)}, and nothing is uncommitted — removing loses nothing.`
          : ok.length
            ? ` ${ok.length} hold nothing that is not on ${firstBase(ok, readings)}; ${kept} hold work, said on ${kept === 1 ? "its" : "their"} row.`
            : ` ${n === 1 ? "It holds" : "Each holds"} work that is not anywhere else, said on the row — open it to commit or keep it.`}
      </RowSub>
      {ok.length > 0 && (
        busy
          ? <RowSub>removing…</RowSub>
          : <ConfirmButton className="key wt-leftover-go" confirm={`remove ${ok.length} for good?`}
              onConfirm={() => { track("action:repo.worktree.removeLeftovers"); setBusy(true); void removeAll(ok, () => { setBusy(false); onChanged(); }); }}>
              <Trash2 size={14} />remove {ok.length === n ? (n === 1 ? "it" : `all ${n}`) : `the ${ok.length} safe`}
            </ConfirmButton>
      )}
    </div>
  );
}

function firstBase(ts: RepoTarget[], readings: Map<string, Reading>): string {
  for (const t of ts) { const r = readings.get(t.id); if (r?.state === "ok" && r.v.base) return r.v.base; }
  return "the main branch";
}

/** A session-less worktree row's verdict line. */
export function LeftoverLine({ r }: { r: Reading | undefined }) {
  if (!r || r.state === "loading") return <RowSub className="wt-leftover">checking what is in it…</RowSub>;
  if (r.state === "error") return <RowSub className="wt-leftover warn"><TriangleAlert size={12} />could not check it: {r.error}</RowSub>;
  if (!r.v.blockers.length) {
    return <RowSub className="wt-leftover ok"><CircleCheck size={12} />nothing only here — {r.v.ahead ? `its ${r.v.ahead} commit${r.v.ahead === 1 ? " is" : "s are"} on ${r.v.base} as cherry-picks` : `all on ${r.v.base}`}</RowSub>;
  }
  return <RowSub className="wt-leftover warn"><TriangleAlert size={12} />keep: {r.v.blockers.join(" ")}</RowSub>;
}

/** The row menu's remove: offered only on a safe reading, otherwise the reason. */
export function LeftoverRemove({ t, r, onChanged }: { t: RepoTarget; r: Reading | undefined; onChanged: () => void }) {
  if (!safe(r)) return null;
  return (
    <ConfirmButton className="more-act" confirm="remove for good?"
      onConfirm={() => { track("action:repo.worktree.remove"); void removeAll([t], onChanged); }}>
      <Trash2 size={16} />remove worktree
    </ConfirmButton>
  );
}
