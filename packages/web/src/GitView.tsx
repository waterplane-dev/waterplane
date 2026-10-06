import { useEffect, useState } from "react";
import { Check, GitBranch as GitBranchIcon, Plus, RotateCw, Sparkles, Trash2 } from "lucide-react";
import type { GitBranch, GitFile, GitStatus } from "@waterplane/shared";
import { api } from "./api";
import { track } from "./usage";
import { useRemoteResource } from "./useRemoteResource";
import { SheetHead } from "./Sheet";
import { useBackStep } from "./backStep";
import { ConfirmButton, askConfirm } from "./Confirm";
import { Empty } from "./Empty";
import { ZoomPair } from "./ZoomPair";
import { GitMediaDiff, isMediaDiff } from "./GitMediaDiff";
import { GitTextDiff } from "./GitTextDiff";
import { gitZoom, nextReaderZoom, readerScale, setGitZoom, textScale } from "./uiScale";

interface Props {
  repoId: string;
  onClose: () => void;
}

/** Map a porcelain code to a short human label. */
function label(f: GitFile): string {
  const c = f.code.trim();
  if (c === "??") return "new";
  if (c.includes("D")) return "deleted";
  if (c.startsWith("R")) return "renamed";
  if (c.includes("A")) return "added";
  return "modified";
}

/** Review changed files, view diffs, stage, commit, and push from the phone. */
export function GitView({ repoId, onClose }: Props) {
  const [openFile, setOpenFile] = useState<GitFile | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [showBranches, setShowBranches] = useState(false);
  /**
   * A drafted message that is NOT in the box, because the box already had
   * words in it.
   *
   * Seeding over typed words is a delete (CLAUDE.md's draft rule) and this box
   * is the last copy of them — there is no listing and no undo behind it. An
   * empty box takes the suggestion straight away; a box with anything in it
   * gets the suggestion offered ABOVE it, and replacing is the person's tap.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  /**
   * How big the file list and the diff are drawn — the scrollback sheet's
   * mechanism (one `--ui-font` override on the zoomed subtree), its own stored
   * value. Paths and diff lines are the long thing here; smaller text is what
   * puts more of one on screen, and the list scrolls sideways for the rest.
   */
  const [zoom, setZoomState] = useState(() => gitZoom());
  const txt = textScale();
  const zoomFont = { ["--ui-font" as string]: String(readerScale(txt, zoom)) };
  function applyZoom(v: number) {
    track("action:uiscale.git");
    setZoomState(v);
    setGitZoom(v);
  }
  const zoomPair = (
    <div className="sb-zoom">
      <ZoomPair smaller={nextReaderZoom(zoom, -1, txt)} bigger={nextReaderZoom(zoom, 1, txt)} onZoom={applyZoom}
        smallerHint=" — more of each path and diff line on screen"
        biggerHint=" — fewer characters across" />
    </div>
  );

  /**
   * Two host reads, told honestly (`useRemoteResource`).
   *
   * Both were `.catch(() => setX(null))`, which is the shape this whole sheet's
   * silence came from: a repo the daemon refused (not a git worktree any more,
   * a `git` that is not on the PATH) and a dead tunnel both rendered as an
   * empty branch list under a header reading "Review · …". Nothing said which,
   * and nothing said anything at all. `error` and `offline` are separate states
   * here for exactly that reason.
   *
   * Not cached: a working tree's status is only ever interesting as of NOW —
   * showing yesterday's staged files and offering to commit them is worse than
   * saying the link is down.
   */
  const statusRes = useRemoteResource<GitStatus>(repoId, () => api.gitStatus(repoId));
  const status = statusRes.data;
  // Keyed on the disclosure too, so opening it reads and closing it stops.
  const branchRes = useRemoteResource<GitBranch[]>(`${repoId}:${showBranches}`, () => api.gitBranches(repoId), { enabled: showBranches });
  const branches = branchRes.data;

  const refresh = () => statusRes.reload({ quiet: true });
  const loadBranches = () => branchRes.reload({ quiet: true });

  useEffect(() => {
    if (!openFile || isMediaDiff(openFile.path)) return;
    setDiff("loading…");
    api.gitDiff(repoId, openFile.path, openFile.staged).then((d) => setDiff(d || "(no textual diff)"));
  }, [openFile, repoId]);

  async function toggleStage(f: GitFile) {
    track("action:git.stage");
    await api.gitStage(repoId, f.path, f.staged);
    refresh();
  }
  /**
   * Ask the desktop to draft the commit message (host `commitmsg.ts`): one
   * cheap toolless call over the diff this button would commit, plus this
   * repo's own recent subjects as the house style.
   *
   * `writing` is a LABEL, never a disabled attribute — a greyed button on a
   * phone says nothing about why (`Unavailable.tsx`'s rule) — and the guard
   * that stops a second call is the flag, not the pointer.
   */
  async function writeMessage() {
    if (writing) return;
    track("action:git.message");
    setWriting(true); setNote(null); setDraft(null);
    const r = await api.gitMessage(repoId);
    setWriting(false);
    if (!r.message) { setNote(r.reason ?? "No message came back."); return; }
    // The one rule this button must not break: words nobody typed never
    // overwrite words somebody did.
    if (message.trim()) setDraft(r.message);
    else setMessage(r.message);
  }
  async function commit() {
    track("action:git.commit");
    setBusy(true); setNote(null);
    const r = await api.gitCommit(repoId, message, true);
    setBusy(false);
    setNote(r.ok ? `Committed: ${r.output?.split("\n")[0] ?? "ok"}` : `Error: ${r.error}`);
    if (r.ok) { setMessage(""); refresh(); }
  }
  async function push() {
    track("action:git.push");
    setBusy(true); setNote(null);
    const r = await api.gitPush(repoId);
    setBusy(false);
    setNote(r.ok ? `Pushed: ${r.output?.split("\n").slice(-1)[0] ?? "ok"}` : `Error: ${r.error}`);
    refresh();
  }

  function toggleBranches() { setShowBranches((v) => !v); }
  /** Run a branch mutation, surface its result, and refresh status + the list. */
  async function runBranch(label: string, fn: () => Promise<{ ok: boolean; output?: string; error?: string }>) {
    track("action:git.branch");
    setBusy(true); setNote(null);
    const r = await fn();
    setBusy(false);
    setNote(r.ok ? `${label}${r.output ? `: ${r.output.split("\n").slice(-1)[0]}` : ""}` : `Error: ${r.error}`);
    if (r.ok) { refresh(); loadBranches(); }
    return r;
  }
  async function switchTo(b: GitBranch) {
    if (b.current || b.inUseElsewhere) return;
    await runBranch(`Switched to ${b.name}`, () => api.gitCheckout(repoId, b.name));
  }
  async function createBranch() {
    const n = newBranch.trim();
    if (!n) return;
    const r = await runBranch(`Created ${n}`, () => api.gitCreateBranch(repoId, n));
    if (r.ok) setNewBranch("");
  }
  /**
   * Delete a branch — two confirms, and deliberately two different SHAPES.
   *
   * The first is the row's own armed tap (`ConfirmButton` at the call site):
   * what it does is known when the row renders. The second cannot be — it
   * exists only because git came back "not fully merged", which is a fact
   * discovered mid-request, and by then there is no button left to arm. That
   * is exactly the case `askConfirm` is for, and it is a strictly bigger
   * decision than the first (losing commits, not losing a pointer), so it
   * getting the heavier affordance is the right way round.
   */
  async function deleteBranch(b: GitBranch) {
    if (b.current) return;
    let r = await api.gitDeleteBranch(repoId, b.name);
    if (!r.ok && /not fully merged/i.test(r.error ?? "")) {
      const forced = await askConfirm({
        title: `Force-delete ${b.name}?`,
        lines: [`"${b.name}" is not fully merged.`, "Its commits are on no other branch and will be lost."],
        confirmLabel: "Delete and lose the commits",
      });
      if (!forced) { setNote(`Kept ${b.name} — it is not fully merged`); return; }
      r = await api.gitDeleteBranch(repoId, b.name, true);
    }
    setNote(r.ok ? `Deleted ${b.name}` : `Error: ${r.error}`);
    if (r.ok) { refresh(); loadBranches(); }
  }

  // Back — the gesture as much as the arrow — closes this step, not the sheet.
  useBackStep(openFile !== null, () => setOpenFile(null));

  // ── Single-file diff view ───────────────────────────────────────────
  if (openFile) {
    return (
      <div className="sheet">
        <SheetHead title={openFile.path} brandClass="mono" onClose={() => setOpenFile(null)}>{zoomPair}</SheetHead>
        {isMediaDiff(openFile.path)
          ? <GitMediaDiff repoId={repoId} path={openFile.path} staged={openFile.staged} />
          : <GitTextDiff repoId={repoId} path={openFile.path} staged={openFile.staged} diff={diff} zoomFont={zoomFont} />}
      </div>
    );
  }

  // ── Status overview ─────────────────────────────────────────────────
  return (
    <div className="sheet">
      <SheetHead title={<>Review · {status?.branch ?? "…"}</>} onClose={onClose}>
        <button className={`key ${showBranches ? "active" : ""}`} title="branches" onClick={toggleBranches}><GitBranchIcon size={16} /></button>
        <button className="key" onClick={refresh}><RotateCw size={16} /></button>
      </SheetHead>

      {status && (
        <div className="git-bar">
          <span className="mono">{status.branch}{status.upstream ? ` → ${status.upstream}` : " (no upstream)"}</span>
          {(status.ahead > 0 || status.behind > 0) && <span className="git-ab">↑{status.ahead} ↓{status.behind}</span>}
          {!status.clean && zoomPair}
        </div>
      )}

      {showBranches && (
        <div className="git-branches">
          <div className="form">
            <input className="search" placeholder="New branch name…" value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") createBranch(); }} />
            <button className="send" onClick={createBranch} disabled={busy || !newBranch.trim()}>
              <Plus size={16} /> Create &amp; switch
            </button>
          </div>
          <div className="list">
            {/* Five states, five sentences — the point of the hook. "The host
                refused this" and "the host was not reachable" lead somewhere
                different, and both used to read as an empty list. Worded once
                in `Empty.tsx` now; this file's copy had already lost the
                cached-age line the sheet below it never had either. */}
            <Empty res={branchRes} empty={!branches?.length} thing="branches" noun="branch list">No local branches.</Empty>
            {branches?.map((b) => (
              <div key={b.name} className="row-wrap">
                <button className="row grow" disabled={b.current || b.inUseElsewhere} onClick={() => switchTo(b)}
                  title={b.inUseElsewhere ? "checked out in another worktree" : b.current ? "current branch" : "switch to this branch"}>
                  <span className={`gstat ${b.current ? "g-added" : ""}`}>{b.current ? "●" : "○"}</span>
                  <span className="row-title mono">{b.name}{b.upstream ? ` → ${b.upstream}` : ""}{b.inUseElsewhere ? " (in use)" : ""}</span>
                </button>
                {!b.current && (
                  <ConfirmButton className="row-act" title={`delete branch ${b.name}`}
                    confirmTitle={`tap again to delete ${b.name}`}
                    confirm={<><Trash2 size={16} /> sure?</>}
                    onConfirm={() => { void deleteBranch(b); }}>
                    <Trash2 size={16} />
                  </ConfirmButton>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Scrolls BOTH ways: a path is shown whole, never ellipsized — the
          stage button stays pinned to the right edge (`.git-files`). */}
      <div className="list git-files" style={zoomFont}>
        <Empty res={statusRes} empty={!status || !!status.clean} thing="the working tree" noun="status"
          offlineNote="Nothing here can be staged or committed until the link is back.">
          Working tree clean.
        </Empty>
        {status?.files.map((f) => (
          <div key={f.path + f.code} className="row-wrap">
            <button className="row grow" onClick={() => { track("action:git.diff"); setOpenFile(f); }}>
              <span className={`gstat g-${label(f)}`}>{label(f)}</span>
              <span className="row-title mono">{f.from ? `${f.from} → ${f.path}` : f.path}</span>
            </button>
            <button className={`row-act ${f.staged ? "on" : ""}`} title={f.staged ? "unstage" : "stage"} onClick={() => toggleStage(f)}>
              {f.staged ? <Check size={16} /> : <Plus size={16} />}
            </button>
          </div>
        ))}
      </div>

      {!status?.clean && (
        <div className="form">
          {/* The suggestion, when the box already held words. Shown in FULL —
              it is a commit message, and a clipped one cannot be judged. */}
          {draft && (
            <div className="git-draft">
              <div className="form-hint">A message was drafted, and your own words are still in the box:</div>
              <pre className="git-draft-msg">{draft}</pre>
              <div className="sheet-actions">
                <button className="key" onClick={() => { setMessage(draft); setDraft(null); }}>Use this one</button>
                <button className="key" onClick={() => setDraft(null)}>Keep mine</button>
              </div>
            </div>
          )}
          <textarea className="search" rows={2} placeholder="Commit message…" value={message} onChange={(e) => setMessage(e.target.value)} />
          <div className="sheet-actions">
            <button className="send" onClick={commit} disabled={busy || !message.trim()}>Commit all</button>
            <button className="key" onClick={push} disabled={busy}>Push</button>
            {/* The desktop writes the message. Last in the row: it is the one
                control here that spends, and the two verbs above it are what
                this sheet is for. */}
            <button className="key" onClick={writeMessage}
              title="draft the commit message from this diff — one cheap call on the desktop">
              <Sparkles size={16} /> {writing ? "writing…" : "message"}
            </button>
          </div>
        </div>
      )}
      {status?.clean && (
        <div className="sheet-actions"><button className="key" onClick={push} disabled={busy}>Push</button></div>
      )}
      {note && <div className="form-hint">{note}</div>}
    </div>
  );
}
