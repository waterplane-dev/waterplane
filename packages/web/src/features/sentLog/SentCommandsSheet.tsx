/**
 * The `sentlog` overlay: `SentLogSheet` wired to this feature's stores and to
 * the core. Moved verbatim out of App's `overlayViews.sentlog`.
 */
import { SentLogSheet } from "../../SentLogSheet";
import { useCore, useStore } from "../../sdk";
import { entries, scope } from "./store";

export function SentCommandsSheet() {
  const c = useCore();
  const log = useStore(entries);
  const sessionId = useStore(scope);
  return <SentLogSheet entries={log}
    filterSessionId={sessionId}
    sessionTitle={sessionId ? c.world.sessions.find((s) => s.id === sessionId)?.title : undefined}
    onClose={() => c.nav.close("sentlog")}
    onRefresh={() => c.conn.liveAsk({ t: "sent.get", sessionId: sessionId ?? undefined })}
    onClear={() => { c.conn.send({ t: "sent.clear" }); c.say.toast("sent-command log cleared"); }}
    onOpenSession={(id) => {
      // A logged send outlives its session (that is half the point of a log),
      // so say the session is gone rather than silently doing nothing.
      const s = c.world.sessions.find((x) => x.id === id);
      if (s) c.nav.attach(s); else c.say.toast("that session is no longer open");
    }} />;
}
