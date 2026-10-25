import { useEffect, useRef, useState } from "react";
import type { NotificationItem, RepoTarget, SessionInfo } from "@waterplane/shared";
import { setRepoNamer, startDownload } from "../../download";
import { viewerHandles } from "../../docKind";
import { onServiceWorkerPullMessage } from "../../pull";
import { onShellOpenSession } from "../../shellLink";
import { openPluginFromNotification } from "../extensionPoints";
import { openNotifFromOutside } from "../../features/notifications";
import { shellOpenTarget } from "./shellOpenTarget";
import { openArtifact, viewImage } from "../../features/images";
import type { Route } from "./useRoute";
import type { TermFeed } from "../term/useTermFeed";

export interface UseOutsideOpensCtx {
  reposRef: { readonly current: RepoTarget[] };
  initRoute: Route["initRoute"];
  sessions: SessionInfo[];
  attach: TermFeed["attach"];
  setOverlay: Route["setOverlay"];
}

/**
 * What reaches the app from OUTSIDE the tab: the download rows' repo namer, a
 * cold notification's file, the service worker's and the Android shell's
 * "open this" (docs/notes/app-architecture.md). Five of App's effects,
 * verbatim and in their order.
 */
export function useOutsideOpens(ctx: UseOutsideOpensCtx) {
  const { reposRef, initRoute, sessions, attach, setOverlay } = ctx;
  // Downloads rows name their repo, whichever button started them: only App
  // holds the listing, and asking every call site to pass a name is how nearly
  // all of them ended up passing none (`download.ts`).
  useEffect(() => {
    setRepoNamer((id) => {
      const r = reposRef.current.find((x) => x.id === id);
      return r ? { repoName: r.repoName, repoDir: r.worktreePath } : undefined;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only registration; the namer reads `reposRef` live
  }, []);

  // A COLD tap on an artifact notification: the service worker had no window to
  // hand the file to, so it encoded it in the hash. Fetch it once, here, where
  // the queue is already running — the notification's whole promise is that the
  // file ends up on the phone.
  useEffect(() => {
    // ...unless it is a file this app can SHOW, in which case the boot state
    // above already opened the viewer on it and a background transfer of
    // something you are looking at is not what the tap asked for.
    if (initRoute.file && !viewerHandles(initRoute.file.relPath)) startDownload(initRoute.file);
    // Same errand for a plugin's alert: `sw.js` put `plugin=<id>` in the hash.
    if (initRoute.plugin) openPluginFromNotification(initRoute.plugin);
    // ...and for an alert with none of those: the whole item (`openNotif`).
    if (initRoute.notif) openNotifFromOutside(initRoute.notif);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- cold-tap download fires once at mount from the initial route
  }, []);

  // A tapped push notification asks the SW to open its session.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const h = (e: MessageEvent) => {
      if (e.data?.type === "open-session") {
        const s = sessions.find((x) => x.id === e.data.sessionId);
        if (s) attach(s);
      } else if (onServiceWorkerPullMessage(e.data)) {
        // A Background Fetch finished (or failed) while we were open — pull.ts
        // moves the bytes out of the worker's handoff cache and updates the row.
      } else if (e.data?.type === "open-pulls") {
        setOverlay("pull");
      } else if (e.data?.type === "download-file" && e.data.file) {
        // An artifact notification tapped while the app is open. It used to
        // navigate a tab at `…&download=1`; it is the ordinary queued download
        // now, so it behaves the same here as it does in the APK.
        const f = e.data.file as { repoId: string; relPath: string; name?: string; size?: number; mtime?: number };
        if (viewerHandles(f.relPath)) openArtifact(f); else startDownload(f);
      } else if (e.data?.type === "open-image" && e.data.image) {
        const s = sessions.find((x) => x.id === e.data.sessionId);
        if (s) attach(s);
        viewImage(e.data.image as { repoId: string; relPath: string }, e.data.sessionId);
      } else if (e.data?.type === "open-plugin" && typeof e.data.plugin === "string") {
        openPluginFromNotification(e.data.plugin);
      } else if (e.data?.type === "open-notif" && e.data.item) {
        openNotifFromOutside(e.data.item as NotificationItem);
      }
    };
    navigator.serviceWorker.addEventListener("message", h);
    return () => navigator.serviceWorker.removeEventListener("message", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-bound on `sessions` for the lookup; `attach` and `setOverlay` are fine at that render's closure
  }, [sessions]);

  // The same errand in the APK, which has no service worker at all: a tapped
  // notification posted by the native background link.
  //
  // Two things this must not get wrong. The subscription is registered ONCE,
  // because `onShellOpenSession` answers the shell "somebody took it" as soon
  // as a handler exists and the shell stops retrying on that answer — so a
  // handler re-registered per `sessions` change would swallow the id during
  // the seconds before the list has landed, which is exactly the cold start
  // this path is for. And the id is therefore PARKED rather than acted on:
  // the effect below attaches once a session by that id actually exists.
  const shellWantRef = useRef<string | null>(null);
  const [shellWant, setShellWant] = useState<string | null>(null);
  useEffect(() => onShellOpenSession((sessionId) => {
    // `plugin:<id>` is a plugin's alert, not a session (see `shellOpenTarget`): no list to wait for.
    const target = shellOpenTarget(sessionId);
    if ("plugin" in target) { openPluginFromNotification(target.plugin); return; }
    // A whole alert with no session (a health move, a burning week): `openNotif` lands it.
    if ("notif" in target) { openNotifFromOutside(target.notif); return; }
    shellWantRef.current = sessionId;
    setShellWant(sessionId);
  }), []);
  useEffect(() => {
    const want = shellWantRef.current;
    if (!want) return;
    const s = sessions.find((x) => x.id === want);
    if (!s) return;   // list not here yet — a later render will find it
    shellWantRef.current = null;
    setShellWant(null);
    attach(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the parked id is read from `shellWantRef`; `attach` must not re-trigger a navigation
  }, [sessions, shellWant]);
}
