/**
 * The `questions` overlay: `QuestionsSheet.tsx` wired to the core — the prop
 * list `App.tsx`'s `overlayViews.questions` used to spell out.
 */
import { useMemo } from "react";
import { useCore, useQueueEntries } from "../../sdk";
import { QuestionsSheet } from "../../QuestionsSheet";
import { SNAP_AT_KEY, loadSnap } from "../../localState";
import { ackAsking } from "./actions";

export function OpenQuestionsSheet() {
  const c = useCore();
  const entries = useQueueEntries();
  // One copy per store change, not per render: the store's list is readonly
  // and the sheet's prop is not, and a fresh array every render defeats the
  // sheet's own memos.
  const outbox = useMemo(() => [...entries], [entries]);
  const sessions = c.world.sessions;
  return (
    <QuestionsSheet
      sessions={sessions} outbox={outbox} online={c.conn.status === "open"}
      seenAt={loadSnap<number | null>(SNAP_AT_KEY, null)}
      // The same durable path the reader's card uses — there is deliberately
      // no second way to answer a question, so the fingerprint guard and the
      // lane rules can't drift between the two entry points.
      onAnswer={c.queue.answerPrompt}
      onOpen={(id) => { const s = sessions.find((x) => x.id === id); if (s) c.nav.attach(s); else c.nav.close("questions"); }}
      onAck={ackAsking}
      onClose={() => c.nav.close("questions")}
    />
  );
}
