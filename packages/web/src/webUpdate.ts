/**
 * Over-the-air updates for the Android shell — the half that isn't Java.
 *
 * The APK carries the UI so a dead tunnel cannot take the app away
 * (`packages/app`). Left alone, that would freeze the UI at APK build time and
 * every web change would mean sideloading a new APK. So the app asks the daemon
 * what it is serving, downloads the difference, and hands the files to the
 * native plugin, which points Capacitor's WebView at them.
 *
 * Everything interesting is here rather than in Java on purpose: the version
 * check, the transfer, the hashing and the retry policy are all things worth
 * reading and changing without an Android toolchain in the way, and they reuse
 * the app's own host-address handling. The plugin does only what a WebView
 * cannot: write files, choose a serving directory, and survive a restart.
 *
 * Three rules the shape of this file comes from:
 *
 *  - **A bundle is verified before it can replace a working app.** Every file's
 *    sha256 is checked against the manifest, and a mismatch aborts the whole
 *    update rather than landing a half-good bundle. This is protection against a
 *    truncated transfer on a bad link, NOT against a hostile host — the daemon
 *    already runs `claude` on your machine, so it is trusted by construction
 *    (SECURITY.md). It is only ever the host the user paired with.
 *  - **Nothing is applied while you are looking at it.** A finished download is
 *    *staged*: it takes effect the next time the app is started cold. This is a
 *    remote control for live sessions, and reloading the page mid-turn to install
 *    an update nobody asked for is worse than waiting. What "cold" means is the
 *    part worth stating: a phone app is rarely restarted deliberately, so a
 *    staged build used to sit there for days while the button that would take it
 *    was on a settings screen nobody had a reason to open. So the restart is
 *    automatic too (`autoApply`, on by default) and it is timed off VISIBILITY —
 *    the app is reloaded once it has been put down, never under a screen someone
 *    is reading. `watchAutoApply()` below is the whole rule.
 *  - **The build id is the bundle's own.** `build-id.txt` ships inside every
 *    bundle, so "which build am I running?" is answered by reading a file from
 *    whatever bundle is being served — APK or download — instead of by
 *    bookkeeping that can get out of step with reality.
 */
import { isNativeShell } from "./hostUrl";
import { isDemo } from "./demo/mode";
import { nativePlugin } from "./shellBridge";
import { LS, lsDel, lsGet, lsJson, lsSet, lsSetJson } from "./storage";
import { api, bgFetch } from "./api";
import { armRouteResume } from "./resumeRoute";
import { showToast } from "./toast";
import { cleanBuildStamp, type BuildStamp } from "@waterplane/shared";
import { shellStampOf } from "./buildVersionWords";

/** One file in the daemon's bundle manifest (host/webbundle.ts). */
interface BundleFile {
  path: string;
  size: number;
  sha256: string;
}

interface BundleManifest {
  ok: boolean;
  buildId: string | null;
  files: BundleFile[];
  total: number;
  reason?: string;
}

export type UpdatePhase =
  | "unsupported"   // not the Android shell — the PWA updates via the service worker
  | "unavailable"   // the host cannot serve a bundle (no build, no build-id.txt)
  | "idle"          // up to date as far as we know
  | "checking"
  | "downloading"
  | "staged"        // downloaded and verified; takes effect on restart
  | "held"          // the host's build already failed to start on this phone; not taken again unasked
  | "error";

export interface UpdateStatus {
  phase: UpdatePhase;
  /** Build id we are running right now. */
  current: string | null;
  /** Build id the host is serving. */
  available: string | null;
  /** Build id already downloaded and waiting for a restart. */
  stagedId: string | null;
  /** Files done / total and bytes done / total, while downloading. */
  progress?: { files: number; totalFiles: number; bytes: number; totalBytes: number };
  /** Populated for `error`, the host's explanation for `unavailable`, or why
   *  the build is `held` (what the native fallback recorded). */
  message?: string;
  /** When the host last actually answered a check — not when one was last
   *  attempted, so "up to date" carries a clock a person can distrust. */
  lastCheckedAt: number | null;
}

/** What the native side itself knows — `ShellUpdatePlugin.info()`, unpacked. */
export interface NativeUpdateInfo {
  /** Serving the APK's own bundled copy, as opposed to a downloaded one. */
  builtIn: boolean;
  /** Absolute path of the bundle actually being served right now. */
  basePath: string;
  /** The APK's own version — a different fact from the web bundle's build id:
   *  OTA never touches it, so it is what answers "is the SHELL current?" */
  versionName: string;
  versionCode: number;
  /** The build the shell fell back from and still refuses to stage unasked
   *  ("" when none, or an APK that predates the mark), and why. */
  badBuild: string;
  badReason: string;
  /** When the shell last fell back to its built-in bundle by itself; 0 never. */
  lastRecoveryAt: number;
  /** Which build of the SHELL this is — version, commit, build time (`shellStampOf`); null from an
   *  APK that predates the stamp. */
  shell: BuildStamp | null;
}

type Listener = (s: UpdateStatus) => void;

const LS_AUTO = LS.webUpdateAuto;
const LS_STAGED = LS.webUpdateStaged;
const LS_APPLY = LS.webUpdateApply;
const LS_TRIES = LS.webUpdateApplyTries;
const LS_SEEN = LS.webUpdateRecoverySeen;
/** Put down for this long ⇒ the reload is invisible, so take the staged build. */
const APPLY_HIDDEN_MS = 20_000;
/** Away for this long ⇒ coming back IS the app starting; reload on the way in.
 *  This is the case a backgrounded WebView's frozen timers leave behind. */
const APPLY_AWAY_MS = 2 * 60_000;
/** How many times one build may restart the app without ever becoming the
 *  running build. Past this it is a bundle that stages and does not serve, and
 *  retrying it forever would reload the app every time it is pocketed. The
 *  native boot watchdog handles the other failure (it starts and never renders);
 *  this handles the one it cannot see. */
const APPLY_MAX_TRIES = 2;
/** What the update screen says in the demo, where there is no desktop to ask. */
export const DEMO_NO_UPDATE = "Not in the demo — updates come from your own desktop's host.";

/** Base64 conversion chunk. Large enough to be fast, small enough that
 *  `String.fromCharCode(...)` never blows the argument limit on a ~900 KB file. */
const B64_CHUNK = 8192;

/** The native plugin, or null in the browser. Reached through the global
 *  Capacitor exposes rather than an npm import, so `packages/web` gains no
 *  dependency for a feature only the APK can use — and through `shellBridge`,
 *  so a shell of either identity (`ShellUpdate`, or a legacy APK's name) is
 *  found. */
function plugin(): Record<string, (opts?: unknown) => Promise<any>> | null {
  const p = nativePlugin<Record<string, (opts?: unknown) => Promise<any>>>("Update");
  return p && typeof p.info === "function" ? p : null;
}

export function updateSupported(): boolean {
  return isNativeShell() && plugin() !== null;
}

/** Auto-download new bundles in the background. On by default: the point of the
 *  feature is not having to think about it. Off leaves the check and the button. */
export function autoUpdate(): boolean {
  return lsGet(LS_AUTO) !== "0";
}
export function setAutoUpdate(on: boolean): void {
  lsSet(LS_AUTO, on ? "1" : "0");
  updates.emit();
}

/** Restart into a staged build by itself, once the app has been put down. On by
 *  default for the same reason auto-download is: a build that needs a settings
 *  screen and a tap to take effect is one most phones never take. Off leaves the
 *  staged marker and the "restart into it" button exactly as they were. */
export function autoApply(): boolean {
  return lsGet(LS_APPLY) !== "0";
}
export function setAutoApply(on: boolean): void {
  lsSet(LS_APPLY, on ? "1" : "0");
  updates.emit();
}

/** Per-build count of auto-restarts that did not result in that build running. */
function applyTries(id: string): number {
  const raw = lsJson<{ id?: string; n?: number } | null>(LS_TRIES, null);
  return raw && raw.id === id && typeof raw.n === "number" ? raw.n : 0;
}
function noteApplyTry(id: string): void {
  lsSetJson(LS_TRIES, { id, n: applyTries(id) + 1 });
}
function clearApplyTries(): void {
  lsDel(LS_TRIES);
}

class UpdateManager {
  private status: UpdateStatus = {
    phase: updateSupported() ? "idle" : "unsupported",
    current: null,
    available: null,
    stagedId: lsGet(LS_STAGED),
    lastCheckedAt: null,
  };
  private listeners = new Set<Listener>();
  private busy = false;
  /** When the page went hidden, and the timer armed for it. */
  private hiddenAt = 0;
  private applyTimer: ReturnType<typeof setTimeout> | null = null;
  /** `applyNow()` reloads the WebView, so this is only ever cleared by an error. */
  private applying = false;

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    cb(this.status);
    return () => { this.listeners.delete(cb); };
  }

  emit(): void {
    for (const cb of this.listeners) cb(this.status);
  }

  get(): UpdateStatus { return this.status; }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit();
  }

  /**
   * Tell the native side the UI is alive, which clears the boot-failure counter
   * that would otherwise fall back to the APK's built-in bundle after three
   * launches. Called once from `main.tsx` after the first render — the whole
   * point is that it happens only when React actually got that far.
   *
   * Also reconciles the staged marker: if what we are running IS what was
   * staged, the update landed and the marker is stale.
   */
  async markHealthy(): Promise<void> {
    const p = plugin();
    if (!p) return;
    try { await p.markHealthy(); } catch { /* best effort */ }
    void this.sayFallback();
    const current = await runningBuildId();
    this.set({ current });
    if (current && this.status.stagedId === current) {
      lsDel(LS_STAGED);
      clearApplyTries();
      this.set({ stagedId: null, phase: "idle" });
    }
  }

  /**
   * Say once that the shell abandoned a build by itself. The native toast
   * (`ShellUpdatePlugin.fallBack`) only covers the in-process deadline and is
   * gone in seconds; a fallback decided at launch has no screen to say it on.
   */
  private async sayFallback(): Promise<void> {
    const n = await nativeInfo();
    if (!n || !n.lastRecoveryAt) return;
    if (Number(lsGet(LS_SEEN) ?? 0) >= n.lastRecoveryAt) return;
    lsSet(LS_SEEN, String(n.lastRecoveryAt));
    const what = n.badBuild ? `Build ${n.badBuild.slice(0, 8)}` : "A downloaded build";
    showToast(`${what} did not start${n.badReason ? ` (${n.badReason})` : ""}, so the app went back to the build inside it. It takes the desktop's next build as usual.`);
  }

  /**
   * The automatic half of "restart into it": watch VISIBILITY and take a staged
   * build the moment nobody is looking.
   *
   * Two triggers, because a backgrounded WebView is not a running one. The first
   * is the honest case — hidden for `APPLY_HIDDEN_MS`, timer still ticking, the
   * reload happens off screen and the app is simply new when it is picked up.
   * The second covers the phone that froze our timers the instant the screen
   * went off: coming back after `APPLY_AWAY_MS` is indistinguishable from
   * starting the app, so the reload is taken on the way IN, where it reads as a
   * launch rather than as the screen being pulled away.
   *
   * Nothing here decides whether a build is worth taking — that is `check()` and
   * `download()`. This only decides *when*.
   */
  watchAutoApply(): () => void {
    if (!updateSupported()) return () => { /* browser: the service worker does this */ };
    const onVis = () => {
      this.clearApplyTimer();
      if (document.visibilityState === "hidden") {
        this.hiddenAt = Date.now();
        this.armApply(APPLY_HIDDEN_MS);
      } else {
        const away = this.hiddenAt ? Date.now() - this.hiddenAt : 0;
        this.hiddenAt = 0;
        if (away >= APPLY_AWAY_MS) void this.autoApply();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    if (document.visibilityState === "hidden") onVis();
    return () => { document.removeEventListener("visibilitychange", onVis); this.clearApplyTimer(); };
  }

  private clearApplyTimer(): void {
    if (this.applyTimer !== null) { clearTimeout(this.applyTimer); this.applyTimer = null; }
  }

  /** Arm the put-down restart. Called on hiding, and again when a download
   *  finishes — a bundle that staged while the app was already in a pocket gets
   *  no further `visibilitychange` to hang off. */
  private armApply(delay: number): void {
    if (!autoApply()) return;
    this.clearApplyTimer();
    this.applyTimer = setTimeout(() => { this.applyTimer = null; void this.autoApply(); }, delay);
  }

  /** Take the staged build unasked, or decline with a reason that is a fact
   *  about state rather than about the user's preference alone. */
  private async autoApply(): Promise<void> {
    if (!autoApply() || this.applying || this.busy) return;
    const id = this.status.stagedId;
    if (this.status.phase !== "staged" || !id || id === this.status.current) return;
    if (applyTries(id) >= APPLY_MAX_TRIES) return;
    this.applying = true;
    noteApplyTry(id);
    await this.applyNow();
    // Only reached when the plugin refused — `applyNow` reloads on success.
    this.applying = false;
  }

  /**
   * Ask the host what it is serving. Cheap enough to run on every reconnect —
   * the manifest is a few hundred bytes and the host caches its hashes against
   * the tree's mtimes.
   */
  async check(): Promise<UpdateStatus> {
    if (!updateSupported()) return this.status;
    // Refused in the demo — but `markHealthy` above still runs (main.tsx), or
    // the native watchdog would roll the bundle back after three demo boots.
    if (isDemo()) { this.set({ phase: "unavailable", message: DEMO_NO_UPDATE }); return this.status; }
    if (this.busy) return this.status;
    this.set({ phase: "checking", message: undefined });
    try {
      const current = this.status.current ?? (await runningBuildId());
      const m = await api.webBundle.manifest<BundleManifest>();
      if (!m) throw new Error("the host did not answer");
      if (!m.ok || !m.buildId) {
        this.set({ phase: "unavailable", current, available: null, message: m.reason || "the host cannot serve a bundle", lastCheckedAt: Date.now() });
        return this.status;
      }
      this.set({ current, available: m.buildId, lastCheckedAt: Date.now() });
      const held = m.buildId === current ? null : await heldBuild(m.buildId);
      if (m.buildId === current) {
        this.set({ phase: "idle" });
      } else if (held !== null) {
        // The shell fell back from exactly this build. Downloading it again is
        // what turned one white screen into a loop: staged, restarted into on
        // the next pocketing, blank again. Wait for a different build, or for
        // the person to ask for this one by hand (`download(true)`).
        this.unstage(m.buildId);
        this.set({ phase: "held", message: held });
      } else if (m.buildId === this.status.stagedId) {
        // Already downloaded on an earlier run; just waiting for a restart.
        this.set({ phase: "staged" });
      } else {
        this.set({ phase: "idle" });
        if (autoUpdate()) void this.download();
      }
      return this.status;
    } catch (e) {
      this.set({ phase: "error", message: msg(e) });
      return this.status;
    }
  }

  /**
   * Fetch every file of the host's current bundle, verify it, write it, and stage
   * the result.
   *
   * Deliberately downloads the WHOLE bundle rather than only changed files: it is
   * under a megabyte, Vite content-hashes the asset names so the big ones change
   * on any real edit anyway, and a bundle assembled out of two builds is a
   * failure mode nobody wants to debug on a phone.
   */
  async download(force = false): Promise<void> {
    const p = plugin();
    if (!p || this.busy) return;
    if (isDemo()) { this.set({ phase: "unavailable", message: DEMO_NO_UPDATE }); return; }
    this.busy = true;
    try {
      const m = await api.webBundle.manifest<BundleManifest>();
      if (!m) throw new Error("the host did not answer");
      if (!m.ok || !m.buildId) throw new Error(m.reason || "no bundle on the host");
      const id = m.buildId;

      this.set({
        phase: "downloading",
        available: id,
        progress: { files: 0, totalFiles: m.files.length, bytes: 0, totalBytes: m.total },
      });

      await p.beginBundle({ id });
      let bytes = 0;
      for (let i = 0; i < m.files.length; i++) {
        const f = m.files[i];
        // `v` is the build id, so the URL changes when the build does — the host
        // can answer 304 for a file this device already revalidated.
        const fr = await api.webBundle.file(f.path, id);
        if (!fr.ok) throw new Error(`${f.path}: ${fr.status}`);
        const buf = await fr.arrayBuffer();
        const got = await sha256Hex(buf);
        if (got !== f.sha256) {
          // Abort the whole update. A per-file retry would be kinder on a bad
          // link, but a bundle mixed from two builds is worse than no update.
          throw new Error(`${f.path} arrived corrupted`);
        }
        await p.writeFile({ id, path: f.path, dataBase64: toBase64(buf) });
        bytes += buf.byteLength;
        this.set({ progress: { files: i + 1, totalFiles: m.files.length, bytes, totalBytes: m.total } });
      }
      await p.finishBundle({ id });
      try {
        await p.stage({ id, force });
      } catch (e) {
        // The shell refuses a build that already failed here unless asked by
        // hand — `check()` normally stops before downloading it at all.
        if ((e as { code?: string })?.code === "BAD_BUILD") {
          this.unstage(id);
          this.set({ phase: "held", message: msg(e), progress: undefined });
          return;
        }
        throw e;
      }
      lsSet(LS_STAGED, id);
      // From here on the next start is a different bundle, whether it comes from
      // `applyNow` below or from the app being opened cold days later — and a
      // bundle swap reloads the WebView at its bare start URL, losing the route.
      // Armed at STAGING rather than at apply for exactly that second case.
      armRouteResume();
      this.set({ phase: "staged", stagedId: id, progress: undefined });
      // Staged while the app is already down: no visibility change is coming.
      if (document.visibilityState === "hidden") this.armApply(APPLY_HIDDEN_MS);
    } catch (e) {
      this.set({ phase: "error", message: msg(e), progress: undefined });
    } finally {
      this.busy = false;
    }
  }

  /** Forget a staged marker for a build the shell will not serve. */
  private unstage(id: string): void {
    if (this.status.stagedId !== id) return;
    lsDel(LS_STAGED);
    clearApplyTries();
    this.set({ stagedId: null });
  }

  /** Switch to the staged bundle right now. Reloads the WebView. */
  async applyNow(): Promise<void> {
    const p = plugin();
    const id = this.status.stagedId;
    if (!p || !id) return;
    // A build staged before the demo was entered waits for the real app.
    if (isDemo()) { this.set({ message: DEMO_NO_UPDATE }); return; }
    // Re-armed rather than assumed: staging may have happened on an earlier run
    // whose arm a boot in between has already spent.
    armRouteResume();
    try { await p.applyNow({ id }); } catch (e) { this.set({ phase: "error", message: msg(e) }); }
  }

  /** Back to the bundle inside the APK — the manual twin of the boot watchdog. */
  async revertToBuiltIn(): Promise<void> {
    const p = plugin();
    if (!p) return;
    lsDel(LS_STAGED);
    clearApplyTries();
    this.set({ stagedId: null, phase: "idle" });
    // A revert is a bundle swap too — it reloads the WebView the same way.
    armRouteResume();
    try { await p.revertToBuiltIn(); } catch (e) { this.set({ phase: "error", message: msg(e) }); }
  }
}

export const updates = new UpdateManager();

/**
 * Which build is being served to us right now.
 *
 * `/build-id.txt` is part of the bundle and is NOT one of the paths the native
 * shell re-aims at the host (`shared/hosturl.ts` only ever re-aims `/api` and
 * `/ws`), so this reads the running bundle's own id — which is the entire reason
 * the file is shipped inside the bundle rather than reported by the host.
 */
/**
 * What the native plugin itself reports — the one fact that settles "did the
 * bundle I am reading about actually land on this phone" without guessing
 * from `current`/`available`/`stagedId` bookkeeping. Null off the plugin (in
 * the browser, or an old APK that predates it) rather than a fabricated
 * "unknown" object.
 */
export async function nativeInfo(): Promise<NativeUpdateInfo | null> {
  const p = plugin();
  if (!p) return null;
  try {
    const r = await p.info();
    return {
      builtIn: !!r.builtIn,
      basePath: typeof r.basePath === "string" ? r.basePath : "",
      versionName: typeof r.versionName === "string" ? r.versionName : "",
      versionCode: typeof r.versionCode === "number" ? r.versionCode : 0,
      badBuild: typeof r.badBuild === "string" ? r.badBuild : "",
      badReason: typeof r.badReason === "string" ? r.badReason : "",
      lastRecoveryAt: typeof r.lastRecoveryAt === "number" ? r.lastRecoveryAt : 0,
      shell: shellStampOf(r),
    };
  } catch {
    return null;
  }
}

/** Why the shell will not take `id` unasked, or null when it will. */
async function heldBuild(id: string): Promise<string | null> {
  const n = await nativeInfo();
  if (!n || n.badBuild !== id) return null;
  return `build ${id.slice(0, 8)} did not start on this phone${n.badReason ? ` (${n.badReason})` : ""}, so the app went back to the build inside it`;
}

export async function runningBuildId(): Promise<string | null> {
  try {
    // The bundle's OWN id, read out of the bundle — deliberately not an
    // `/api` path, so `hostUrl.ts` never re-aims it at the host.
    const r = await bgFetch("/build-id.txt", { cache: "no-store" });
    if (!r.ok) return null;
    const id = (await r.text()).trim();
    return /^[a-f0-9]{8,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Which build of the web bundle is running, in words (`dist/buildstamp.json`, written beside
 *  `build-id.txt` by the web build and read the same way, out of the bundle itself). Null from a
 *  bundle built before the stamp. */
export async function runningBuildStamp(): Promise<BuildStamp | null> {
  try {
    const r = await bgFetch("/buildstamp.json", { cache: "no-store" });
    if (!r.ok) return null;
    return cleanBuildStamp(await r.json());
  } catch {
    return null;
  }
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** ArrayBuffer → base64, chunked: `fromCharCode` takes its input as arguments,
 *  and a ~900 KB bundle file would blow the argument limit in one call. */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(s);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
