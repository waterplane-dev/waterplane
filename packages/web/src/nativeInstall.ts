/**
 * **Installing a downloaded build** — the Android-shell half.
 *
 * `installPolicy.ts` keeps every decision (which app may install itself, what a
 * row says, what a refusal reads like); this passes four verbs across and hands
 * back what the PHONE will allow, which is the one thing the page cannot work
 * out for itself.
 *
 * Two rules, both borrowed from `nativePull.ts` and both for the same reason:
 *
 *  - **The verdict lives on the pull row, not here.** An install starts at the
 *    end of a download that runs in a service precisely so it does not need the
 *    page — a frozen document runs no tasks — and it finishes at a broadcast
 *    receiver some time after that. So `install()` answers "it has been asked
 *    for" and nothing else, and how it went is read back off
 *    `ShellPull.list()` like everything else about a transfer.
 *  - **The bytes never cross the bridge.** The file is already in the app's own
 *    directory; the installer streams it from there.
 *
 * As with `nativePull.ts`, the plugin is reached off the global Capacitor
 * injects rather than an npm import: no native-shell dependency enters the
 * bundle every browser downloads.
 */
import { nativePlugin } from "./shellBridge";
import { isNativeShell } from "./hostUrl";
import { NO_INSTALL, shellDistribution, type InstallCaps, type InstallSources } from "./installPolicy";
import { LS, lsJson, lsSetJson } from "./storage";
import { onSettingsChange } from "./settings";

interface NativeInstallPlugin {
  /** `distribution` and `self` are absent on a shell older than the dev/play
   *  split — read as today's full behaviour, never as `play`. */
  status(): Promise<{ supported?: boolean; canInstall?: boolean; silent?: boolean; allow?: string[];
    distribution?: string; self?: string; cleanAfterInstall?: boolean }>;
  /** Absent on a shell older than the clean-up switch. */
  setCleanAfterInstall?(o: { on: boolean }): Promise<void>;
  openSettings(): Promise<void>;
  setAllow(o: { packages: string[] }): Promise<void>;
  install(o: { id: string }): Promise<void>;
  /** Absent on a shell older than the owner check. */
  sources?(o: { packages: string[] }): Promise<{ self?: string; sdk?: number; sources?: Record<string, { installer?: string; updateOwner?: string }> }>;
}

function plugin(): NativeInstallPlugin | null {
  const p = nativePlugin<NativeInstallPlugin>("Install");
  return p && typeof p.install === "function" ? p : null;
}

/**
 * Can this device install an APK at all?
 *
 * False in every browser, and false in an APK older than this plugin — the UI
 * updates over the air while the binary does not, so a phone runs a bundle
 * whose shell predates any given plugin for as long as it likes. Unknown ⇒ the
 * sheet draws exactly what it drew before this existed.
 */
export function nativeInstallSupported(): boolean {
  return isNativeShell() && plugin() !== null;
}

/** What the phone allows right now, plus the list it is holding. Never throws:
 *  a bridge that answers nothing is a phone that installs nothing, which is the
 *  same sentence the browser gets. */
export async function installStatus(): Promise<{ caps: InstallCaps; allow: string[]; cleanup: boolean | null }> {
  const p = plugin();
  if (!p) return { caps: NO_INSTALL, allow: [], cleanup: null };
  try {
    const r = await p.status();
    return {
      caps: {
        supported: r?.supported !== false,
        canInstall: !!r?.canInstall,
        silent: !!r?.silent,
        ...shellDistribution(r),
      },
      allow: Array.isArray(r?.allow) ? r.allow.filter((s) => typeof s === "string") : [],
      // Null where the shell predates the switch: unknown, never "off".
      cleanup: typeof r?.cleanAfterInstall === "boolean" && typeof p.setCleanAfterInstall === "function"
        ? r.cleanAfterInstall : null,
    };
  } catch {
    return { caps: NO_INSTALL, allow: [], cleanup: null };
  }
}

/** Who installed each package and who owns its updates, as the phone records
 *  it. Null on a browser or a shell that predates the question — unknown,
 *  never "not ours". Never throws. */
export async function installSources(packages: string[]): Promise<InstallSources | null> {
  const p = plugin();
  if (!p?.sources || !packages.length) return null;
  try {
    const r = await p.sources({ packages });
    if (!r?.self) return null;
    return { self: r.self, sdk: typeof r.sdk === "number" ? r.sdk : undefined, byPkg: r.sources ?? {} };
  } catch {
    return null;
  }
}

/** Open the Settings screen carrying the "install unknown apps" switch. There
 *  is no dialog for this one — it is offered, never demanded. */
export async function openInstallSettings(): Promise<void> {
  const p = plugin();
  if (!p) throw new Error("this device has no app installer to open");
  await p.openSettings();
}

/**
 * Mirror the allow-list into the shell.
 *
 * The list is the page's and is synced (the `installAllow` setting), so a second phone
 * inherits it. This copy is what the download service reads, because the
 * install happens where the document may be frozen and a bridge call would
 * never be answered.
 */
export async function pushInstallAllow(packages: string[]): Promise<void> {
  try { await plugin()?.setAllow({ packages }); } catch { /* the phone keeps the list it had */ }
}

/**
 * Turn the clean-up after an install on or off. Held by the SHELL, not the
 * page and not synced: it runs at the install's broadcast receiver, with the
 * document asleep, and it is a question about this phone's storage.
 */
export async function setCleanAfterInstall(on: boolean): Promise<void> {
  const p = plugin();
  if (!p?.setCleanAfterInstall) throw new Error("this app build cannot do that yet");
  await p.setCleanAfterInstall({ on });
}

/** Install this finished download now. The answer arrives on the row. */
export async function nativeInstall(id: string): Promise<void> {
  const p = plugin();
  if (!p) throw new Error("this device cannot install apps");
  await p.install({ id });
}

/**
 * The allow-list as this device holds it.
 *
 * Synced (the `installAllow` setting), so the answer given on one phone is the answer
 * on the next one — and mirrored into the shell on every write, because the
 * copy the download service reads has to be there with the page asleep.
 */
export function readInstallAllow(): string[] {
  const v = lsJson<unknown>(LS.installAllow, []);
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && !!s) : [];
}

export function writeInstallAllow(packages: string[]): void {
  lsSetJson(LS.installAllow, packages);
  void pushInstallAllow(packages);
}

/** Push whatever is stored at the shell at boot, and again whenever the synced
 *  list is adopted from another device: that arrives in localStorage only, and
 *  the shell's copy is what auto-install reads — without the second half a
 *  phone that picked up the list while running stayed silent until a restart
 *  (found recording `scripts/media/apk-install.mjs`). */
let listening = false;
export function syncInstallAllow(): void {
  if (!nativeInstallSupported()) return;
  void pushInstallAllow(readInstallAllow());
  if (listening) return;
  listening = true;
  onSettingsChange(() => { void pushInstallAllow(readInstallAllow()); }, [LS.installAllow]);
}
