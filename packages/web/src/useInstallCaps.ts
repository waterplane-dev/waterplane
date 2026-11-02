import { useEffect, useState, useSyncExternalStore } from "react";
import { installSources, installStatus } from "./nativeInstall";
import type { InstallCaps, InstallSources } from "./installPolicy";
import { createAskedStore } from "./askedStore";

/**
 * The Android shell's two answers the install screens need — asked of the PHONE, never the host.
 *
 * ONE reading shared by every mount (the launcher's count and the sheet read the same `caps`, so the
 * badge and the sheet's waiting count cannot disagree), re-asked on every mount, whenever the page
 * becomes visible again (resume — and how a person comes back from the Settings screen where "install
 * unknown apps" is granted and taken back) and on `refreshInstallStatus`. Concurrent asks share one
 * call to the shell (`askedStore.ts`, run by its test).
 * `null` caps = not known yet — NOT `NO_INSTALL`, which is a positive "this device cannot install".
 * `undefined` cleanup = not known yet, `null` = a shell older than the switch.
 */
interface Status { caps: InstallCaps | null; cleanup: boolean | null | undefined }
const store = createAskedStore<Status>(
  () => installStatus().then((r) => ({ caps: r.caps, cleanup: r.cleanup })),
  { caps: null, cleanup: undefined });
let resumeHeard = false;

/** Ask the shell again (one call however many ask at once); every mounted reader re-renders. */
export function refreshInstallStatus(): Promise<void> {
  return store.refresh();
}

function subscribe(fn: () => void): () => void {
  if (!resumeHeard && typeof document !== "undefined") {
    resumeHeard = true;
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void refreshInstallStatus(); });
  }
  return store.subscribe(fn);
}
const snap = () => store.get();

function setCleanup(v: boolean): void { store.set({ ...store.get(), cleanup: v }); }

export function useInstallStatus(): { caps: InstallCaps | null; cleanup: boolean | null | undefined; setCleanup: (v: boolean) => void } {
  const s = useSyncExternalStore(subscribe, snap, snap);
  useEffect(() => { void refreshInstallStatus(); }, []);
  return { caps: s.caps, cleanup: s.cleanup, setCleanup };
}

/** Who installed each package (`Installs.source`), re-asked when `key` changes. Unknown stays null. */
export function useInstallSources(pkgs: readonly string[], key: string): InstallSources | null {
  const [sources, setSources] = useState<InstallSources | null>(null);
  useEffect(() => {
    let live = true;
    void installSources([...pkgs]).then((s) => { if (live) setSources(s); });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- `pkgs` is a fresh array each render; `key` is its identity plus the install stamps the answer depends on
  return sources;
}
