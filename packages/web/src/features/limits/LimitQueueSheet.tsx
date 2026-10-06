/**
 * The `limits` overlay: `LimitSheet.tsx` wired to this feature's store and
 * actions — the prop list `App.tsx`'s `overlayViews.limits` used to spell out.
 */
import { useCore } from "../../sdk";
import { LimitSheet } from "../../LimitSheet";
import { SNAP_AT_KEY, loadSnap } from "../../localState";
import { useLimitCfg } from "./store";
import { resumeNow, setGlobalAuto, setResumeFirst, setResumeMode, setSessionOverride } from "./actions";

export function LimitQueueSheet() {
  const c = useCore();
  const cfg = useLimitCfg();
  const sessions = c.world.sessions;
  return (
    <LimitSheet
      sessions={sessions} online={c.conn.status === "open"}
      seenAt={loadSnap<number | null>(SNAP_AT_KEY, null)}
      globalAuto={cfg.auto} holdUntil={cfg.hold} mode={cfg.mode}
      onSetGlobal={setGlobalAuto}
      onSetMode={setResumeMode}
      onSetOverride={setSessionOverride}
      onSetFirst={setResumeFirst}
      onResume={resumeNow}
      onOpen={(id) => { const s = sessions.find((x) => x.id === id); if (s) c.nav.attach(s); else c.nav.close("limits"); }}
      onClose={() => c.nav.close("limits")}
    />
  );
}
