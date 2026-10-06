/**
 * The `scrollback` overlay: `ScrollbackSheet.tsx` wired to this feature's
 * store — the prop list `App.tsx`'s `overlayViews.scrollback` used to spell out.
 */
import type { SessionInfo } from "@waterplane/shared";
import { useCore, useStore } from "../../sdk";
import { ScrollbackSheet } from "../../ScrollbackSheet";
import { liveGrid } from "./store";

export function ScrollArchiveSheet({ active }: { active: SessionInfo }) {
  const c = useCore();
  const live = useStore(liveGrid);
  return (
    <ScrollbackSheet
      sessionId={active.id}
      title={active.title}
      live={live}
      linkUp={c.conn.status === "open"}
      onClose={() => c.nav.close("scrollback")} />
  );
}
