/**
 * **Send's menu, the two rows that are not a send to the aimed session**
 * (journey spec T2, T9; glossary row 9): `Add to backlog` and `Start a new
 * session when free`, plus the rule that the menu arms nothing.
 *
 * A file of its own because it empties the box: every `setCompose("")` in the
 * tree is listed in `compose.test.mjs` with the accept it follows, and the bar
 * itself never clears (`ComposeBar.tsx` edits the draft only through its change
 * handler). Here the accept is `queueBacklog` returning non-null: the words are
 * a durable row in the send queue before the box empties.
 */
import { useEffect } from "react";
import { core } from "../../sdk";
import { showReceipt } from "../../kit/receiptStore";
import { openWaiting } from "../../waitingWork";
import { OPEN_WAITING_LABEL, backlogAddReceipt, newWhenFreeReceipt } from "../../composeSend";
import { baseName } from "../../format";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { isLaterId, isPendingId } from "../queue/logic.ts";
import { isPromptedSession } from "../queue/promptedSessions.ts";
import { useBacklog } from "../../features/backlog";
import { CLAUDE, backendIdOf, backendInfo, hasCap } from "../../backendCaps";
import type { ComposeBarProps } from "./ComposeBar";

export function useSendMenu(p: ComposeBarProps): { queueFromBox(kind: "backlog" | "newIdle"): void } {
  const { api, active, outbox, repoForCwd } = p;
  const { uploading, parking, uploadPending } = p.uploads;
  const { compose, setCompose, sendMode, setSendMode, noteSendAim, voice } = api;
  const { items: backlogItems } = useBacklog();
  // The `+ later` screen's plain Send IS "a new session when this repo is free": useCompose sets its
  // `idle` mode there and it must stay.
  const later = isLaterId(active?.id);
  // **Send's menu arms nothing** (journey spec T9, J-61): `Send when free` is a
  // choice for that one prompt, and the plain button keeps meaning "now". The
  // compose hook still arms whatever mode a send went with and remembers it per
  // repo (`sendMemory.ts`); this puts both back on `now` the moment that lands,
  // so the button face never says `When free` for a prompt nobody has typed. Not on `+ later`.
  useEffect(() => {
    if (sendMode === "now" || later) return;
    setSendMode("now");
    noteSendAim(active?.cwd, { mode: "now" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the edge of sendMode only; the setters are the hook's own
  }, [sendMode, later]);
  /**
   * **`Add to backlog` and `Start a new session when free`: the box's words
   * become ONE durable backlog row in this repo** (`queueBacklog`, the same
   * call the send sheet's *a new session · when free* makes), then the box is
   * emptied. The order is the whole safety of it: the row is in the queue's
   * own store BEFORE `setCompose("")`, and a refusal (`null`: it names an
   * upload that will never arrive, already said in a toast) returns with the
   * words exactly where they were. A transcript still on its way refuses too —
   * those words are not in the box yet, and sending without them would strand
   * them in a box about to be closed.
   *
   * `newIdle` then closes the session on screen when it is EMPTY — no turn ever
   * written (`lastTurnAt`), none running, nothing of its own in the send queue
   * and no upload in its lane — through the one session close
   * (`nav.closeSession`: the desktop's close check still asks when something
   * would be lost). Its draft is already empty by then, so nothing typed goes
   * with it. A session still opening (`pending:`) has no id to close yet and is
   * kept; the receipt says which happened.
   */
  function queueFromBox(kind: "backlog" | "newIdle") {
    if (!active) return;
    const text = compose.trim();
    if (!text) { showToast("Nothing in the box yet: type what Claude should do first."); return; }
    if (voice.pending) { showToast("Your dictated words are not back yet. Wait for them, then choose again. Nothing was sent."); return; }
    // sendCompose's own park guard: a picture still being read has no path in the box yet, and
    // queueing now would send the words without it and leave the path alone in the emptied box.
    if (parking > 0) { showToast("still reading that picture — choose again once it says Attached. Nothing was sent."); return; }
    // The Where strip above the menu applies to these rows too: the aimed repo, and a refusal
    // (the aimed session closed, none picked) leaves the words in the box.
    const aim = api.composeAim();
    if ("refuse" in aim) { if (aim.refuse) showToast(aim.refuse); return; }
    const c = core();
    const cwd = aim.target.cwd;
    const repo = repoForCwd(cwd)?.repoName ?? baseName(cwd);
    track(`action:compose.menu.${kind}`);
    const offline = c.queue.queueBacklog({
      text, repoDir: cwd, label: text.slice(0, 40),
      // Add to backlog promises that nothing runs it until the person starts it: held, so the backlog's auto switch cannot.
      ...(kind === "newIdle" ? { autoFire: true } : { hold: true }),
    });
    if (offline === null) return;
    c.compose.pushHistory(compose);
    setCompose("");
    if (kind === "backlog") {
      showReceipt({ text: backlogAddReceipt({ repo, offline }), open: { run: () => openWaiting("backlog"), label: OPEN_WAITING_LABEL } });
      return;
    }
    const sid = active.id;
    // Aimed at another session, the one on screen is not what this errand is about: it stays open.
    const elsewhere = aim.target.kind === "session" && aim.target.sessionId !== sid;
    // A prompt the DESKTOP holds pinned to this session (an earlier `Send when free`) is not in the
    // phone's outbox; closing the session would strand it on `sessionGone`.
    const pinnedHere = backlogItems.some((it) => (it.status === "queued" || it.status === "running") && it.targetSessionId === sid);
    const busyLane = outbox.some((e) => e.sessionId === sid) || !!uploading || parking > 0 || uploadPending || pinnedHere
      // …or a first prompt the desktop is still waiting for the TUI to take, carried inside this session's create.
      || isPromptedSession(sid);
    // `lastTurnAt` is read off claude's own log, so it is absent for EVERY session of a backend that
    // keeps none (shell, opencode, gemini): "no turn yet" proves nothing there. Only a backend the
    // host says keeps a transcript (or claude, when the list has not arrived) can be called empty.
    const bid = backendIdOf(active);
    const list = c.world.backends;
    const keepsLog = backendInfo(list, bid) ? hasCap(list, bid, "transcript") : bid === CLAUDE;
    const empty = keepsLog && active.running && !active.turnActive && active.lastTurnAt == null && !busyLane;
    // `closeSession` refuses with no link (its own toast), so offline an empty session is "nolink":
    // the receipt never claims a close that did not happen.
    const closed = elsewhere ? "kept" as const : isPendingId(sid) ? "opening" as const : !empty ? "kept" as const
      : c.conn.status !== "open" ? "nolink" as const : "closed" as const;
    if (closed === "closed") c.nav.closeSession(active);
    showReceipt({ text: newWhenFreeReceipt({ repo, offline, closed }), open: { run: () => openWaiting("backlog"), label: OPEN_WAITING_LABEL } });
  }
  return { queueFromBox };
}
