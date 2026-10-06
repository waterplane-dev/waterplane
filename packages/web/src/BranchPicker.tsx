import { useState } from "react";
import { GitBranch as GitBranchIcon, Plus } from "lucide-react";
import type { GitBranch, RepoTarget } from "@waterplane/shared";
import { api } from "./api";
import { useRemoteResource } from "./useRemoteResource";
import { SheetHead } from "./Sheet";
import { Empty } from "./Empty";

interface Props {
  /** The repo's primary worktree (used for the git API + as the "current branch" target). */
  primary: RepoTarget;
  /** All discovered targets, to map an existing worktree branch → its path. */
  targets: RepoTarget[];
  /** Start a session in this dir (creates the session). */
  onOpen: (cwd: string, title: string) => void;
  onClose: () => void;
}

/**
 * Start a session on ANY branch of a repo — not just the ones currently checked
 * out. Picking a branch:
 *   - already the primary's branch → open the primary worktree
 *   - checked out in another worktree → open that worktree
 *   - checked out nowhere → create a worktree for it, then open
 * Fixes "can't select main when the repo dir sits on another branch".
 */
export function BranchPicker({ primary, targets, onOpen, onClose }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  /**
   * One host read, told honestly (`useRemoteResource`).
   *
   * The `.catch(() => setBranches([]))` this replaces did not fail quietly — it
   * failed by LYING: an unreachable host and a refused repo both rendered "No
   * local branches", which is a sentence about the repo, not about the link, on
   * the one screen whose whole job is to list them.
   */
  const res = useRemoteResource<GitBranch[]>(primary.id, () => api.gitBranches(primary.id));
  const branches = res.data;

  /** Worktree path already checked out on `branch`, if any (incl. the primary). */
  function worktreeFor(branch: string): string | null {
    if (primary.branch === branch) return primary.worktreePath;
    const t = targets.find((x) => x.repoName === primary.repoName && x.branch === branch);
    return t ? t.worktreePath : null;
  }

  async function pick(branch: string) {
    setErr(null);
    const existing = worktreeFor(branch);
    if (existing) { onOpen(existing, `${primary.repoName} · ${branch}`); return; }
    // Not checked out anywhere → make a worktree for it.
    setBusy(branch);
    const r = await api.newWorktree(primary.id, branch);
    setBusy(null);
    if (r.path) onOpen(r.path, `${primary.repoName} · ${r.branch ?? branch}`);
    else setErr(r.error || "could not create worktree");
  }

  return (
    <div className="sheet">
      <SheetHead title={<><GitBranchIcon size={16} /> {primary.repoName} · branch</>} onClose={onClose} />

      <div className="form">
        <input className="search" placeholder="Filter, or type a new branch name…" value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) pick(newName.trim()); }} />
        {newName.trim() && !branches?.some((b) => b.name === newName.trim()) && (
          <button className="send" disabled={!!busy} onClick={() => pick(newName.trim())}>
            <Plus size={16} /> Create &amp; open “{newName.trim()}”
          </button>
        )}
      </div>
      {err && <div className="err">{err}</div>}

      <div className="list">
        <Empty res={res} empty={!branches?.length} thing="branches" noun="branch list">No local branches.</Empty>
        {branches?.filter((b) => b.name.toLowerCase().includes(newName.trim().toLowerCase())).map((b) => {
          const checkedOut = !!worktreeFor(b.name);
          return (
            <button key={b.name} className="row" disabled={busy === b.name} onClick={() => pick(b.name)}>
              <span className={`gstat ${b.current ? "g-added" : ""}`}>{b.current ? "●" : "○"}</span>
              <span className="row-title mono">{b.name}</span>
              <span className="row-sub">
                {busy === b.name ? "creating…" : b.current ? "primary" : checkedOut ? "worktree" : "new worktree"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
