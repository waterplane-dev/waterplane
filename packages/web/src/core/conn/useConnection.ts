/**
 * The ONE socket, as App holds it: the connection, its status and the
 * debounced banner flag, what the last `welcome` said about how this phone
 * reached the desktop, and the three receipt-bearing writes (`liveSend`,
 * `liveSendAll`, `liveAsk`).
 *
 * Lifted out of `App.tsx` unchanged — every name App used is a member of the
 * return, so call sites keep their spelling. There is still exactly one
 * socket (`makeConnection()` is a module singleton, `local/no-second-socket`);
 * this hook only holds App's view of it.
 */
import { useEffect, useRef, useState } from "react";
import type { AuthState, ClientMessage, HostMessage } from "@waterplane/shared";
import type { ConnInfo } from "../../sdk/types.ts";
import { makeConnection } from "../../ws.ts";
import { showToast } from "../../toast.ts";

/** How long a non-open socket must persist before the banner shows. */
const CONN_GRACE_MS = 1800;

type Welcome = Extract<HostMessage, { t: "welcome" }>;

const NO_AUTH: AuthState = { enabled: false, gateTailscale: false, canManage: false };

export function useConnection() {
  const connRef = useRef(makeConnection());
  const [status, setStatus] = useState<string>(() => connRef.current.status);
  // Re-read the socket once mounted: a connection that opens between this
  // render and App's listener registering (the demo's in-memory socket opens on
  // the next tick) has already announced "open", and waiting for that edge again
  // leaves every screen on "connecting…" for good. A real link opens later than
  // this, so there it is a no-op.
  useEffect(() => { setStatus(connRef.current.status); }, []);
  // Debounced banner: a brief background/foreground reconnects the socket in a
  // fraction of a second over Tailscale, and flashing "connecting…" every time
  // the user glances away is the actual annoyance. Only surface the banner once
  // the disconnect has persisted past CONN_GRACE_MS; clear it instantly on open.
  const [connVisible, setConnVisible] = useState(false);
  /**
   * What the last `welcome` said: the tunnel address and binary, the URL
   * tailscale serve actually fronts the host with, the LAN addresses, the port,
   * the host root and the LAN-password state.
   *
   * `httpsUrl`, port included: only the host can know it (it reads `serve
   * status`), and guessing `https://<tailscaleDns>` assumes the listener is on
   * 443 — where another service may well be, in which case the shortcut opens
   * the WRONG app.
   */
  const [info, setInfoState] = useState<ConnInfo>({
    tailscaleIp: null, tailscaleBin: null, httpsUrl: null, lanIps: [], hostPort: 8770, root: "", auth: NO_AUTH,
  });
  const setInfo = (patch: Partial<ConnInfo>) => setInfoState((prev) => ({ ...prev, ...patch }));
  /** The welcome's connection facts, in one write (App's `welcome` case). */
  const noteWelcome = (msg: Welcome) => setInfo({
    tailscaleIp: msg.tailscaleIp, tailscaleBin: msg.tailscaleBin, root: msg.root,
    httpsUrl: msg.httpsUrl ?? null, lanIps: msg.lanIps, hostPort: msg.port, auth: msg.auth,
  });
  // Set when the socket came back with offline-queued entries still parked and
  // the confirmation is pending. While it holds, unforced flushes are refused,
  // so the sweep can't sneak the queue out from under the question.
  const [reconnectAsk, setReconnectAsk] = useState(false);

  const send = connRef.current.send.bind(connRef.current);

  /**
   * **No tap may be silent** — the live-only half of that rule.
   *
   * `ws.ts`'s `send()` RAM-queues anything it cannot deliver, invisibly, and
   * the reconnect watchdog's page reload throws that buffer away. So a bare
   * socket write in a tap handler is a button that sometimes does nothing and
   * never says so, which is exactly the report this rework started from: "I
   * look at this and it seems that no button that I press does anything".
   *
   * These frames are deliberately NOT durable ops — a "switch that schedule
   * off", a "cancel this build", a "delete that log" delivered an hour late is
   * a decision about a situation that has already resolved itself, which is why
   * they are not in the ackId ledger. The answer for them is not durability, it
   * is a RECEIPT: refuse with a reason while the socket is down, confirm when
   * it is up, and either way end the tap in a sentence.
   *
   * `tools/eslint/rules.js`'s `no-silent-send` is the build-time half — it
   * refuses a socket write in an event handler that says nothing.
   */
  function liveSend(frame: ClientMessage, done: string, blocked?: string): boolean {
    if (connRef.current.status !== "open") {
      showToast(blocked ?? "no connection — the desktop didn't get that. Try again when the link is back.");
      return false;
    }
    send(frame);
    showToast(done);
    return true;
  }
  /**
   * **The same, for N frames that are ONE decision: one tap, one receipt.**
   *
   * Some verbs are per-row on the wire and per-CUT on screen — *drop the clocks
   * on these 7* is seven `intent.update`s, because there is no batch frame for
   * it. Calling the single-row helper in a loop gave seven identical toasts and
   * seven rows in the toast log, which is the notification feed reporting one
   * decision seven times and never reporting the count, the one thing about it
   * a reader cannot see for themselves.
   *
   * Every frame goes or none does: the refusal is about the LINK, which is the
   * same for all of them, so a half-sent batch is not a state this can reach.
   */
  function liveSendAll(frames: ClientMessage[], done: string, blocked?: string): boolean {
    if (!frames.length) return false;
    if (connRef.current.status !== "open") {
      showToast(blocked ?? "no connection — the desktop didn't get that. Try again when the link is back.");
      return false;
    }
    for (const f of frames) send(f);
    showToast(done);
    return true;
  }
  /**
   * The same guard for a READ ("refresh this list", "re-check").
   *
   * A read needs no confirmation toast: the screen filling in IS the receipt,
   * and a sentence on top of it is noise. What it does need is the other half —
   * saying so when the question could not be asked at all, which is the case
   * that otherwise looks identical to a list that is simply empty.
   */
  function liveAsk(frame: ClientMessage, blocked = "no connection — the host can't be asked from here"): boolean {
    if (connRef.current.status !== "open") { showToast(blocked); return false; }
    send(frame);
    return true;
  }

  // Debounce the connection banner (see connVisible). Open → hide at once; any
  // non-open state has to outlast the grace window before it shows.
  //
  // Measured from the last moment the socket was actually OPEN, never from the
  // last status CHANGE. `ws.ts` retries a second after every close, so a link
  // that is neither up nor down cycles closed → connecting → closed about once
  // a second, and a timer restarted on each transition never reaches 1.8 s: the
  // worst link this app exists for was the one state that showed NO banner, and
  // where "+" never took the offline detour (openRepo gates on connVisible) —
  // so the tap queued a create with the link flapping and the launcher went on
  // claiming everything was fine. Seeded at mount, so a cold start still gets
  // the full grace window instead of a banner flash.
  const lastOpenAtRef = useRef(Date.now());
  useEffect(() => {
    if (status === "open") { lastOpenAtRef.current = Date.now(); setConnVisible(false); return; }
    const wait = Math.max(0, CONN_GRACE_MS - (Date.now() - lastOpenAtRef.current));
    const t = window.setTimeout(() => setConnVisible(true), wait);
    return () => window.clearTimeout(t);
  }, [status]);

  return {
    connRef, status, setStatus, connVisible,
    info, setInfo, noteWelcome,
    send, liveSend, liveSendAll, liveAsk,
    reconnectAsk, setReconnectAsk,
  };
}

export type Connection = ReturnType<typeof useConnection>;
