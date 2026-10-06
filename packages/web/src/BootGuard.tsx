import { Component, type ErrorInfo, type ReactNode } from "react";
import { logTag } from "@waterplane/shared";
import { RESET_KEEP_PREFIXES } from "./storage";
import { appName } from "./themeOverlay";
import { PULL_CACHE_PREFIXES } from "./boot/brandMigrate";

/**
 * The last line of defence against a BLACK SCREEN.
 *
 * `#root` is the whole app; body is `var(--bg)` (near-black). So anything that
 * stops the tree rendering — a throw in a render/effect, a bad value read out of
 * localStorage, a chunk that came back as HTML — paints exactly the same thing:
 * a featureless dark rectangle with no text, no button, and no way to tell a
 * crash from a hung network. On a phone there is no console to check, which is
 * what made this un-diagnosable.
 *
 * This renders the error instead, plus the two recoveries that actually work on
 * a phone: reload, and a hard reset that drops the service-worker caches and the
 * device-local view state before reloading. It deliberately does NOT clear the
 * send outbox or the prompt pad — unsent text is the one thing here that cannot
 * be re-fetched from the host — nor the bookkeeping that decides whether those
 * survive the next sync (see `storage.ts`'s `RESET_KEEP_PREFIXES`).
 */

async function hardReset(): Promise<void> {
  try {
    for (const k of Object.keys(localStorage)) {
      if (!RESET_KEEP_PREFIXES.some((p) => k.startsWith(p))) localStorage.removeItem(k);
    }
  } catch { /* storage disabled */ }
  try {
    const names = await caches.keys();
    // Downloaded artifacts are megabytes someone waited for — same carve-out the
    // service worker's activate purge makes — under every brand's name, because
    // an older one's may not have been copied across yet.
    await Promise.all(names.filter((n) => !PULL_CACHE_PREFIXES.some((p) => n.startsWith(p))).map((n) => caches.delete(n)));
  } catch { /* no Cache Storage */ }
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  } catch { /* no SW */ }
  location.reload();
}

function Fallback({ err }: { err: unknown }) {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return (
    <div className="boot-fail">
      <h2>{appName()} couldn't start</h2>
      <pre>{msg}</pre>
      <div className="boot-fail-acts">
        <button onClick={() => location.reload()}>Reload</button>
        <button onClick={() => { void hardReset(); }}>Reset caches &amp; reload</button>
      </div>
      <p>Queued text and prompt-pad drafts are kept by the reset.</p>
    </div>
  );
}

export class BootGuard extends Component<{ children: ReactNode }, { err: unknown }> {
  state: { err: unknown } = { err: null };

  static getDerivedStateFromError(err: unknown) {
    return { err };
  }

  componentDidCatch(err: unknown, info: ErrorInfo) {
    // No remote logging — the host never sees the phone's console. Keeping it
    // here at least makes a tethered debug session useful.
    console.error(`${logTag} render failed`, err, info.componentStack);
  }

  render() {
    return this.state.err ? <Fallback err={this.state.err} /> : this.props.children;
  }
}

/**
 * Pre-React trap: a throw at module scope (or a script that never parsed —
 * e.g. a stale service worker answering a hashed-asset request with index.html)
 * happens before any boundary exists, and leaves #root empty forever. If nothing
 * has mounted shortly after load, say so on screen rather than showing black.
 */
export function armBootTrap(): void {
  let firstError: unknown = null;
  const note = (e: unknown) => { if (!firstError) firstError = e; };
  window.addEventListener("error", (e) => note(e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => note(e.reason));

  setTimeout(() => {
    const root = document.getElementById("root");
    if (!root || root.childElementCount > 0) return;
    root.innerHTML = "";
    const box = document.createElement("div");
    box.className = "boot-fail";
    const msg = firstError
      ? (firstError instanceof Error ? `${firstError.name}: ${firstError.message}` : String(firstError))
      : "The app scripts loaded but nothing rendered.";
    box.innerHTML = `<h2></h2><pre></pre>`;
    (box.querySelector("h2") as HTMLElement).textContent = `${appName()} couldn't start`;
    (box.querySelector("pre") as HTMLElement).textContent = msg;
    const acts = document.createElement("div");
    acts.className = "boot-fail-acts";
    const reload = document.createElement("button");
    reload.textContent = "Reload";
    reload.onclick = () => location.reload();
    const reset = document.createElement("button");
    reset.textContent = "Reset caches & reload";
    reset.onclick = () => { void hardReset(); };
    acts.append(reload, reset);
    box.append(acts);
    root.append(box);
  }, 4000);
}

/**
 * The same defence, one screen down: a SHEET that throws must not take the app
 * with it.
 *
 * `BootGuard` is app-wide, and that is exactly the problem for an overlay.
 * Which sheet is open is part of the ROUTE (`routing.ts`), and the ones in
 * `PERSISTED_OVERLAYS` are restored on boot — so a throw inside one is not a
 * broken screen you back out of, it is a BOOT LOOP: the app comes up, restores
 * the sheet, throws, and paints "couldn't start" over a message about a
 * property. Reload does it again. The only way out was the hard reset, which is
 * a sledgehammer aimed at caches when the fault was one component.
 *
 * Measured: a `TokenStatsDoc` cached before the `cost` field existed, seeded by
 * `useRemoteResource` ahead of the live read, restored into the tokens overlay
 * on every boot.
 *
 * The recovery is to UN-ROUTE, immediately, inside the catch — an app killed at
 * an error screen must not reopen the error screen. That unmounts this
 * boundary in the same commit, which is why the fallback here renders NOTHING
 * and the failure is reported through `onFail` instead: a message that is on
 * screen for one frame is a message nobody read. The caller says it in a toast
 * and puts the user back on the screen underneath, which is running fine.
 *
 * Give it a `key` of the overlay id, so a different sheet is a fresh mount.
 */
export class SheetGuard extends Component<
  { children: ReactNode; name: string; onFail: (name: string, message: string) => void },
  { err: boolean }
> {
  state = { err: false };

  static getDerivedStateFromError() {
    return { err: true };
  }

  componentDidCatch(err: unknown, info: ErrorInfo) {
    console.error(`${logTag} sheet "${this.props.name}" failed`, err, info.componentStack);
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    try { this.props.onFail(this.props.name, msg); } catch { /* nothing left to tell */ }
  }

  render() {
    return this.state.err ? null : this.props.children;
  }
}
