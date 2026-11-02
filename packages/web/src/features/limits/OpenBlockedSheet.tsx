/**
 * The `limits` overlay — the blocked sheet (`BlockedSheet.tsx`) wired to this
 * feature's store and actions. The overlay id stays `limits` (a route, the demo
 * tour's target and a tracked name); what it shows grew from the usage-limit
 * queue to every outside wall.
 *
 * Its rows are `attentionCut`'s `blocked` bucket over every session and the
 * launcher's visibility rule — the call the launcher's "N blocked" chip counts
 * with — so the number and these rows are one array. "show all" widens to
 * every blocked session and the sheet says so ("n of N").
 */
import { useState } from "react";
import type { SessionInfo } from "@waterplane/shared";
import { openExternal, useCore } from "../../sdk";
import { SNAP_AT_KEY, loadSnap } from "../../localState";
import { attentionCut, cutWords } from "../../attention";
import { LOGIN_CMD } from "../../loginCmd";
import { netRetryCancel, netRetryNow } from "../../netRetryCfg";
import { BlockedSheet } from "./BlockedSheet";
import { useLimitCfg } from "./store";
import { continueSignedIn, resumeNow, setGlobalAuto, setResumeFirst, setResumeMode, setSessionOverride } from "./actions";

export function OpenBlockedSheet() {
  const c = useCore();
  const cfg = useLimitCfg();
  const sessions = c.world.sessions;
  const [showAll, setShowAll] = useState(false);
  const cut = attentionCut(sessions, "blocked", c.world.backends, c.world.cwdVisible);
  const words = cutWords("blocked", cut);
  const showingAll = showAll && words != null;
  const online = c.conn.status === "open";
  /** `/login` into one signed-out session: the queue's durable path, exactly the
   *  call the session's `BlockBar` makes (`runHeaderCmd` → `submitInput`). */
  const sendLogin = (s: SessionInfo) => {
    c.say.track("action:hdrcmd.send");
    if (!c.queue.submitInput(s.id, s.cwd, LOGIN_CMD.text, "command")) return;
    c.say.toast(online ? `sent ${LOGIN_CMD.title}` : `queued ${LOGIN_CMD.title} — sends when the link is back`);
  };
  /** The session `BlockBar`'s *open*: the phone's browser, said either way. */
  const openLink = (url: string) => {
    c.say.toast(openExternal(url) ? "opening in your browser…" : "your browser blocked that — open the session and copy the link from its sign-in strip");
  };
  return (
    <BlockedSheet
      sessions={showingAll ? cut.all : cut.shown}
      cut={{ words, showingAll, total: cut.all.length, onToggleAll: () => setShowAll((v) => !v) }}
      online={online}
      seenAt={loadSnap<number | null>(SNAP_AT_KEY, null)}
      globalAuto={cfg.auto} holdUntil={cfg.hold} mode={cfg.mode}
      onSetGlobal={setGlobalAuto}
      onSetMode={setResumeMode}
      onSetOverride={setSessionOverride}
      onSetFirst={setResumeFirst}
      onResume={resumeNow}
      onOpenLink={openLink}
      onSendLogin={sendLogin}
      onNetRetryNow={netRetryNow}
      onNetRetryCancel={(s) => netRetryCancel(s.id, s.netRetry?.state === "gaveup")}
      afterSignIn={{ onContinue: continueSignedIn }}
      onOpen={(id) => { const s = sessions.find((x) => x.id === id); if (s) c.nav.attach(s); else c.nav.close("limits"); }}
      onClose={() => c.nav.close("limits")}
    />
  );
}
