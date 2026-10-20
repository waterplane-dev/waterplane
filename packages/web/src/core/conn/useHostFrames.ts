import { useEffect, type MutableRefObject } from "react";
import { PROTOCOL_VERSION } from "@waterplane/shared";
import { removePadNotes } from "../../outbox";
import { saveSessionsSnap, saveSnap } from "../../localState";
import { noteSynced } from "../../link";
import { fmtSecs, noteHostRestarting, noteHostWelcome, restartView } from "../../link/hostRestart";
import { applyRemoteSetting, mergeSettingsDoc } from "../../settings";
import { pulls } from "../../pull";
import { showToast } from "../../toast";
import { LS } from "../../storage";
import { onAssessAck } from "../../features/backlog";
import { noteHistory } from "../../features/history";
import { noteModed } from "../session/modeSwitch";
import { dispatchFeatureMessage } from "../dispatch";
import { streamRouter } from "../streamRouter";
import { useLatest } from "../../sdk/hooks";
import type { Connection } from "./useConnection";
import type { TermFeed } from "../term/useTermFeed";
import type { SessionVerbs } from "../sessions/useSessionVerbs";
import type { QueueApi } from "../queue/useQueue";
import type { useHostState } from "../sessions/useHostState";

/** What the frame switch reads as of THIS render (held in one `useLatest`). */
export interface HostFrameLatest {
  conn: Connection;
  term: TermFeed;
  verbs: SessionVerbs;
  q: QueueApi;
  focusSession: (id: string) => void;
}

/** What it writes: the host lists' setters and two refs — stable, so the
 *  mount render's are the ones it keeps, as it always did. */
export type HostFrameSinks = Pick<ReturnType<typeof useHostState>,
  "setBackends" | "setSessions" | "setRecent" | "setClosed" | "setUpdate" | "setMeter" | "setIntents" | "updateResultSeenRef"> & {
  connRef: Connection["connRef"];
  wantNavRef: MutableRefObject<boolean>;
};

/**
 * **The socket's frame switch** — every host frame App itself handles, and the
 * one subscription for them, with the features' listener registered AFTER it
 * (docs/notes/app-architecture.md). Subscribed once, on mount; the handler
 * reads this render's hooks through `latest`, never the mount-time ones.
 */
export function useHostFrames(latest: HostFrameLatest, sinks: HostFrameSinks) {
  const wsLatest = useLatest(latest);
  useEffect(() => {
    const { connRef, setBackends, setSessions, setRecent, setClosed, setUpdate, setMeter, setIntents, updateResultSeenRef, wantNavRef } = sinks;
    const offApp = connRef.current.on((msg) => {
      // This render's hook returns, never the mount-time ones (the handler is
      // subscribed once): a hook method that later reads a render value would
      // otherwise read the first render's for ever.
      const { conn, term, verbs, q, focusSession } = wsLatest.current;
      switch (msg.t) {
        case "welcome":
          // Both ends have always EXCHANGED a protocol version and neither ever
          // compared it. There are three independently-updating copies of this
          // bundle — the browser's service-worker cache, the Android shell's OTA
          // store and the host's own `dist` — so skew is not hypothetical, and
          // silent skew shows up as a message type the other side drops on the
          // floor. Say it once, plainly: nothing here can fix it, but "the app
          // and the desktop are different versions" is the difference between a
          // baffling dead button and a `npm run restart`.
          if (msg.protocol !== PROTOCOL_VERSION) {
            showToast(msg.protocol > PROTOCOL_VERSION
              ? "the desktop is newer than this app — reload to update"
              : "the desktop is older than this app — run `npm run restart` there");
          }
          // The backend list is scoped to this boot, like every resume point. It means
          // "what THIS host agreed to honour", so a new hello starts it over:
          // reconnect to a desktop rolled back to a claude-only build and the
          // stale list would keep drawing a picker that host never offered and
          // would keep `launchFor` validating against backends it does not have.
          // Cleared HERE rather than on the disconnect, which is the other half
          // of the same rule — an outage is not a downgrade, and blanking the
          // picker under a thumb already on it is a worse lie than a stale one.
          // A capable host sends `backends` in the same batch as this frame, so
          // the picker is absent for at most one paint. (Keying the list by
          // `bootId` instead would put the same reset behind a second field
          // every call site has to remember to compare.)
          setBackends(null);
          conn.noteWelcome(msg);
          {
            // A new bootId is a desktop that restarted, not a tunnel that came
            // back — say so, with how long it took (`link/hostRestart.ts`).
            const back = noteHostWelcome(msg);
            if (back) showToast(back.announced
              ? `desktop restarted — back${back.downMs != null ? ` after ${fmtSecs(back.downMs)}` : ""}`
              : `desktop restarted without warning (crash?)${back.downMs != null ? ` — back after ${fmtSecs(back.downMs)}` : ""}`);
          }
          // The socket coming up is the best evidence the tunnel is back — far
          // better than `navigator.onLine`, which never went false. Anything a
          // dead link parked mid-transfer resumes from its stored offset here.
          pulls.pump();
          // The terminal's half: the boot stamp and the transcript refill.
          term.onWelcome(msg.bootId);
          break;
        // What this desktop can launch. Pushed on hello, so it is in hand
        // before any launcher row can be tapped — which is what lets the
        // picker be ABSENT rather than "loading" on a host that has one.
        // Never cleared on a disconnect: the answer is still the last thing
        // this host said, and blanking it mid-session would make the picker
        // vanish under a thumb that is already on it. Cleared on the next
        // `welcome` instead (see there) — a RE-hello is the one moment the
        // desktop on the other end may not be the desktop that spoke.
        case "backends":
          setBackends(msg.list);
          break;
        // The host's SIGTERM handler, before it goes: the strip counts the wait.
        case "host.restarting": {
          noteHostRestarting(Date.now(), msg.reason);
          const usual = restartView().usualMs;
          showToast(`desktop is restarting${msg.reason ? ` (${msg.reason})` : ""}${usual != null ? ` — usually back in ~${fmtSecs(usual)}` : " — the app cannot reach it until it is back"}`);
          break;
        }
        case "auth.state":
          conn.setInfo({ auth: msg.auth });
          break;
        case "backlog.ack": q.onBacklogAck(msg); break;
        // An assess op is sent LIVE, not queued, so it has no outbox row: its
        // receipt and the pad notes it owes are the backlog feature's.
        case "op.ack": onAssessAck(msg.ackId, msg.ok, msg.filed, removePadNotes); q.onOpAck(msg); break;
        case "session.list": setSessions(msg.sessions); verbs.settleStars(msg.sessions, true); saveSessionsSnap(msg.sessions); noteSynced("sessions"); break;
        case "recent.list": setRecent(msg.recent); saveSnap(LS.snapRecent, msg.recent); break;
        case "closed.list": setClosed(msg.closed); saveSnap(LS.snapClosed, msg.closed); break;
        case "input.ack": q.onInputAck(msg); break;
        // What became of the deliveries the host could not confirm at the time.
        // The phone does not ask any more (see the note where the settle sweep
        // used to be): the desktop re-asks the CLI's own conversation log on its
        // own sweep, whether or not anybody is connected, and broadcasts the
        // answer. `delivery.list` arrives on hello and after a reconnect, which
        // is the reconciliation pass for verdicts settled while this tab was
        // gone — the case the old client-driven version could never cover.
        case "delivery.list": q.onDeliveryList(msg); break;
        case "delivery.settled": q.onDeliverySettled(msg); break;
        case "session.created":
          setSessions((prev) => [...prev.filter((s) => s.id !== msg.session.id), msg.session]);
          term.buffers.current.set(msg.session.id, []);
          // Only navigate if this client asked for it (new session or manual fire);
          // auto-fired backlog sessions just appear in the list without yanking.
          if (wantNavRef.current) focusSession(msg.session.id);
          break;
        case "session.focus":
          // Navigate to a session the host wants us to open (e.g. one that is
          // already running in that repo, which emits no "created" event).
          focusSession(msg.id);
          break;
        case "session.updated":
          verbs.settleStars([msg.session], false);
          setSessions((prev) => {
            const next = prev.map((s) => (s.id === msg.session.id ? msg.session : s));
            // Snapshot here too, not only on `session.list`. A pending QUESTION
            // arrives on this message, and a question that reached the phone
            // during a brief connectivity window is precisely the thing that
            // must survive the link dying and the tab being reloaded — the
            // whole point of answering offline is that the box is still there
            // to answer. Without this the snapshot kept the session but not the
            // fact that it was waiting for you.
            saveSessionsSnap(next);
            return next;
          });
          term.onSessionUpdated(msg.session);
          break;
        case "pty": term.onPty(msg); break;
        case "session.exit": term.onSessionExit(msg); break;
        case "session.closecheck": verbs.onCloseCheck(msg); break;
        case "session.history":
          // An attach ALWAYS answers with this frame — even when the resume delta
          // is empty (`attachReplay` returns no data and no `full` flag, the usual
          // backgrounded-idle case), which sends no pty frame at all. Clearing the
          // restore marks only on a pty frame therefore left the terminal dimmed
          // for good, with no chip to explain it and the periodic tail save
          // suppressed (restoreRef still held the id). This is the second, always
          // present proof that the host answered for this session.
          term.hostAnsweredFor(msg.id);
          // Kept and cached, output stripped (features/history).
          noteHistory(msg.id, msg.entries);
          break;
        case "session.named":
          // Two cheap calls deep on the desktop, so this lands seconds after
          // the tap — and it lands either way. The name itself arrives on the
          // session list, which is what redraws the tab and the header; this
          // frame is the RECEIPT, and the refusal is the half that matters:
          // a tap that spends a call and says nothing is the failure the whole
          // path is written around.
          showToast(msg.name ? `named “${msg.name}”` : (msg.reason ?? "no name was written"));
          break;
        case "session.moded":
          // The mode switch's receipt (`modeSwitch.ts`): ends the row's
          // "switching…" and says what the footer shows — or the host's reason
          // it does not show the mode asked for. The new mode itself arrives as
          // `liveMode` on the session list.
          noteModed(msg);
          break;
        case "update.status":
          setUpdate(msg.info);
          // Toast only the FIRST time we see each `lastResult` (by timestamp).
          if (msg.info.lastResult && msg.info.lastResult.at > updateResultSeenRef.current) {
            updateResultSeenRef.current = msg.info.lastResult.at;
            showToast(msg.info.lastResult.ok ? "Claude updated" : `Update failed: ${msg.info.lastResult.message}`);
          }
          break;
        case "budget.state": q.onBudget(msg); break;
        // Settings that follow the user (prompt templates, presets, header
        // commands, the pad, the toolbar). `settings.all` arrives unprompted on
        // every connect, which is also what pushes anything written offline.
        case "settings.all": mergeSettingsDoc(msg.doc); break;
        case "settings.update": applyRemoteSetting(msg.key, msg.value, msg.ts); break;
        case "toast": showToast(msg.text); break;
        case "meter.status": setMeter(msg.summary); break;
        // `fanout.list` / `fanout.run` are no longer read: the runs are derived
        // from `intents`, which is the store they were projected from. The host
        // still sends them for a bundle pinned to an older build.

        // ── The durable store, whole ──
        //
        // `intent.list` is the full set (sent on hello and on every change);
        // `intent.changed` is one row, pushed the moment it moves. Both have
        // been on the wire since `intents/` landed and neither was read.
        case "intent.list": setIntents(msg.intents); break;
        case "intent.changed": setIntents((prev) => {
          const at = prev.findIndex((i) => i.id === msg.intent.id);
          if (at < 0) return [msg.intent, ...prev];
          const next = prev.slice();
          next[at] = msg.intent;
          return next;
        }); break;
        // ── Handed-over launches ──
        case "launch.list": q.onLaunchList(msg); break;
        case "launch.opened": q.onLaunchOpened(msg); break;
        case "error": if (msg.context === "__status") conn.setStatus(msg.message); break;
      }
    });
    const offFeatures = connRef.current.on(dispatchFeatureMessage); // AFTER App's; ws.ts isolates each listener
    // Plugin streams' binary frames (`core/streams.ts`); their JSON rides `dispatchFeatureMessage`.
    const offBinary = connRef.current.onBinary((data) => streamRouter().onBinary(data));
    return () => { offApp(); offFeatures(); offBinary(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribed once: the handler reads this render's hooks through `wsLatest`, and `sinks` are stable setters and refs
  }, []);
}
