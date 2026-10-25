import { useEffect, useState } from "react";
import {
  Boxes, Check, CloudDownload, CloudOff, Download, Loader, PackageCheck, PackagePlus, Pause, Play, Plus,
  RotateCw, Save, Settings, Smartphone, Trash2, TriangleAlert, X,
} from "lucide-react";
import { BRAND, DEFAULT_AUTOPULL, type AutoPullConfig, type RepoTarget } from "@waterplane/shared";
import { autoPull, pulls, setAutoPull, type PullRecord } from "./pull";
import { autoSaveOutPref, saveNow, setAutoSaveOut } from "./download";
import { browserPullAsk, downloadAction, downloadStatus, pullGone, stripRows } from "./downloadState";
import { nativeSaveSupported } from "./nativeSave";
import { fmtSize } from "./format";
import { track } from "./usage";
import { SheetHead } from "./Sheet";
import { RadioRows, Button, Row, RowTitle, RowSub, Hint } from "./kit";
import { Empty } from "./Empty";
import { hostBase, isNativeShell } from "./hostUrl";
import { LS, lsGet, lsSet } from "./storage";
import { nativeDropAfterSave, nativePullSupported, setNativeDropAfterSave } from "./nativePull";
import { ConfirmButton } from "./Confirm";
import { showToast } from "./toast";
import {
  allowToggle, autoInstallText, cleanedText, installIntroText, installOffer, installStatusText, installVerbText,
  NO_INSTALL, toggleAllow, type InstallCaps,
} from "./installPolicy";
import {
  installStatus, nativeInstall, nativeInstallSupported, openInstallSettings,
  readInstallAllow, writeInstallAllow,
} from "./nativeInstall";
import { SetLine, SetNote } from "./SettingsKit";

interface Props {
  repos: RepoTarget[];
  /** Per-repo rules, keyed by worktree path (filled in as the host answers). */
  configs: Map<string, AutoPullConfig>;
  /** Ask the host for a repo's rule (it answers `pull.config`). */
  onLoadConfig: (repoDir: string) => void;
  onSaveConfig: (repoDir: string, config: AutoPullConfig) => void;
  /** Drop one queued item, or the whole host queue when `id` is omitted. */
  onDismiss: (id?: string) => void;
  /** Open the apps list. The install count here is a COUNT ON A CONTROL, so it
   *  opens exactly what it counted rather than leaving a number to re-derive
   *  from rows that may no longer be on the phone (`AppsSheet.tsx`). */
  onOpenApps: () => void;
  /**
   * Open on the RULES pane, with this repo already picked.
   *
   * The rules are per repo and stored with the project, so the place somebody
   * asks "what does this repo fetch on its own?" is the repo's own `⋯` menu in
   * the launcher — not a sheet reached from a download, where the repo then has
   * to be found again in a picker. The menu passes a worktree path; absent means
   * the ordinary door, which opens on the files.
   */
  rulesFor?: string;
  online?: boolean;
  onClose: () => void;
}

/** Repaint clock. Everything the status line says — percent, rate, ETA, "retry
 *  in 12s" — is a function of the current time, and the records only change when
 *  bytes land (which on a bad link is the thing that ISN'T happening). Without
 *  this the row freezes exactly when it is most important that it doesn't. */
function useTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}


const fmtWhenFull = (ms: number) => (ms ? new Date(ms).toLocaleString() : "");

/** The distance, in brackets, beside the stamp — and only while it says
 *  something the stamp does not. Past a day "21 Sept, 11:21" and "3d ago" are
 *  the same sentence twice. */
function fmtAgo(ms: number): string {
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 0 || min >= 1440) return "";
  return min < 1 ? " · just now" : min < 60 ? ` · ${min}m ago` : ` · ${Math.floor(min / 60)}h ago`;
}

/** The creation date as a DATE, not a distance. "6m ago" answers "is this fresh?"
 *  and nothing else — with several builds of the same name in the queue, the one
 *  question left is *which* one, and on a phone there is no tooltip to hover for
 *  it. Year is dropped when it is this one; it is noise 11 months of 12. */
function fmtStamp(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    year: sameYear ? undefined : "numeric",
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

const fmtRate = (bps: number) => (bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : bps >= 1e3 ? `${Math.round(bps / 1e3)} KB/s` : `${Math.round(bps)} B/s`);

/** Coarse on purpose: a to-the-second ETA off a mobile link is a lie told
 *  precisely. */
function fmtEta(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return "";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

/** Size caps offered in the picker. 0 = no cap (say so, don't show "0 B"). */
const CAPS = [16 * 1024 * 1024, 64 * 1024 * 1024, 256 * 1024 * 1024, 1024 * 1024 * 1024, 0];
const capLabel = (b: number) => (b === 0 ? "no cap" : fmtSize(b));

/** Starting points, because nobody wants to type `*.apk` on a phone keyboard. */
const PRESETS: { label: string; patterns: string[] }[] = [
  { label: "builds", patterns: ["*.apk", "*.aab", "*.ipa", "*.iq", "*.prg"] },
  { label: "archives", patterns: ["*.zip", "*.tgz", "*.tar", "*.gz"] },
  { label: "reports", patterns: ["*.md", "*.pdf", "*.csv"] },
  { label: "images", patterns: ["*.png", "*.jpg", "*.jpeg", "*.webp"] },
];

/**
 * Auto-download: what the phone fetches on its own, and how those fetches are
 * going. Two halves — the live queue (top) and the per-repo rules (bottom) —
 * because the question "why hasn't it downloaded?" is answered by one or the
 * other and jumping between sheets to find out is the annoying version.
 */
export function PullSheet({ repos, configs, onLoadConfig, onSaveConfig, onDismiss, onOpenApps, rulesFor, onClose, online = true }: Props) {
  const [records, setRecords] = useState<PullRecord[]>([]);
  const [auto, setAuto] = useState(autoPull());
  const [autoSave, setAutoSaveState] = useState(autoSaveOutPref());
  // Held by the shell (the save it follows runs with the page frozen), so it is
  // ASKED on open. Undefined: no shell, or one older than the switch.
  const [dropCopy, setDropCopy] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void nativeDropAfterSave().then((on) => { if (live) setDropCopy(on); });
    return () => { live = false; };
  }, []);
  // `rulesFor` wins over the primary repo — it is the repo whose menu was
  // tapped, and picking one of fifteen again on a phone select is the step that
  // door exists to skip. Read at MOUNT only: the sheet is a fresh mount per
  // open, and re-applying it on every render would fight the picker.
  const [repoDir, setRepoDir] = useState<string>(
    rulesFor || repos.find((r) => r.isPrimary)?.worktreePath || repos[0]?.worktreePath || "");
  const [pattern, setPattern] = useState("");
  // Which half of the sheet is on screen. The rules used to be a third section
  // BELOW the queue and the finished list, which is fine with four downloads and
  // unreachable with forty-five: "I cannot find the auto-download settings any
  // more" is what a screen full of rows does to a section under them. Two
  // subjects, two panes, and the one you are not in says its own state on its
  // tab rather than hiding it.
  const [pane, setPane] = useState<"files" | "rules">(rulesFor ? "rules" : "files");

  // What this PHONE will allow, asked of the phone rather than assumed — the
  // "install unknown apps" access is granted in Settings and can be taken back
  // there, so it is re-read whenever the sheet opens rather than remembered.
  const [caps, setCaps] = useState<InstallCaps>(NO_INSTALL);
  const [allow, setAllow] = useState<string[]>(() => readInstallAllow());
  useEffect(() => {
    let live = true;
    void installStatus().then((r) => { if (live) setCaps(r.caps); });
    return () => { live = false; };
  }, []);

  useEffect(() => pulls.subscribe(setRecords), []);
  // Ask the folder what it actually holds, once, when the sheet opens. Every
  // "saved to Downloads/…" below is otherwise a memory of something that
  // happened once and may since have been deleted — and the rows are read
  // precisely when somebody is looking for a file they cannot find.
  useEffect(() => { void pulls.verifyAllSaved(); }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load the config once per repoDir; `onLoadConfig` is a parent callback, not guaranteed stable
  useEffect(() => { if (repoDir) onLoadConfig(repoDir); }, [repoDir]);

  const cfg = configs.get(repoDir) ?? DEFAULT_AUTOPULL;
  const patch = (fields: Partial<AutoPullConfig>) => onSaveConfig(repoDir, { ...cfg, ...fields });

  // An EVICTED record is `done` — it was downloaded — but its bytes were
  // cleared, so listing it under "On this phone" is the one claim it must not
  // make. It belongs with the rows a tap would start, which is what it is.
  const active = records.filter((r) => r.state !== "done" || r.evicted);
  // Newest build on top — the one you came here for is the one just made.
  const finished = records.filter((r) => r.state === "done" && !r.evicted)
    .sort((a, b) => (b.item.mtime || b.item.ts) - (a.item.mtime || a.item.ts));
  // Repaint while anything is in flight or counting down a retry — see useTick.
  // Only on the pane that shows those rows: a 1 Hz re-render of the whole sheet
  // while somebody is editing patterns on the rules pane buys nothing and
  // fights the keyboard.
  useTick(active.length > 0 && pane === "files");
  const idle = pulls.whyIdle();
  const stuck = active.filter((r) => r.state === "paused" || r.state === "failed" || (r.state === "queued" && !!r.nextRetryAt));
  const have = active.reduce((n, r) => n + r.received, 0);
  const want = active.reduce((n, r) => n + (r.item.size || r.received), 0);
  // What keeps a download going when nobody is looking, and there are two
  // different answers. In a browser it is Background Fetch; in the APK it is
  // `ShellPullService` (`nativePull.ts`), which is the only thing that survives
  // Chromium freezing the document five minutes after the app is backgrounded.
  // Background Fetch is never used in the shell — the request would be
  // cross-origin — so the two are checked separately, and where NEITHER exists
  // the sheet says a transfer runs while the app is open rather than promising
  // otherwise.
  // Whether any row here can be installed at all, said once. `installIntroText`
  // answers null in a browser, which is what keeps this off every screen that
  // is not the Android shell.
  const installIntro = installIntroText(caps, allow);
  const bgCapable = (typeof navigator !== "undefined" && "serviceWorker" in navigator
    && "BackgroundFetchManager" in self && !hostBase()) || nativePullSupported();

  return (
    <div className="sheet">
      <SheetHead title={<><CloudDownload size={16} /> Downloads</>} onClose={onClose} />

      {/* The two questions this sheet answers — "where is my file" and "what
          gets fetched at all" — as two panes rather than three stacked sections.
          The file count is a COUNT ON A CONTROL and opens exactly those rows;
          the rules tab carries the master switch's STATE instead of a count, so
          "nothing is downloading because auto is off" is readable without
          opening it (`CLAUDE.md`). */}
      <div className="segmented">
        <button className={`seg ${pane === "files" ? "on" : ""}`}
          onClick={() => { setPane("files"); track("action:pull.pane.files"); }}>
          <Download size={14} /> files{records.length ? ` · ${records.length}` : ""}
        </button>
        <button className={`seg ${pane === "rules" ? "on" : ""}`} data-hint="pull.auto"
          onClick={() => { setPane("rules"); track("action:pull.pane.rules"); }}>
          <Settings size={14} /> rules · auto {auto ? "on" : "off"}
        </button>
      </div>

      {/* One scroll container for the whole sheet. Three sibling `.list`s each
          claiming `flex: 1` split the screen into competing panes, and the
          rules below them ended up squeezed to a few pixels with nothing to
          scroll — the settings were effectively unreachable on a phone. */}
      <div className="sheet-scroll">
      {pane === "files" ? (
      <>
      <Hint>
        Files a repo produces download to this phone on their own, resuming where they stopped.
        {!online && " Offline right now — queued files start when the link is back."}
      </Hint>
      {/* The install line, once, above the rows — and only where there is
          something to say: in a browser this whole subject is absent rather
          than explained. */}
      {installIntro && (
        <Hint>
          {installIntro}{" "}
          {caps.canInstall ? (
            <Button title="which of your apps install themselves"
              onClick={() => { track("action:pull.apps"); onOpenApps(); }}><Boxes size={14} /> apps</Button>
          ) : nativeInstallSupported() ? (
            <Button title="open the phone's install-unknown-apps setting"
              onClick={() => {
                track("action:pull.installSettings");
                void openInstallSettings().catch(() => showToast("this phone has no screen for that switch"));
              }}><Settings size={14} /> allow it</Button>
          ) : null}
        </Hint>
      )}
      <details className="hint-more">
        <summary>how this works</summary>
        <p>
          A rule per repo decides what is worth fetching; the queue below survives a dropped link, a
          reload, and the app being killed, and picks up from the byte it stopped at.
        </p>
        <p>
          {bgCapable
            ? "Downloads keep running with the app closed."
            : "This browser can't download in the background: transfers run while the app is open and resume when you come back."}
        </p>
      </details>

      {/* ── The queue ───────────────────────────────────────────── */}
      <div className="section">
        Downloading
        {active.length > 0 && (
          <span className="section-hint">
            {" "}· {active.length}
            {want > 0 && ` · ${fmtSize(have)} of ${fmtSize(want)}`}
          </span>
        )}
        <span className="head-acts">
          {stuck.length > 0 && (
            <button className="link-btn" onClick={() => { pulls.resumeAll(); track("action:pull.resumeall"); }}>
              <RotateCw size={12} /> resume all
            </button>
          )}
          {/* Clearing has two halves, because the queue has two sources: the
              host's own rules and this phone's taps (`download.ts`). Dismissing
              only the host's left every local row on screen — a button that
              visibly did nothing for exactly the rows this app adds most of.
              Bytes already here are never dropped by it. */}
          {records.length > 0 && (
            <button className="link-btn" data-hint="pull.clearall" onClick={() => {
              track("action:pull.clearall");
              for (const r of records) if (r.local && (r.state !== "done" || r.evicted)) void pulls.remove(r.item.id);
              onDismiss();
            }}><X size={12} /> clear queue</button>
          )}
        </span>
      </div>
      {/* Why nothing is moving. A stalled queue with no explanation is the exact
          state this sheet exists to make readable. */}
      {idle && <Hint tone="warn">{idle}</Hint>}
      <div className="list">
        {active.length === 0 && (
          <Empty>Nothing waiting. Files you tap to download land here, and so do the ones a repo's rule fetches on its own.</Empty>
        )}
        {active.map((r) => <PullRow key={r.item.id} rec={r} repos={repos} onDismiss={onDismiss} caps={caps} allow={allow}
              onAllow={(pkg) => { const next = toggleAllow(allow, pkg); setAllow(next); writeInstallAllow(next); }} />)}
      </div>

      {finished.length > 0 && (
        <>
          <div className="section">On this phone <span className="section-hint">· {finished.length}</span></div>
          <div className="list">
            {finished.map((r) => <PullRow key={r.item.id} rec={r} repos={repos} onDismiss={onDismiss} caps={caps} allow={allow}
              onAllow={(pkg) => { const next = toggleAllow(allow, pkg); setAllow(next); writeInstallAllow(next); }} />)}
          </div>
        </>
      )}

      </>
      ) : (
      <>
      {/* ── What this phone does with what arrives ───────────────── */}
      <div className="section">This phone <span className="section-hint">· the same on every repo</span></div>
      <div className="set-group">
        <SetLine>
          <Button className={auto ? "active" : ""}
            onClick={() => { const on = !auto; setAutoPull(on); setAuto(on); track("action:pull.auto"); }}>
            {auto ? <Check size={14} /> : <X size={14} />} auto-download: {auto ? "on" : "off"}
          </Button>
          <SetNote as="span">
            The master switch. Off, nothing is fetched without a tap — whatever the per-repo rules below say.
            {isNativeShell() ? "" : ` It is this browser's own: the ${BRAND.displayName} app keeps a separate one, so with the app on this phone too, off here means each file downloads once — in the app.`}
          </SetNote>
        </SetLine>

        {/* Where a finished download GOES. The save button on every row was a
            second step nobody wants to take 28 times, and taking it twice made a
            second copy rather than overwriting the first — so the hand-off is
            automatic and the rows say what the folder holds. */}
        <SetLine>
          <Button className={autoSave ? "active" : ""}
            onClick={() => { const on = !autoSave; setAutoSaveOut(on); setAutoSaveState(on); track("action:pull.autosave"); }}>
            {autoSave ? <Check size={14} /> : <X size={14} />} save to Downloads: {autoSave ? "automatic" : "on tap"}
          </Button>
          <SetNote as="span">
            {nativeSaveSupported()
              ? "Every file that finishes downloading is put in the phone's Downloads by itself. A file already there is left alone — saving it again would only add a copy beside it."
              : "In a browser the file is handed to the browser's own downloads, which it may refuse unless a tap asked for it — so here this only covers files you tapped."}
          </SetNote>
        </SetLine>

        {/* One copy, not two: once Downloads holds the file, this app's own
            copy is the same bytes again. APKs still install — the shell reads
            the Downloads copy. */}
        {isNativeShell() && (
          <SetLine>
            {dropCopy !== undefined && (
              <Button className={dropCopy ? "active" : ""}
                onClick={() => {
                  const on = !dropCopy;
                  track("action:pull.dropcopy");
                  void setNativeDropAfterSave(on).then(
                    () => setDropCopy(on),
                    (e: unknown) => showToast(`could not change it — ${e instanceof Error ? e.message : String(e)}`));
                }}>
                {dropCopy ? <Check size={14} /> : <X size={14} />} keep only the Downloads copy: {dropCopy ? "on" : "off"}
              </Button>
            )}
            <SetNote as="span">
              {dropCopy === undefined
                ? "Deleting this app's copy once a file is in Downloads needs a newer build of the app."
                : "Once a file is in Downloads, this app deletes its own copy. Apps still install from the Downloads copy; delete that one and the file has to be fetched again."}
            </SetNote>
          </SetLine>
        )}

        {/* Installing is its OWN screen — this is the pointer to it, on the
            settings pane where somebody looking for "which apps update
            themselves" will look for it. */}
        {nativeInstallSupported() && (
          <SetLine>
            <Button onClick={() => { track("action:pull.apps"); onOpenApps(); }}>
              <Boxes size={14} /> apps
            </Button>
            <SetNote as="span">
              Which of your apps install themselves when a new build lands here. {installIntro ?? ""}
            </SetNote>
          </SetLine>
        )}
      </div>

      {/* ── The rules ───────────────────────────────────────────── */}
      <div className="section">Rules <span className="section-hint">· per repo, stored with the project</span></div>
      <div className="form">
        <select className="search" value={repoDir} onChange={(e) => setRepoDir(e.target.value)}>
          {repos.map((r) => (
            <option key={r.worktreePath} value={r.worktreePath}>
              {r.repoName}{r.isPrimary ? "" : ` · ${r.branch}`}
            </option>
          ))}
        </select>
      </div>

      {repoDir && (
        <>
          <div className="set-group">
          <SetLine>
            <Button className={cfg.enabled ? "active" : ""}
              onClick={() => { patch({ enabled: !cfg.enabled }); track("action:pull.enable"); }}>
              {cfg.enabled ? <Check size={14} /> : <X size={14} />} auto-download: {cfg.enabled ? "on" : "off"}
            </Button>
            <SetNote as="span">Off means files from this repo are never fetched on their own — a file you tap to download still is, wherever you tap it.</SetNote>
          </SetLine>

          <SetLine>
            <RadioRows
              label="what auto-download watches"
              options={[{ key: "outbox", label: "outbox only" }, { key: "repo", label: "whole repo" }]}
              value={cfg.scope}
              onChange={(k) => patch({ scope: k })}
            />
            <SetNote as="span">
              The outbox (<span className="mono">.claude/outbox</span>) is the curated repo→phone drop. Whole-repo
              catches files an agent wrote anywhere, and is noisier by exactly that much.
            </SetNote>
          </SetLine>

          <SetLine>
            <Button className={cfg.builds ? "active" : ""} onClick={() => patch({ builds: !cfg.builds })}>
              build outputs: {cfg.builds ? "on" : "off"}
            </Button>
            <SetNote as="span">Also queue what a build button produces (the APK), wherever it lands.</SetNote>
          </SetLine>

          <SetLine>
            <Button className={cfg.supersede ? "active" : ""} data-hint="pull.supersede" onClick={() => { patch({ supersede: !cfg.supersede }); track("action:pull.supersede"); }}>
              newest only: {cfg.supersede ? "on" : "off"}
            </Button>
            <SetNote as="span">
              When a rebuilt version of a file already in the queue turns up, the older ones are dropped and a
              download in flight for them is cancelled — five APKs of the same build is 100+ MB spent on four
              files you don't want. A file already ON the phone is never deleted.
            </SetNote>
          </SetLine>

          <SetLine>
            {CAPS.map((c) => (
              <Button key={c} className={cfg.maxBytes === c ? "active" : ""} onClick={() => patch({ maxBytes: c })}>
                {capLabel(c)}
              </Button>
            ))}
            <SetNote as="span">Skip anything bigger. A phone should not silently pull a 2 GB tarball over a metered link.</SetNote>
          </SetLine>
          </div>

          <div className="section">Match <span className="section-hint">· empty = every file in the scope</span></div>
          <div className="list">
            {cfg.match.map((p) => (
              <Row key={p} kind="wrap">
                <span className="row grow"><RowTitle className="mono">{p}</RowTitle></span>
                <Button variant="danger" title="remove pattern" onClick={() => patch({ match: cfg.match.filter((x) => x !== p) })}>
                  <Trash2 size={16} />
                </Button>
              </Row>
            ))}
            {cfg.match.length === 0 && <Empty>No patterns — everything in the scope matches.</Empty>}
          </div>
          <div className="form">
            <input className="search mono" placeholder="Pattern, e.g. *.apk or report-*.md" value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addPattern(); }} />
            <SetLine>
              <Button disabled={!pattern.trim()} onClick={addPattern}><Plus size={14} /> add</Button>
              {PRESETS.map((p) => (
                <Button key={p.label} onClick={() => patch({ match: dedupe([...cfg.match, ...p.patterns]) })}>
                  {p.label}
                </Button>
              ))}
            </SetLine>
          </div>
        </>
      )}
      </>
      )}
      </div>
    </div>
  );

  function addPattern() {
    const p = pattern.trim();
    if (!p) return;
    patch({ match: dedupe([...cfg.match, p]) });
    setPattern("");
  }
}

const dedupe = (xs: string[]) => Array.from(new Set(xs));

/**
 * One download: what state it is in, how much of it is already on the phone,
 * whether it is moving, and what will happen next.
 *
 * The old row said `<repo> · <size>` and nothing else unless bytes were actively
 * arriving — so a queue sitting still (waiting out a backoff, paused, given up,
 * blocked by the auto switch) was indistinguishable from a broken button, and
 * "24.0 MB" never revealed that 18 of those MB were already downloaded. Every
 * line below exists to answer one of those.
 */
function PullRow({ rec, repos, onDismiss, caps, allow, onAllow }: {
  rec: PullRecord; repos: RepoTarget[]; onDismiss: (id?: string) => void;
  caps: InstallCaps; allow: string[]; onAllow: (pkg: string) => void;
}) {
  const { item, state, received, error, attempts, rate, nextRetryAt, wireBytes, evicted, saveError } = rec;
  const now = useTick(state === "downloading" || (state === "queued" && !!nextRetryAt));
  const repoLabel = item.repoName || repos.find((r) => r.id === item.repoId)?.repoName || "";
  const total = item.size || received;
  const pct = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
  const left = Math.max(0, total - received);
  const retryIn = nextRetryAt && nextRetryAt > now ? Math.ceil((nextRetryAt - now) / 1000) : 0;
  // "Stalled" is a claim about the link, so make it off the clock rather than
  // off a state flag: bytes stopped arriving while we still hold the stream.
  const quietFor = state === "downloading" && rec.lastProgressAt ? now - rec.lastProgressAt : 0;
  const stalled = quietFor > 12_000;

  const icon = state === "downloading" ? (stalled ? <CloudOff size={12} /> : <Loader size={12} className="spin" />)
    : state === "done" ? <Check size={12} />
      : state === "failed" ? <TriangleAlert size={12} />
        : state === "paused" ? <Pause size={12} />
          : <CloudDownload size={12} />;

  // The status line. One sentence, always present, always specific.
  let status: string;
  if (state === "downloading") {
    status = stalled
      ? `stalled at ${pct}% · ${fmtSize(received)} of ${fmtSize(total)} kept · retrying by itself`
      : `${pct}% · ${fmtSize(received)} of ${fmtSize(total)}`
        + (rate ? ` · ${fmtRate(rate)}` : "")
        + (rate && left > 0 ? ` · ${fmtEta(left / rate)} left` : "");
  } else if (state === "paused") {
    status = `paused · ${fmtSize(received)} of ${fmtSize(total)} kept · tap to resume`;
  } else if (state === "done") {
    // One vocabulary for "where is this file", shared with every download button
    // in the app (`downloadState.ts`) — including the two sentences only the
    // folder can answer: it is in Downloads, or it was and is not any more.
    status = evicted && rec.cleanedAt
      ? `installed · ${cleanedText(rec)}`
      : evicted
      ? "downloaded before · bytes cleared to save space · tap to fetch again"
      : downloadStatus(rec).detail;
  } else if (pullGone(rec)) {
    status = "the desktop no longer has this file · remove it";
  } else if (state === "failed") {
    status = `stopped at ${pct}%${received > 0 ? ` (${fmtSize(received)} kept)` : ""} · tap to retry`;
  } else if (retryIn) {
    status = `retrying in ${retryIn}s${received > 0 ? ` · resumes at ${fmtSize(received)} (${pct}%)` : ""}`;
  } else if (received > 0) {
    status = `waiting · ${fmtSize(received)} of ${fmtSize(total)} already here (${pct}%)`;
  } else {
    status = "waiting to start";
  }

  // Everything this row says about installing. The decisions are
  // `installPolicy.ts`'s — a browser gets none of it, a phone that has not
  // allowed installs gets a sentence and the Settings button, and the first
  // build of any app says in advance that it will ask.
  const installRow = {
    name: item.name, state, evicted,
    pkg: rec.pkg, pkgLabel: rec.pkgLabel, pkgVersion: rec.pkgVersion,
    install: rec.install, installError: rec.installError,
  };
  const offer = installOffer(installRow, caps);
  const installLine = installStatusText(installRow);
  const autoLine = autoInstallText(installRow, caps, allow);
  const allowSwitch = allowToggle(installRow, caps, allow);

  const showBar = total > 0 && received > 0 && state !== "done";
  const tap = () => {
    if (state === "done" && !evicted) {
      // A file the folder says is already there is not an offer to save: the
      // tap re-asks instead, which is the only thing left that can change the
      // sentence (somebody deleted it in a file manager while this was open).
      if (downloadAction(rec) === "save") { track("action:pull.save"); void saveNow(item.id); return; }
      track("action:pull.verify");
      void pulls.verifySaved(item.id);
      return;
    }

    track("action:pull.retry");
    pulls.retry(item.id);
  };

  return (
    <div className="row-wrap pull-row">
      <Row as="button" kind="grow" title={item.relPath} onClick={tap}>
        <RowTitle>{icon} {item.name}</RowTitle>
        <RowSub title={item.mtime ? `created ${fmtWhenFull(item.mtime)}${item.ts ? ` · queued ${fmtWhenFull(item.ts)}` : ""}` : undefined}>
          {/* Who asked for it. The auto switch, "clear queue" and the "nothing is
              moving" line all treat the two sources differently, so the row has
              to say which it is. */}
          {/* The name is resolved HERE as well as stored, because a row made
              from a cold-tapped notification is created before the repo listing
              has landed and would carry a blank one for ever. */}
          {/* The version the APK itself declares, spelled the way the Apps
              sheet's installed log spells it — a git hash in the file name
              cannot be matched against "Tiptoi 0.1.102" by eye. */}
          {rec.local ? "you" : "auto"} · {repoLabel ? `${repoLabel} · ` : ""}{rec.pkgVersion ? `${rec.pkgLabel || rec.pkg || "version"} ${rec.pkgVersion} · ` : ""}{fmtSize(total)}
        </RowSub>
        {/* One line about WHEN, not two. The row used to print `· 1m ago` here
            and `created 21 Sept, 11:21` underneath — the same instant, twice, a
            whole line of a phone screen apart. The stamp is the one that answers
            "which build is this" and the distance is the one that answers "is it
            fresh", so they share a line and the distance is dropped once it is
            only a coarser spelling of the date beside it. */}
        {item.mtime ? (
          <RowSub className="dim">created {fmtStamp(item.mtime)}{fmtAgo(item.mtime)}</RowSub>
        ) : null}
        <RowSub className={state === "failed" || stalled || (saveError && state === "done") ? "warn" : undefined}>{status}</RowSub>
        {showBar && (
          <span className="pull-bar"><span className={`pull-bar-fill ${state === "downloading" && !stalled ? "live" : ""}`} style={{ width: `${pct}%` }} /></span>
        )}
        {/* Failures are the reason a download is sitting still, so they belong on
            the row rather than in a console: "http 404" and "connection stalled"
            call for completely different reactions. */}
        {error && state !== "done" && (
          <RowSub className="dim">{error}{attempts > 1 ? ` · ${attempts} tries` : ""}</RowSub>
        )}
        {/* A save that failed is said ONCE. `downloadStatus().detail` above is
            already "on this phone — saving it out failed: …", so a second span
            repeating the same words in warn colour printed every failure twice —
            which is most of what made a finished row six lines tall. The colour
            moved onto the status line instead. */}
        {/* The install half. Three different claims, never one: how the last
            install went, what will happen to the NEXT build of this app, and —
            where the phone refuses — why, as a sentence rather than a dead
            button (`Unavailable.tsx`). */}
        {installLine && (
          <RowSub className={rec.install === "failed" ? "warn" : undefined}>{installLine}</RowSub>
        )}
        {offer.reason && <RowSub className="dim">{offer.reason}</RowSub>}
        {autoLine && autoLine !== offer.reason && <RowSub className="dim">{autoLine}</RowSub>}
        {state !== "done" && (wireBytes ?? 0) > received + 1024 && (
          <RowSub className="dim">{fmtSize(wireBytes ?? 0)} pulled over the link so far</RowSub>
        )}
      </Row>

      {/* ── What you can do to it ──────────────────────────────────
          A STRIP under the text, with WORDS on the buttons.

          Two failures at once before this. `.row-wrap` is `align-items:
          stretch`, so four icon buttons beside a text button that had grown to
          eight lines drew four full-height grey columns — the row read as a
          table of empty cells and the icons drifted further from the text the
          more the row had to say. And every one of them was an icon alone with
          a `title`: on a phone there is no hover, so a package-with-a-plus and a
          package-with-a-tick sat side by side with nothing to tell them apart
          (`CLAUDE.md`: a title is invisible here). The live session row solved
          exactly this, exactly this way — see `.row-acts` in `styles.css`. */}
      <div className="row-acts pull-acts">
        {/* Only the transfer THIS page owns can be paused: `pause()` acts on the
            running range fetch, and a Background Fetch belongs to the browser —
            offering the button there stopped some other row instead. */}
        {state === "downloading" && rec.engine !== "bgfetch" && (
          <Button data-hint="pull.pause" title="pause (keeps what has downloaded)"
            onClick={() => { track("action:pull.pause"); pulls.pause(item.id); }}><Pause size={16} /> pause</Button>
        )}
        {state === "paused" && (
          <Button data-hint="pull.retry" title="resume from where it stopped"
            onClick={() => { track("action:pull.retry"); pulls.retry(item.id); }}><Play size={16} /> resume</Button>
        )}
        {(state === "queued" || state === "failed") && (
          <Button title={received > 0 ? "resume now" : "download now"}
            onClick={() => { track("action:pull.retry"); pulls.retry(item.id); }}>
            <RotateCw size={16} /> {received > 0 ? "resume" : "download"}
          </Button>
        )}
        {/* Put this build on the phone. The first one of any app opens the system
            installer — that is the platform's rule and the row says so above
            rather than promising a silence it cannot deliver. */}
        {offer.verb === "install" && (
          <Button variant="primary" title={`install ${item.name} on this phone`}
            onClick={() => {
              track("action:pull.install");
              void nativeInstall(item.id).catch((e: unknown) => showToast(e instanceof Error ? e.message : "could not start the install"));
            }}>
            {rec.install === "failed" ? <RotateCw size={16} />
              : rec.install === "installed" ? <PackageCheck size={16} /> : <PackagePlus size={16} />}
            {installVerbText(rec.install)}
          </Button>
        )}
        {/* The per-app switch: every future build of THIS package, by itself.
            Drawn only where the package could be read — a promise about "this
            app" has to know which app it is about. The word is the sheet's own
            vocabulary ("auto-download: on") rather than a fifth way of saying
            the same thing. */}
        {allowSwitch && (
          <Button className={allowSwitch.on ? "active" : ""} title={allowSwitch.label}
            onClick={() => { track("action:pull.installAuto"); onAllow(allowSwitch.pkg); }}>
            <PackageCheck size={16} /> auto-install: {allowSwitch.on ? "on" : "off"}
          </Button>
        )}
        {/* The one refusal a tap can fix. */}
        {offer.settings && (
          <Button title="open the phone's install-unknown-apps setting"
            onClick={() => {
              track("action:pull.installSettings");
              void openInstallSettings().catch(() => showToast("this phone has no screen for that switch"));
            }}><Settings size={16} /> allow installs</Button>
        )}
        {/* Offered only when saving is a thing that would change something. A
            file the folder confirms is THERE gets no button — MediaStore renames
            rather than overwrites, so that tap made `app-debug (6).apk` beside
            the five before it, and the row's own sentence says where the file is
            (never a greyed-out button: see `Unavailable.tsx`). */}
        {state === "done" && !evicted && downloadAction(rec) === "save" && (
          <Button title="put it where a file manager can see it"
            onClick={() => { track("action:pull.save"); void saveNow(item.id); }}><Save size={16} /> save to phone</Button>
        )}
        {/* A row this device asked for (`download.ts`) is not in the host's queue,
            so telling the host to drop it names an id it has never heard of.
            A finished row holds the only copy of those bytes on this phone, and a
            re-fetch costs the whole file over the link that made it worth queueing
            — so that one arms (`Confirm.tsx`) like every other deliberate delete
            here. A row still waiting has nothing to lose. */}
        {state === "done" && !evicted ? (
          <ConfirmButton className="key danger" title="delete the downloaded file from this phone"
            confirmTitle="tap again to delete these bytes"
            onConfirm={() => { void pulls.remove(item.id); if (!rec.local) onDismiss(item.id); showToast(`deleted ${item.name} from this phone`); }}>
            <Trash2 size={16} /> delete
          </ConfirmButton>
        ) : (
          <Button variant="danger" title="remove from the queue (and delete any bytes already fetched)"
            onClick={() => { void pulls.remove(item.id); if (!rec.local) onDismiss(item.id); }}><Trash2 size={16} /> remove</Button>
        )}
      </div>
    </div>
  );
}

/**
 * The strip shown alongside the send-queue bars while anything is coming DOWN.
 * Same visual language on purpose: both say "work is in flight that you did not
 * have to watch", and putting the incoming half somewhere else would mean
 * nobody sees it.
 */
export function PullBar({ records, onOpen, onRemove }: {
  records: PullRecord[]; onOpen: () => void;
  /** Drop these stopped rows — the strip's own way out, so a dead download
   *  is not a standing bar until someone finds the sheet's row. */
  onRemove?: (rows: PullRecord[]) => void;
}) {
  const active = stripRows(records, autoPull());
  const now = useTick(active.length > 0);
  if (!active.length) return null;
  const running = active.find((r) => r.state === "downloading");
  const failed = active.filter((r) => r.state === "failed");
  const paused = active.filter((r) => r.state === "paused");
  // Everything left of the button describes the RUNNING file; the queue total is
  // its own clause. Gluing the two together ("emu-05-dialog.png · 0% · 21.2 MB
  // left") stated the whole queue's byte count as that file's size — the png is
  // 215 KB — and left the 0% pointing at a number it has nothing to do with.
  const queueLeft = active.reduce((n, r) => n + Math.max(0, (r.item.size || 0) - r.received), 0);
  const runTotal = running ? running.item.size || running.received : 0;
  const runLeft = running ? Math.max(0, runTotal - running.received) : 0;
  const pct = running && runTotal > 0 ? Math.floor((running.received / runTotal) * 100) : 0;
  // Read off the clock, exactly like the sheet's row: a spinner over a stream
  // that has not moved in 12 s says the opposite of what is happening, and a
  // download parked at 0% is precisely when this strip is worth reading.
  const stalled = !!running && now - (running.lastProgressAt ?? running.updatedAt) > 12_000;
  const rest = active.length - (running ? 1 : 0);
  const queueTail = queueLeft > 0 ? ` · ${fmtSize(queueLeft)} left` : "";
  return (
    /* `pull-strip` marks it as the INCOMING half of the strip: it is pure
       progress, carrying no verdict and no action but its own sheet, which is
       what lets typing room hide it while the send-queue bars — receipts, with
       Restore and Manage on them — stay.

       NOT `pull-bar`, which is the 3px progress bar on a row above (line ~429).
       It was, and the two rules are 1500 lines apart in one stylesheet: the
       marker silently picked up `display: block`, `height: 3px` and — the one
       that did the damage — `flex: 0 0 100%`. In the launcher's flex COLUMN a
       100% basis is 100% of the column's HEIGHT, and `flex-shrink: 0` means it
       does not give any of it back, so this strip claimed the whole screen and
       the repo list had nowhere to render. Reopening the app did not help: the
       download is still in the queue, so the strip is still mounted. */
    <div className={`outbox-recover pull-strip ${failed.length || stalled ? "failed" : running ? "sending" : "queued"}`}>
      {running ? (stalled ? <CloudOff size={14} /> : <Loader size={14} className="spin" />) : failed.length ? <TriangleAlert size={14} /> : paused.length ? <Pause size={14} /> : <CloudDownload size={14} />}
      <span>
        {running
          // Numbers lead and the name trails: the strip is one ellipsised line
          // (`.pull-strip > span`), and a clipped file name loses nothing the
          // sheet does not name, where a clipped "74% · 2 MB left" lost the point.
          ? `${stalled ? `stalled at ${pct}%` : `${pct}%`}`
            + (runLeft > 0 ? ` · ${fmtSize(runLeft)} left` : "")
            + (!stalled && running.rate ? ` · ${fmtRate(running.rate)}` : "")
            + (rest > 0 ? ` · +${rest} more (${fmtSize(queueLeft)})` : "")
            + ` · ${running.item.name}`
          : failed.length
            ? failed.every(pullGone)
              ? `${failed.length} download${failed.length > 1 ? "s" : ""} no longer on the desktop`
              : `${failed.length} download${failed.length > 1 ? "s" : ""} stopped${queueTail}`
            : paused.length === active.length
              ? `${paused.length} download${paused.length > 1 ? "s" : ""} paused${queueTail}`
              : `${active.length} file${active.length > 1 ? "s" : ""} to download${queueTail}`}
      </span>
      {!running && failed.length > 0 && onRemove && (failed.some((r) => r.received > 0)
        ? <ConfirmButton className="key" title="remove the stopped downloads, and the bytes they kept"
            confirmTitle="tap again to drop them and their kept bytes" onConfirm={() => onRemove(failed)}>
            <X size={14} /> remove
          </ConfirmButton>
        : <Button title="remove the stopped downloads from the queue"
            onClick={() => onRemove(failed)}><X size={14} /> remove</Button>)}
      <Button onClick={onOpen}><Download size={14} /> Downloads</Button>
    </div>
  );
}

const onAndroid = () => typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

/**
 * The one-time question a browser tab asks when it starts fetching on its own:
 * is the app on this phone too? Each WebView keeps its own auto-download
 * switch, so a browser and the APK side by side both fetch every build — and
 * the browser cannot see the APK, so it asks (`browserPullAsk`). Rendered under
 * the download strip, where the doubled transfer is already on screen.
 *
 * *app only* turns auto-download off HERE and pauses the automatic transfer
 * already running here (the switch alone would let it finish). Either answer
 * is final, and both toasts name where the switch lives.
 */
export function PullBrowserAsk({ records }: { records: PullRecord[] }) {
  const [answered, setAnswered] = useState(() => lsGet(LS.pullBrowserAsk) === "1");
  if (!browserPullAsk({ native: isNativeShell(), android: onAndroid(), auto: autoPull(), answered, records })) return null;
  const answer = (appOnly: boolean) => {
    lsSet(LS.pullBrowserAsk, "1");
    setAnswered(true);
    if (!appOnly) {
      track("action:pull.browserask.keep");
      showToast("Auto-download stays on in this browser. Downloads › rules has the switch.");
      return;
    }
    track("action:pull.browserask.apponly");
    const running = records.filter((r) => !r.local && r.state === "downloading");
    setAutoPull(false);
    for (const r of running) pulls.pause(r.item.id);
    showToast(`Auto-download is off in this browser${running.length ? ` and ${running.length === 1 ? running[0].item.name : `${running.length} downloads`} paused here` : ""} — the app fetches them. Downloads › rules turns it back on.`);
  };
  return (
    <div className="outbox-recover ask">
      <Smartphone size={14} />
      <span>Auto-download in this browser too? If the {BRAND.displayName} app is on this phone, it already fetches these — keep both on and every file downloads twice.</span>
      <Button onClick={() => answer(true)}
        title="turn auto-download off in this browser only — the app keeps fetching">
        <Smartphone size={14} /> off — app has it
      </Button>
      <Button onClick={() => answer(false)}
        title="keep auto-download on in this browser">
        <Download size={14} /> keep on — no app
      </Button>
    </div>
  );
}
