/**
 * The Android shell's app installer, for an extension's web half (`@waterplane/sdk`): thin wrappers
 * over core's `nativeInstall.ts` and `useInstallCaps.ts`, NO behaviour of their own. Every answer is
 * asked of the PHONE, never the host; in a browser (or an APK older than the installer plugin)
 * `supported()` is false and `status()` answers `NO_INSTALL` — the same sentence either way.
 *
 * The allow-list ("install by itself" per package) is the synced `installAllow` setting, mirrored
 * into the shell on every write (`writeInstallAllow`); `useInstallAllow` re-renders on EVERY change to
 * the stored list — a write anywhere on this phone and a copy adopted from another (`onInstallAllowChange`)
 * — and re-reads it whenever a component first mounts it.
 */
import { useSyncExternalStore } from "react";
import {
  installStatus, nativeInstall, nativeInstallSupported, onInstallAllowChange, openInstallSettings, readInstallAllow,
  setCleanAfterInstall, writeInstallAllow,
} from "../nativeInstall.ts";
import { refreshInstallStatus, useInstallSources as coreInstallSources, useInstallStatus } from "../useInstallCaps.ts";
import type { InstallCaps, InstallSources } from "../installPolicy.ts";
import { createStore } from "./store.ts";

export type { InstallCaps, InstallSources };

/** The installer, as five calls. Each throws in words where the phone cannot (`install`, `openSettings`,
 *  `setCleanAfterInstall`); `status` never throws. */
export const shellInstall = {
  /** Can this device install an APK at all? False in every browser. */
  supported: (): boolean => nativeInstallSupported(),
  /** What the phone allows right now, the list it holds, and the clean-up switch (`null` = a shell older than it). */
  status: (): Promise<{ caps: InstallCaps; allow: string[]; cleanup: boolean | null }> => installStatus(),
  /** Install this finished download (a pull record's id) now; the answer arrives on the row. */
  install: (id: string): Promise<void> => nativeInstall(id),
  /** The Settings screen carrying "install unknown apps" — offered, never demanded. */
  openSettings: (): Promise<void> => openInstallSettings().finally(() => { void refreshInstallStatus(); }),
  /** Delete the APK after a successful install (held by the shell, per phone, not synced). */
  setCleanAfterInstall: (on: boolean): Promise<void> => setCleanAfterInstall(on),
};

/** What this phone will allow: ONE shared reading, re-asked on every mount, on resume (the page becoming
 *  visible — how a person comes back from Settings) and after `openSettings`. `caps: null` = not known
 *  yet (never "cannot install"); `cleanup: undefined` = not known yet, `null` = a shell older than the switch. */
export function useInstallCaps(): { caps: InstallCaps | null; cleanup: boolean | null | undefined; setCleanup: (v: boolean) => void } {
  return useInstallStatus();
}

/** Who installed each package, re-asked when `key` changes; null = unknown (never "not ours"). */
export function useInstallSources(pkgs: readonly string[], key: string): InstallSources | null {
  return coreInstallSources(pkgs, key);
}

const allow = createStore<readonly string[]>([]);
let read = false;
function snapshot(): readonly string[] {
  if (!read) { read = true; allow.set(readInstallAllow()); }
  return allow.get();
}
let heard = false;
function subscribe(cb: () => void): () => void {
  if (!heard) { heard = true; onInstallAllowChange(() => { read = true; allow.set(readInstallAllow()); }); }
  // EVERY subscribe re-reads the stored list (an adopted copy from another phone lands in
  // localStorage only, so the mirror must not outlive every reader); its `allow.set` re-renders the
  // readers already mounted, which is a no-op when the list is unchanged.
  read = false;
  snapshot();
  return allow.subscribe(cb);
}

/** The packages allowed to install by themselves, as this phone holds them. */
export function useInstallAllow(): readonly string[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Replace the allow-list: stored (synced) and mirrored into the shell. */
export function setInstallAllow(list: readonly string[]): void {
  writeInstallAllow([...list]); // a mounted reader hears it through `onInstallAllowChange`
  if (!heard) read = false;      // none yet: the first snapshot reads the stored list
}
