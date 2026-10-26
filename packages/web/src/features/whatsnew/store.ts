/**
 * What's new holds two facts, one writer each (`actions.ts`): the version this
 * phone last announced, and the desktop's version as `updates.status` last said
 * it (the plugins feature keeps the whole status; this keeps only the number,
 * heard off the same frame — features never import each other).
 */
import { useEffect, useState } from "react";
import type { WeekBurnStatus } from "@waterplane/shared";
import { createStore, useCore, useStore } from "../../sdk";
import { LS, lsGet } from "../../storage";
import { api } from "../../api";
import { useRemoteResource } from "../../useRemoteResource";
import { useFeedFacts, type FeedSource } from "../../feedSlot";
import { isNativeShell } from "../../hostUrl";
import { nativeInfo } from "../../webUpdate";
import { nativeDropAfterSave } from "../../nativePull";
import { failuresOf, type HubFacts } from "./logic";

/** The desktop version this phone has announced (or been told about). "" = never. Per device. */
export const seen = createStore<string>(lsGet(LS.whatsNewSeen) ?? "");

/** `updates.status.self.current`; null until the host has said. */
export const desktopVersion = createStore<string | null>(null);

export function useSeen(): string { return useStore(seen); }
export function useDesktopVersion(): string | null { return useStore(desktopVersion); }

// ── The facts a row's state is read from ────────────────────────────────
// Everything already on the phone (`HubFacts`), no state of its own: the feed
// through `feedSlot.ts`, the rule list and repos through `core()`, the week-end
// burn through the same `useRemoteResource` key its sheet uses (fresh reads
// only), and the shell's two answers asked once per mount, as the Downloads
// sheet asks them.

/** The shell's versionName, read only while `enabled` (a release is unannounced, or the sheet is open). null until answered. */
export function useApkVersion(enabled: boolean): string | null {
  const native = isNativeShell();
  const [apk, setApk] = useState<string | null>(null);
  useEffect(() => {
    if (!native || !enabled) return;
    let live = true;
    void nativeInfo().then((n) => { if (live) setApk(n?.versionName ?? ""); });
    return () => { live = false; };
  }, [native, enabled]);
  return apk;
}

/** The shell's version and its Downloads-copy switch (a Downloads listing: the SHEET only, never the launcher). */
export function useShellFacts(): Pick<HubFacts, "native" | "apk" | "dropCopy"> {
  const native = isNativeShell();
  const apk = useApkVersion(true);
  const [dropCopy, setDropCopy] = useState<boolean | null>(null);
  useEffect(() => {
    if (!native) return;
    let live = true;
    void nativeDropAfterSave().then((on) => { if (live) setDropCopy(on ?? null); });
    return () => { live = false; };
  }, [native]);
  return { native, apk, dropCopy };
}

export function useHubFacts(): { facts: HubFacts; feed: FeedSource | null } {
  const c = useCore();
  const { facts: fd, src } = useFeedFacts();
  const shell = useShellFacts();
  const burn = useRemoteResource<WeekBurnStatus>("weekburn", () => api.getWeekBurn());
  const names = new Map(c.world.repos.map((r) => [r.id, r.repoName]));
  const sched = c.world.schedules;
  const facts: HubFacts = {
    now: Date.now(),
    needsYou: fd.needsYou,
    pushInfo: fd.pushInfo,
    failures: fd.failures ? failuresOf(fd.failures, (id) => names.get(id) ?? null) : null,
    clocks: sched.length
      ? sched.map((e) => ({ id: e.id, enabled: e.enabled, nextAt: e.nextAt, isBuild: e.action.kind === "build" }))
      : null,
    weekburn: burn.state === "fresh" ? burn.data ?? null : null,
    ...shell,
  };
  return { facts, feed: src };
}
