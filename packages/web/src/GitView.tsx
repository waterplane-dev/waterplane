import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowDownUp, ArrowUpFromLine, Check, History, Copy, FolderTree, SquareTerminal, GitBranch as GitBranchIcon, Loader, Minus, Plus, RotateCw, Sparkles, Trash2, X } from "lucide-react";
import type { GitBranch, GitFile, GitPushProgress, GitPushState, GitStatus } from "@waterplane/shared";
import { api, copyText } from "./api";
import { track } from "./usage";
import { useRemoteResource } from "./useRemoteResource";
import { SheetHead } from "./Sheet";
import { useBackStep } from "./backStep";
import { ConfirmButton, askConfirm } from "./Confirm";
import { Empty } from "./Empty";
import { ZoomPair } from "./ZoomPair";
import { GitMediaDiff, isMediaDiff } from "./GitMediaDiff";
import { GitTextDiff } from "./GitTextDiff";
import { GitLogView, type GitLogFocus } from "./GitLogView";
import { GIT_COPIED, GIT_COPY_FAILED, GIT_COPY_LABEL, GIT_FIX_LABEL, gitFailPrompt, type GitFailure } from "./gitFailPrompt";
import { showToast } from "./toast";
import { ago } from "./format";
import { gitZoom, nextReaderZoom, readerScale, setGitZoom, textScale } from "./uiScale";
import { Button } from "./kit/Button";
import { Row, RowTitle } from "./kit/Row";
import { Hint } from "./kit/Hint";

interface Props {
  repoId: string;
  /**
   * A failed push or pull, handed to a NEW session in this repo — the overlay
   * table turns it into a Send-sheet seed (`gitFailSeed`), so nothing is sent
   * by the tap. Absent ⇒ the button is absent.
   */
  onAskAgent?: (f: GitFailure) => void;
  /** The repo's file tree; closing it lands back here. Absent ⇒ no button. */
  onBrowse?: () => void;
  onClose: () => void;
  /** The host's stored failure of the last pull/push here (`RepoTarget.gitFailed`), kept
   *  across restarts and devices; shown when this screen holds no failure note of its own. */
  stored?: { verb: "pull" | "push"; at: number; error: string; id: string };
  /** `done` on the stored failure — `notification.handle(stored.id)`. */
  onDone?: (id: string) => void;
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

/** `0:42` — the push's running clock. */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** How often a running push is asked after. The hook it runs takes minutes. */
const PUSH_POLL_MS = 3000;
/** How long a push that ended while nobody was looking is still told on opening the sheet. */
const PUSH_RECENT_MS = 30 * 60_000;

function pushTook(p: GitPushState): string {
  return elapsed(p.result!.finishedAt - p.startedAt);
}

/** One sentence for a push that ended — its duration on the desktop's own clock. */
function pushEndedWords(p: GitPushState): string {
  const r = p.result!;
  const took = pushTook(p);
  return r.ok ? `Pushed in ${took}: ${r.output?.split("\n").slice(-1)[0] ?? "ok"}` : `Push failed after ${took}. ${r.error}`;
}

/**
 * What the running push has printed: the pre-push hook's steps with their
 * times, the e2e count, and the last lines. One line and a clock for twenty
 * minutes could not tell a suite on its 50th script from a hook stuck on its
 * first step. A hook the host cannot read has no steps — only its lines.
 */
function PushProgressView({ p, fill }: { p: GitPushProgress; fill: boolean }) {
  // Its own scroll region: a hook prints dozens of steps and the sheet does
  // not scroll. Follows the newest line while the reader sits at the bottom;
  // once they scroll up to read, it stays where they put it.
  const box = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [p]);
  const onScroll = () => {
    const el = box.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  const icon = (s: GitPushProgress["steps"][number]) =>
    s.state === "running" ? <Loader size={14} className="spin" />
      : s.state === "ok" ? <Check size={14} />
      : s.state === "failed" ? <X size={14} />
      : <Minus size={14} />;
  return (
    <div ref={box} onScroll={onScroll} className={`git-push-progress${fill ? " fill" : ""}`}>
      {p.steps.map((s, i) => (
        <div key={i} className={`git-push-step ${s.state}`}>
          {icon(s)}
          <span>{s.name}</span>
          <span className="git-push-step-aside">
            {s.state === "ok" && s.secs != null ? `${elapsed(s.secs * 1000)}`
              : s.state === "skipped" ? `skipped${s.why ? ` — ${s.why}` : ""}`
              : s.state === "failed" ? "failed"
              : s.state === "running" && p.e2e && i === p.steps.length - 1
                ? `${p.e2e.done} of ${p.e2e.total} scripts${p.e2e.failed ? ` · ${p.e2e.failed} failed` : ""}`
              : ""}
          </span>
        </div>
      ))}
      {p.tail.length > 0 && <pre className="git-push-tail">{p.tail.join("\n")}</pre>}
    </div>
  );
}

/** Review changed files, view diffs, stage, commit, pull and push from the phone. */
export function GitView({ repoId, onAskAgent, onBrowse, onClose, stored, onDone }: Props) {
  const [openFile, setOpenFile] = useState<GitFile | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /**
   * The failed push/pull the note is telling, with the NOTE it was told in:
   * the fix button belongs to that sentence, so any later note (a commit, the
   * next push starting) takes the button away without every writer of the
   * note having to remember to.
   */
  const [failure, setFailure] = useState<{ note: string; f: Omit<GitFailure, "branch" | "upstream" | "ahead"> } | null>(null);
  function noteFailure(text: string, f: Omit<GitFailure, "branch" | "upstream" | "ahead">) {
    setNote(text);
    setFailure({ note: text, f });
  }
  /** The failure with what the screen knows now — both buttons hand over the same words. */
  function fullFailure(f: Omit<GitFailure, "branch" | "upstream" | "ahead">): GitFailure {
    return { ...f, branch: status?.branch ?? "the current branch", upstream: status?.upstream, ahead: f.verb === "push" ? status?.ahead : undefined };
  }
  /** A push that ended badly, told in the note and offered to a new session. */
  function notePushEnd(text: string, p: GitPushState) {
    if (p.result && !p.result.ok && p.result.error) noteFailure(text, { verb: "push", took: pushTook(p), error: p.result.error });
    else setNote(text);
  }
  /** When the running push started — drives the elapsed clock on the button. */
  const [pushStart, setPushStart] = useState<number | null>(null);
  /** What the running push has printed so far, off the same poll as its end. */
  const [pushProgress, setPushProgress] = useState<GitPushProgress | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    if (pushStart == null) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [pushStart]);
  /** A pull in flight — a LABEL on the button and the guard against a second tap, never a disabled attribute. */
  const [pulling, setPulling] = useState(false);
  const [showBranches, setShowBranches] = useState(false);
  /** The history view, cut to the side whose count was tapped (`null` = closed). */
  const [logFocus, setLogFocus] = useState<GitLogFocus | null>(null);
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
  /**
   * Push is a JOB on the desktop (host `startPush`), not one request: the
   * pre-push hook is the full local CI, tens of minutes, and a request held
   * open across it hit the phone's three-minute fuse and read as a failure
   * while the push carried on unheard. The tap starts it (or joins the one
   * already running) and the sheet asks after it until it ends.
   */
  async function push(ahead = status?.ahead ?? 0, before = "") {
    if (pushStart != null) return;
    track("action:git.push");
    try {
      const p = await api.gitPush(repoId);
      setPushStart(p.startedAt);
      setNote(`${before}Pushing${ahead ? ` ${ahead} commit${ahead > 1 ? "s" : ""}` : ""}. The desktop runs this repo's pre-push checks first (build, lint, tests) — that can take many minutes. You can leave this screen; the push carries on, and reopening it picks the clock back up.`);
    } catch (e) {
      setNote(`${before}The push did not start: ${(e as Error).message}`);
    }
  }
  /**
   * Pull: the desktop fetches, then fast-forwards — or, when both sides
   * moved and the tree has no edits, replays the local commits on top. It
   * lands whole or changes nothing, and a refusal is the host's own sentence.
   * Seconds, not minutes (no hook), so one held request.
   *
   * Resolves to whether it landed, so `sync` knows whether to go on.
   */
  async function pull(): Promise<string | null> {
    if (pulling || pushStart != null) return null;
    setPulling(true); setNote(null);
    try {
      const r = await api.gitPull(repoId);
      if (r.ok) setNote(r.output ?? "Pulled.");
      else if (r.error) noteFailure(r.error, { verb: "pull", error: r.error });
      else setNote("The pull failed.");
      return r.ok ? r.output ?? "Pulled." : null;
    } catch (e) {
      setNote(`The pull did not run: ${(e as Error).message}`);
      return null;
    } finally {
      setPulling(false);
      refresh();
    }
  }
  /**
   * Sync = pull, then push whatever is still ahead. The push count is read
   * AFTER the pull, off a fresh status — the one on screen predates the
   * fetch, and a replay can change nothing about the count but the fetch can.
   */
  async function sync() {
    if (pulling || pushStart != null) return;
    track("action:git.sync");
    const pulled = await pull();
    if (pulled == null) return;
    let ahead = 0;
    try { ahead = (await api.gitStatus(repoId)).ahead; } catch { /* the status read says when the desktop is gone */ }
    if (ahead > 0) await push(ahead, `${pulled} `);
  }
  // Opening the sheet finds a push already running (started from here before
  // the sheet closed, or from another tab) and follows it; one that ended
  // while nobody was looking is told once.
  useEffect(() => {
    let gone = false;
    api.gitPushState(repoId).then((p) => {
      if (gone || !p) return;
      if (p.running) {
        setPushStart(p.startedAt);
        setPushProgress(p.progress ?? null);
        setNote((cur) => cur ?? "A push is running on the desktop — its pre-push checks first, then the push itself.");
      } else if (p.result && Date.now() - p.result.finishedAt < PUSH_RECENT_MS) {
        // A note already on screen wins — this effect races the first taps.
        setNote((cur) => {
          if (cur) return cur;
          const text = `Last push, ${elapsed(Date.now() - p.result!.finishedAt)} ago — ${pushEndedWords(p)}`;
          if (!p.result!.ok && p.result!.error) setFailure({ note: text, f: { verb: "push", took: pushTook(p), error: p.result!.error } });
          return text;
        });
      }
    }).catch(() => { /* the status read above says when the desktop is unreachable */ });
    return () => { gone = true; };
  }, [repoId]);
  useEffect(() => {
    if (pushStart == null) return;
    let gone = false;
    const t = setInterval(async () => {
      let p: GitPushState | null;
      try { p = await api.gitPushState(repoId); } catch { return; /* a missed ask; the push carries on */ }
      if (gone) return;
      if (!p || p.startedAt !== pushStart) {
        setPushStart(null);
        setPushProgress(null);
        setNote("The desktop no longer knows this push — it restarted while the push ran. The counts above say whether the commits went.");
        refresh();
        return;
      }
      if (p.running) { setPushProgress(p.progress ?? null); return; }
      setPushStart(null);
      setPushProgress(null);
      notePushEnd(pushEndedWords(p), p);
      refresh();
    }, PUSH_POLL_MS);
    return () => { gone = true; clearInterval(t); };
    // `refresh` is a new closure every render; re-arming the poll on each would
    // reset its interval every second while the clock ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushStart, repoId]);

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
  useBackStep(logFocus !== null, () => setLogFocus(null));

  if (logFocus) {
    return <GitLogView repoId={repoId} focus={logFocus} onFocus={setLogFocus} onFetched={refresh} onClose={() => setLogFocus(null)} />;
  }

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
  // Push needs no commit first: it sends what is already committed and leaves
  // the working tree alone. The count says how much that is.
  const pushLabel = pushStart != null
    ? <><Loader size={14} className="spin" /> pushing… {elapsed(Date.now() - pushStart)}</>
    : <><ArrowUpFromLine size={14} /> {status && status.ahead > 0 ? `Push ${status.ahead}` : "Push"}</>;
  // The count is as of the desktop's last fetch; the pull fetches first.
  const pullLabel = pulling
    ? <><Loader size={14} className="spin" /> pulling…</>
    : <><ArrowDownToLine size={14} /> {status && status.behind > 0 ? `Pull ${status.behind}` : "Pull"}</>;
  // Pull, push and sync work on what is COMMITTED, so they are one row under
  // the commit form whatever the tree's state.
  const remoteRow = (
    <div className="sheet-actions">
      <Button onClick={() => { track("action:git.pull"); void pull(); }} disabled={busy}>{pullLabel}</Button>
      <Button onClick={() => { void push(); }} disabled={busy}>{pushLabel}</Button>
      <Button onClick={() => { void sync(); }} disabled={busy}
        title="pull, then push whatever is still ahead">
        <ArrowDownUp size={14} /> Sync
      </Button>
    </div>
  );
  return (
    <div className="sheet">
      <SheetHead title={<>Review · {status?.branch ?? "…"}</>} onClose={onClose}>
        {onBrowse && <Button title="browse files" onClick={() => { track("action:git.browse"); onBrowse(); }}><FolderTree size={16} /></Button>}
        <Button title="history — incoming, not pushed, and what both have" onClick={() => { track("action:git.log"); setLogFocus("all"); }}><History size={16} /></Button>
        <Button className={showBranches ? "active" : ""} title="branches" onClick={toggleBranches}><GitBranchIcon size={16} /></Button>
        <Button onClick={refresh}><RotateCw size={16} /></Button>
      </SheetHead>

      {status && (
        <div className="git-bar">
          <span className="mono">{status.branch}{status.upstream ? ` → ${status.upstream}` : " (no upstream)"}</span>
          {/* Each count opens exactly its commits — a count on a control is a filter. */}
          {status.upstream && (
            <span className="git-ab">
              <button className="git-ab-n" onClick={() => { track("action:git.log.out"); setLogFocus("out"); }}
                title="the commits here that are not pushed">↑{status.ahead}</button>
              <button className="git-ab-n" onClick={() => { track("action:git.log.in"); setLogFocus("in"); }}
                title="the commits on the upstream that are not here — opening checks it">↓{status.behind}</button>
            </span>
          )}
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
              <Row key={b.name} kind="wrap">
                <Row as={b.current || b.inUseElsewhere ? "div" : "button"} kind="grow" onClick={b.current || b.inUseElsewhere ? undefined : () => switchTo(b)}
                  title={b.current || b.inUseElsewhere ? undefined : "switch to this branch"}>
                  <span className={`gstat ${b.current ? "g-added" : ""}`}>{b.current ? "●" : "○"}</span>
                  <RowTitle className="mono">{b.name}{b.upstream ? ` → ${b.upstream}` : ""}{b.inUseElsewhere ? " (checked out in another worktree)" : b.current ? " (current)" : ""}</RowTitle>
                </Row>
                {!b.current && (
                  <ConfirmButton className="row-act" title={`delete branch ${b.name}`}
                    confirmTitle={`tap again to delete ${b.name}`}
                    confirm={<><Trash2 size={16} /> sure?</>}
                    onConfirm={() => { void deleteBranch(b); }}>
                    <Trash2 size={16} />
                  </ConfirmButton>
                )}
              </Row>
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
          <Row key={f.path + f.code} kind="wrap">
            <Row as="button" kind="grow" onClick={() => { track("action:git.diff"); setOpenFile(f); }}>
              <span className={`gstat g-${label(f)}`}>{label(f)}</span>
              <RowTitle className="mono">{f.from ? `${f.from} → ${f.path}` : f.path}</RowTitle>
            </Row>
            <button className={`row-act ${f.staged ? "on" : ""}`} title={f.staged ? "unstage" : "stage"} onClick={() => toggleStage(f)}>
              {f.staged ? <Check size={16} /> : <Plus size={16} />}
            </button>
          </Row>
        ))}
      </div>

      {!status?.clean && (
        <div className="form">
          {/* The suggestion, when the box already held words. Shown in FULL —
              it is a commit message, and a clipped one cannot be judged. */}
          {draft && (
            <div className="git-draft">
              <Hint>A message was drafted, and your own words are still in the box:</Hint>
              <pre className="git-draft-msg">{draft}</pre>
              <div className="sheet-actions">
                <Button onClick={() => { setMessage(draft); setDraft(null); }}>Use this one</Button>
                <Button onClick={() => setDraft(null)}>Keep mine</Button>
              </div>
            </div>
          )}
          <textarea className="search" rows={2} placeholder="Commit message…" value={message} onChange={(e) => setMessage(e.target.value)} />
          <div className="sheet-actions">
            <button className="send" onClick={commit} disabled={busy || !message.trim()}>Commit all</button>
            {/* The desktop writes the message. Last in the row: it is the one
                control here that spends, and the commit beside it is what
                this sheet is for. */}
            <Button onClick={writeMessage}
              title="draft the commit message from this diff — one cheap call on the desktop">
              <Sparkles size={16} /> {writing ? "writing…" : "message"}
            </Button>
          </div>
        </div>
      )}
      {status && remoteRow}
      {/* ABOVE the note: the note is the log's tail, forty lines on a phone. */}
      {failure && failure.note === note && (
        <div className="sheet-actions">
          {onAskAgent && (
            <Button onClick={() => {
              track("action:git.askAgent");
              onAskAgent(fullFailure(failure.f));
            }} title="open the Send sheet with this log and its context, aimed at a new session in this repo — nothing is sent yet">
              <SquareTerminal size={16} /> {GIT_FIX_LABEL}
            </Button>
          )}
          <Button onClick={async () => {
            track("action:git.copyFailure");
            showToast(await copyText(gitFailPrompt(fullFailure(failure.f))) ? GIT_COPIED : GIT_COPY_FAILED);
          }} title="copy the same words to the clipboard: the log, with the branch, upstream and how long it ran">
            <Copy size={16} /> {GIT_COPY_LABEL}
          </Button>
        </div>
      )}
      {stored && !note && (
        <>
          <Hint className="git-note">The last {stored.verb} failed {ago(stored.at)}.{"\n"}{stored.error}</Hint>
          <div className="sheet-actions">
            {onAskAgent && (
              <Button onClick={() => { track("action:git.askAgent"); onAskAgent(fullFailure({ verb: stored.verb === "pull" ? "pull" : "push", error: stored.error })); }}
                title="open the Send sheet with this log and its context, aimed at a new session in this repo — nothing is sent yet">
                <SquareTerminal size={16} /> {GIT_FIX_LABEL}
              </Button>
            )}
            <Button onClick={async () => { showToast(await copyText(gitFailPrompt(fullFailure({ verb: stored.verb, error: stored.error }))) ? GIT_COPIED : GIT_COPY_FAILED); }}
              title="copy the same words to the clipboard: the log, with the branch, upstream and how long it ran">
              <Copy size={16} /> {GIT_COPY_LABEL}
            </Button>
            {onDone && <Button onClick={() => onDone(stored.id)} title="mark this failure as dealt with; the red chip on the repo goes away"><Check size={16} /> done</Button>}
          </div>
        </>
      )}
      {note && <Hint className="git-note">{note}</Hint>}
      {pushStart != null && pushProgress && <PushProgressView p={pushProgress} fill={!!status?.clean} />}
    </div>
  );
}
