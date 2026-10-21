/**
 * Connection health (Settings → Tools → connection health).
 *
 * `SpeedTestSheet` answers "how fast is the link right now?". This answers the
 * question that actually costs work: "what has this link been DOING to my
 * prompts?" — which is only answerable in hindsight, and until now was not
 * answerable at all. The two halves come from opposite ends of the tunnel and
 * neither is meaningful alone:
 *
 *   • this device (`link.ts`) — round trip, how much of the window had no
 *     socket, how often the watchdog gave up and reloaded the page, how long a
 *     message actually sat in the queue before it was confirmed, and how much
 *     data the app has moved — the one number a metered SIM asks for, and the
 *     one that says whether a slow moment was congestion of our own making;
 *   • the host (netstats.ts) — sockets and their close codes, and the outcome
 *     of every verified delivery: started / never appeared on screen / typed but
 *     the Return was swallowed.
 *
 * The verdict line at the top is the whole reason the sheet exists. "Prompts go
 * missing sometimes" is a symptom with four completely different causes, and
 * the numbers below separate them: text never leaving the phone, receipts not
 * coming back, deliveries the host could not confirm, or the app being reloaded
 * out from under the queue.
 */
import { stateRel } from "@waterplane/shared";
import { useEffect, useRef, useState } from "react";
import { Activity, CircleCheck, CloudUpload, Globe, ListOrdered, RotateCcw, KeyRound, Router, Settings2 } from "lucide-react";
import { readStorageState, storageState, type StorageState } from "./persist";
import {
  PULSE_CAP, fmtMs as ms, fmtRate, fmtSince as since, fmtTotal, lastSyncEver, linkVerdict,
  resetLinkWindow, summarize, useLink, whenText, type HostLinkStats, type LinkSnapshot,
} from "./link";
import { dur, fmtStorage } from "./format";
import { api } from "./api";
import { SheetHead } from "./Sheet";
import { useHostRoute, useHostRouteEditor } from "./hostRoute";
import { NO_PASSWORD_SENTENCE } from "./lanRoute";
import { openSettingsAt } from "./settingsFocus";
import { Button } from "./kit/Button";

const ICON = 16;

/** Which part of the connection strip sent the user here. The strip is four
 *  separate readings in 22 px, and a tap on one of them that lands on the top of
 *  a six-section sheet is a tap that has to be followed by a hunt — so the
 *  segment names what it is about and the sheet goes there. `sends` is the red
 *  slot, and the section it lands on is the only one on this screen with names
 *  in it. */
export type NetHealthFocus = "sends" | "link" | "currency" | "data";

interface Props {
  onClose: () => void;
  onToast: (text: string) => void;
  /**
   * How many messages are sitting in the send queue having given up, and the way
   * to them.
   *
   * This screen counted them and then said "their text is in the recovery bar",
   * which is true and useless: the recovery bar is on another screen, appears
   * only when it feels like it, and offers a retry of exactly what already
   * failed. A number nobody can act on is worse than no number — it reads as a
   * report on a problem that is being handled. So the count is a button.
   */
  notDelivered: number;
  /** Section to scroll to and flash on open (see `NetHealthFocus`). */
  focus?: NetHealthFocus;
  /**
   * Open Activity — where the sends that stopped now live, one row each.
   *
   * This sheet used to render that list itself, off a separate ledger keyed by
   * ackId that kept a 200-character head of each message for a day. It existed
   * because the send queue retired a failed row after an hour and moved its
   * words to the pad, so by the time anyone read the counter there was nothing
   * left to point at. Nothing retires now: the row keeps its full words and the
   * repo they were written for, for as long as it takes, and Activity is the
   * one screen that shows every posted piece of work in that shape. A second
   * list here could only be a clipped copy of it.
   */
  onOpenActivity: () => void;
  /**
   * Open the storage breakdown — what the `used` figure below is actually made
   * of, and the only screen that can free any of it (`StorageSheet.tsx`).
   *
   * This section has always said how much the app is holding and whether the
   * browser may drop it. Neither sentence tells you which part is a thumbnail
   * cache that refills in a second and which part is the only copy of a photo
   * nobody has sent — and it is the second kind that the eviction warning
   * right above is about.
   */
  onOpenStorage: () => void;
}

function Stat({ label, value, note, onClick, title }: { label: string; value: string; note?: string; onClick?: () => void; title?: string }) {
  const body = (
    <>
      <span className="nh-stat-v">{value}</span>
      <span className="nh-stat-l">{label}</span>
      {note && <span className="nh-stat-n">{note}</span>}
    </>
  );
  // A figure that can be itemised is a DOOR, not a read-out: `used 340 MB` was
  // a number nobody could act on, sitting on the one screen where somebody had
  // gone looking for something to act on (the `notDelivered` count's lesson,
  // two doc comments down). A count on a control is a filter — this one opens
  // exactly the breakdown of the bytes it names.
  return onClick
    ? <button type="button" className="nh-stat nh-stat-door" onClick={onClick} title={title}>{body}</button>
    : <div className="nh-stat" title={title}>{body}</div>;
}

export function NetHealthSheet({ onClose, onToast, notDelivered, onOpenActivity, onOpenStorage, focus }: Props) {
  const [host, setHost] = useState<HostLinkStats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [armed, setArmed] = useState(false); // two-tap guard on reset
  // ONE subscription for the whole device half. This screen used to stitch four
  // stores together by hand — a poll for the counters, three subscriptions for
  // the rest — which is how it came to render a green socket beside a "last
  // connected 14m ago": four readings of the same link, taken at four different
  // moments, with nothing making them agree. They are one snapshot now, and
  // `live` is what keeps the elapsed labels moving.
  const link = useLink<LinkSnapshot>((s) => s, true);
  const me = link.log;
  const traf = link.traffic;
  const sync = link.sync;
  const pulse = link.pulse;
  // Scroll the section the strip pointed at into view and flash it, once. The
  // flash is what makes the jump legible — a sheet that silently opens
  // mid-document reads as a sheet that opened at the wrong place.
  const focusRef = useRef<HTMLElement | null>(null);
  const route = useHostRoute();
  const editRoute = useHostRouteEditor();
  useEffect(() => {
    const el = focusRef.current;
    if (!focus || !el) return;
    el.scrollIntoView({ block: "start" });
    el.classList.add("nh-flash");
    const t = window.setTimeout(() => el.classList.remove("nh-flash"), 1400);
    return () => window.clearTimeout(t);
  }, [focus]);
  const [store, setStore] = useState<StorageState>(() => storageState());

  async function load() {
    setErr(null);
    try {
      setHost(await api.netstats.get<HostLinkStats>());
    } catch (e) {
      // A failed fetch is itself a data point, and the device half still renders
      // — which is the half that works when the host is unreachable.
      setErr(String((e as Error)?.message || e));
    }
  }
  // The host half is a fetch, asked once on open; the device half arrives on
  // the subscription above and needs no timer. There used to be a 5 s tick here
  // for the give-ups ledger, which was localStorage and had no emit of its own —
  // it went with the ledger.
  useEffect(() => { void load(); }, []);
  // Re-read rather than re-request: `main.tsx` already asked once at boot, and
  // the browser's answer does not change within a session.
  useEffect(() => { void readStorageState().then(setStore); }, []);

  const v = linkVerdict(me, host, notDelivered);
  const d = host?.delivery;
  // The unconfirmed count is the host's running total for the window, so it
  // only goes down when the window does — the clear beside it IS the reset.
  const stuck = (d?.unsubmitted ?? 0) + (d?.unconfirmed ?? 0);
  function resetWindow() {
    if (!armed) { setArmed(true); onToast("tap again to reset the window"); return; }
    setArmed(false);
    resetLinkWindow();
    // Counters only. The sends themselves are rows in Activity and
    // are not this button's to clear — resetting a window must never
    // be a way to delete somebody's words.
    void api.netstats.reset().then(() => load(), () => load());
    onToast("connection stats reset");
  }
  // While offline `syncSnapshot()` reports no CURRENT sync (correctly — nothing
  // is current), but the number being asked for is when the last one happened,
  // which outlives the socket.
  const syncAge = sync.syncedAt ?? lastSyncEver();
  const pulseSum = summarize(pulse.samples);
  const probes = pulse.samples.length;
  const codes = Object.entries(host?.sockets.closeCodes ?? {}).sort((a, b) => b[1] - a[1]);
  const meanLife = host && host.sockets.closed > 0 ? host.sockets.totalOpenMs / host.sockets.closed : null;
  return (
    <div className="sheet">
      <SheetHead title="Connection health" icon={<Activity size={ICON} />} onClose={onClose}>
        <Button title="re-read the host's own counters" onClick={() => void load()}><RotateCcw size={ICON} /></Button>
      </SheetHead>
      <div className="sheet-body">
        <p className={`nh-verdict nh-${v.tone}`}>{v.text}</p>
        {stuck > 0 && (
          <div className="set-row">
            <Button className={armed ? "active" : ""} onClick={resetWindow}>
              <RotateCcw size={ICON} /> {armed ? "tap again to clear" : "checked them — clear"}
            </Button>
            <span className="set-note">Resets this window's counters; the prompts themselves stay in Activity.</span>
          </div>
        )}

        {/* The one part of this screen that is a decision rather than a
            reading, and the only one with names in it. Rendered whenever there
            is anything to show, regardless of which verdict won above — a slow
            link and four dead prompts can be true at the same time, and the
            prompts are what matter. */}
        {/* The one part of this screen that is a decision rather than a
            reading. It used to BE the list — a second ledger, clipped to two
            hundred characters a row, that existed only because the queue
            retired a failed send an hour after it stopped and moved its words
            somewhere else. Nothing retires now, so the rows themselves are
            still the rows, with their full words and the repo they were written
            for, and they are all in one place. A count with a way through to
            them is the honest amount of this screen's business. */}
        {/**
          * "Is it all on the desktop?" — the strip's green check, spelled out.
          *
          * The section below is about sends that STOPPED. This one is about the
          * ones that have not, and the two are opposite facts that were both
          * missing from this screen: a phone can have nothing stuck and still be
          * holding an afternoon of work nobody else has a copy of.
          *
          * It takes the focus anchor when there is no stopped-sends section to
          * take it, so a tap on either strip reading lands on the one that is
          * actually there.
          */}
        <section className="set-group" ref={focus === "sends" && notDelivered === 0 ? focusRef : undefined}>
          <h3 className="set-title">On this phone only</h3>
          {link.outstanding > 0 ? (
            <span className="set-note nh-unsaved">
              <CloudUpload size={ICON} style={{ verticalAlign: "-2px" }} />{" "}
              {link.outstanding === 1 ? "One thing" : `${link.outstanding} things`} written here
              {link.outstanding === 1 ? " has" : " have"} not reached the desktop yet — queued sends and
              synced settings still to push. They go on their own as soon as the link allows; nothing
              here needs a tap.
            </span>
          ) : (
            <span className="set-note nh-saved">
              <CircleCheck size={ICON} style={{ verticalAlign: "-2px" }} />{" "}
              Everything written on this phone has reached the desktop and is stored there. Nothing is
              waiting on this device{notDelivered > 0 ? " — except the sends below, which stopped and will not go on their own" : ""}.
            </span>
          )}
        </section>

        {notDelivered > 0 && (
          <section className="set-group" ref={focus === "sends" ? focusRef : undefined}>
            <h3 className="set-title">The sends that stopped</h3>
            <span className="set-note">
              {notDelivered === 1 ? "One message" : `${notDelivered} messages`} written on this phone
              stopped short of a session. Nothing was lost and nothing expires: each one keeps its full
              words and the repo they were written for, in Activity, with the button that puts it back
              in that repo&apos;s backlog — where it opens a new session of its own.
            </span>
            <div className="set-row">
              <Button onClick={onOpenActivity}>
                <ListOrdered size={ICON} /> open the {notDelivered} in Activity
              </Button>
            </div>
          </section>
        )}

        <section className="set-group" ref={focus === "link" ? focusRef : undefined}>
          <h3 className="set-title">Link right now</h3>
          {route && (
            <div className="set-note nh-route">
              {route.route === "lan" ? <Router size={14} aria-hidden="true" /> : <Globe size={14} aria-hidden="true" />}
              <span>{route.sentence}</span>
            </div>
          )}
          {/* The sentence reports settings (LAN address, auto-switch); the
              place they change is one tap away, not three screens. */}
          {route && editRoute && (
            <div className="set-row">
              <Button onClick={editRoute}>
                <Settings2 size={ICON} /> change LAN settings
              </Button>
              {/* This one is the host's setting, not the phone's form. */}
              {route.sentence === NO_PASSWORD_SENTENCE && (
                <Button onClick={() => openSettingsAt("lan-password")}>
                  <KeyRound size={ICON} /> set the LAN password
                </Button>
              )}
            </div>
          )}
          {/* The detail behind the strip's dot, graph and loss count. The strip
              has 22 px and can only show the shape; the numbers it is drawn
              from belong here, next to the window they are true over. */}
          <div className="nh-stats">
            <Stat label="socket" value={link.status} note={pulse.enabled ? undefined : "strip is off — no probes running"} />
            {/* A miss and "no probes yet" are different facts and used to print
                the same dash — next to a median that was plainly measured, the
                dash read as a broken reading rather than as the last probe
                getting no answer. */}
            <Stat label="last ping"
              value={pulseSum.last != null ? ms(pulseSum.last) : probes ? "no reply" : "—"}
              note={pulseSum.last == null && probes ? "the newest probe timed out" : undefined} />
            {/* The median is of the replies only, so with misses in the window
                the note counts those, not every probe sent. */}
            <Stat label="median ping" value={ms(pulseSum.median ?? undefined)}
              note={!probes ? undefined
                : pulseSum.misses ? `over the ${probes - pulseSum.misses} replies of the last ${probes} probes`
                : `over the last ${probes} probe${probes > 1 ? "s" : ""}`} />
            {/* The count the strip used to carry, in the one place it can be
                read next to the window it is true over. It came off the strip
                because a lost ping costs nothing — nothing typed goes missing
                because a probe went unanswered — and a red sentence that means
                "no action required" in the app's most valuable 22 px teaches
                people to ignore red. It is still a real reading of the link,
                which is why it is still here and still separate from the
                median. */}
            <Stat
              label="unanswered pings"
              value={`${pulseSum.misses}`}
              note={pulseSum.misses ? `of the last ${probes} — drawn, never averaged` : "every probe came back"}
            />
          </div>
          {!pulse.enabled && (
            <div className="set-row">
              <Button onClick={() => openSettingsAt("net-pulse")}>
                <Settings2 size={ICON} /> turn the connection strip on
              </Button>
            </div>
          )}
          <span className="set-note">
            Probes go out every 3 s while the app is on screen and are kept as the last {PULSE_CAP}; a phone in
            a pocket measures nothing, so this window is a count of pings, not a stretch of time. An
            unanswered probe is its own kind of event — a link losing one ping in four feels nothing like a
            slow one, and only the first eats prompts — so it is counted here rather than folded into the
            median. It is a ping, though, not a prompt: nothing you typed was lost because one went
            missing, which is why the strip draws them in the graph and no longer spells them out. This
            readout never acts: a missed probe reconnects nothing.
          </span>
        </section>

        <section className="set-group">
          <h3 className="set-title">Delivery — last {since(me.since)}</h3>
          <div className="nh-stats">
            <Stat label="confirmed" value={String(me.sent)} note="typed, echoed, turn started" />
            <Stat label="gave up" value={String(me.failed)} note="each one keeps its own row, in full, in Activity" />
            <Stat label="typical wait" value={ms(me.sendP50)} note="queued → running" />
            <Stat label="worst wait" value={ms(me.queuedMaxMs)} />
          </div>
          {d && (
            <div className="nh-stats">
              <Stat label="host: started" value={String(d.ok)} />
              <Stat label="host: not ready" value={String(d.retry)} note="nothing typed — safe to resend" />
              <Stat label="host: unconfirmed" value={String(d.unconfirmed)} note="never seen on screen" />
              <Stat label="host: unsubmitted" value={String(d.unsubmitted)} note="in the composer, Return swallowed" />
            </div>
          )}
          <span className="set-note">
            A confirmed send means the host typed the prompt, saw it echo and proved the turn started — not
            just that bytes reached the machine. The last two host counters are the ones that used to be
            invisible: the prompt is on the far side, so re-sending it stacks a second copy.
          </span>
        </section>

        <section className="set-group">
          <h3 className="set-title">This device</h3>
          <div className="nh-stats">
            <Stat label="ping (median)" value={ms(me.rttP50)} />
            <Stat label="ping (p95)" value={ms(me.rttP95)} note="what deadlines are sized from" />
            <Stat label="offline" value={`${Math.round(me.offlineShare * 100)}%`} note="of the window" />
            <Stat label="reconnects" value={String(me.reconnects)} />
            <Stat label="forced reloads" value={String(me.reloads)} note="watchdog gave up on the socket" />
            <Stat label="missed receipts" value={String(me.ackTimeouts)} note="deadline passed, retried" />
          </div>
        </section>

        <section className="set-group" ref={focus === "currency" ? focusRef : undefined}>
          <h3 className="set-title">Currency</h3>
          {/* Not "is the socket up" — whether what the screens are drawing is
              true. The app deliberately keeps rendering from snapshots when the
              host is unreachable, so the age of those snapshots is a fact it
              owes the user rather than one to hide. */}
          <div className="nh-stats">
            <Stat
              label={sync.online ? "connected" : "last connected"}
              value={sync.online ? `for ${dur(sync.connectedSince ?? Date.now())}` : sync.lastSeenAt ? dur(sync.lastSeenAt) + " ago" : "never"}
              note={whenText(sync.online ? sync.connectedSince : sync.lastSeenAt)}
            />
            <Stat
              label="last full sync"
              value={syncAge == null ? "never" : `${dur(syncAge)} ago`}
              note={syncAge == null ? "no session list + repo listing yet" : whenText(syncAge)}
            />
          </div>
          {sync.online && sync.syncedAt == null && (
            <p className="set-note">
              Connected, but still waiting on {sync.pending.join(" and ")} for this socket — until they land, the
              lists on screen are from before the reconnect.
            </p>
          )}
          <span className="set-note">
            “Last connected” is the newest frame the desktop actually sent, not the last time the socket
            claimed to be open — a tunnel can die under a socket that still reads as connected. A full sync
            is both halves the main screen is built from: the session list, pushed over the socket, and the
            repo listing, which is a separate HTTP call and can be stale on its own. The time shown is the
            older of the two, because that is when everything on screen was last current.
          </span>
        </section>

        <section className="set-group" ref={focus === "data" ? focusRef : undefined}>
          <h3 className="set-title">Data moved — last {since(traf.since)}</h3>
          {/* Volume, not quality. Everything above says how the link BEHAVES;
              this says what it cost, which is the question a metered connection
              makes people ask and which nothing here could answer. */}
          <div className="nh-stats">
            <Stat label="downloaded" value={fmtTotal(traf.down)} note={fmtRate(traf.downRate) ? `${fmtRate(traf.downRate)} right now` : undefined} />
            <Stat label="uploaded" value={fmtTotal(traf.up)} note={fmtRate(traf.upRate) ? `${fmtRate(traf.upRate)} right now` : undefined} />
          </div>
          <span className="set-note">
            Counted in this app: requests by their declared length (so gzip is already off it), images and
            other page loads by what actually came off the network — a thumbnail served from the on-device
            cache costs nothing here, correctly — and socket frames as their payload before compression,
            which over-states a busy terminal. Files a background download fetched while the app was closed
            are not in here. It is a usage readout, not a bill.
          </span>
        </section>

        <section className="set-group">
          <h3 className="set-title">On-device storage</h3>
          {/* Queued photos, partial downloads and the reconstructed scrollback
              are the only copies of what they hold. Without persistence the
              browser may drop the lot under storage pressure with no prompt and
              no notification — so say which of the two states this device is in,
              and what the user can do about it. */}
          <div className="nh-stats">
            <Stat
              label="eviction"
              value={!store.supported ? "unknown" : store.persisted ? "protected" : "possible"}
              note={!store.supported
                ? "this browser won’t say"
                : store.persisted
                  ? "queued photos and downloads are safe"
                  : "queued photos may be dropped when space runs low"}
            />
            <Stat label="used" value={fmtStorage(store.usage)}
              note={store.quota ? `of ${fmtStorage(store.quota)} — tap to itemise` : "tap to itemise"}
              title="what this phone is holding, store by store, and what clearing any of it would cost"
              onClick={onOpenStorage} />
          </div>
          {store.supported && !store.persisted && (
            <p className="set-note">
              Installing this app to the home screen usually earns persistent storage — until then,
              anything queued offline is best-effort.
            </p>
          )}
        </section>

        <section className="set-group">
          <h3 className="set-title">Host {host ? `— last ${since(host.since)}` : ""}</h3>
          {err && <p className="set-note">Couldn’t read the host’s side: {err}</p>}
          {host && (
            <>
              <div className="nh-stats">
                <Stat label="sockets opened" value={String(host.sockets.opened)} />
                <Stat label="mean socket life" value={ms(meanLife)} note={host.sockets.minOpenMs != null ? `shortest ${ms(host.sockets.minOpenMs)}` : undefined} />
                <Stat label="receipts lost" value={String(host.ackReplays)} note="retries that found the work done" />
                <Stat label="devices" value={String(Object.keys(host.clients).length)} />
              </div>
              {codes.length > 0 && (
                <span className="set-note">
                  Close codes: {codes.map(([c, n]) => `${c}×${n}`).join(", ")}
                  {" — "}1000 is a clean close, 1001 the phone backgrounding, 1006 the tunnel dying under the socket.
                </span>
              )}
            </>
          )}
        </section>

        <section className="set-group">
          <div className="set-row">
            <Button className={armed ? "active" : ""} onClick={resetWindow}><RotateCcw size={ICON} /> {armed ? "tap again to reset" : "reset window"}</Button>
          </div>
          <span className="set-note">
            Everything here is local: the device half lives in this browser, the host half in
            <code> {stateRel("netstats.json")}</code>. Nothing is sent anywhere.
          </span>
        </section>
      </div>
    </div>
  );
}
