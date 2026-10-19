import { ArrowDown, ArrowUp, CircleCheck, CloudUpload, Globe, RefreshCcw, Router } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { restartLine, restartView, subscribeRestart } from "./link/hostRestart";
import {
  PULSE_CAP, fmtRate, fmtTotal, lastSyncEver, summarize, useLink, whenText,
  type LinkSnapshot, type LinkSync, type LinkTraffic, type PulseSample,
} from "./link";
import { dur } from "./format";
import { useHostRoute } from "./hostRoute";

/**
 * The permanent connection strip — a dot, a latency graph and a number, pinned
 * to the top of every screen while it is switched on.
 *
 * Everything else in the app reports the link only when something has already
 * gone wrong: the connection banner appears on a drop, `NetActivity` appears
 * once a request is slow, the health sheet has to be opened. All three answer
 * *after* the fact, and none of them answers the question that actually gets
 * asked on a bad tunnel — "is it bad right now, or is the app just slow?".
 * That question is asked from whatever screen you happen to be on, so this is
 * fixed to the viewport and the screens make room for it (`--ui-pulse-h`)
 * rather than being covered by it: a strip that hides a sheet's own header
 * would have traded one blind spot for another.
 *
 * Why a graph and not a number: a mean cannot tell 250 ms steady apart from
 * 30 ms with every fourth ping lost, and those two links feel nothing alike —
 * the second is the one where a prompt seems to vanish. Misses are therefore
 * drawn as their own full-height marks rather than being left out of an
 * average, which is also why the offline stretches are drawn at all.
 *
 * Every reading on the strip is its own tap target, and each one opens the
 * health sheet AT ITS OWN SECTION (`app:open-nethealth` carries a focus, which
 * the sheet scrolls to and flashes). Four separate facts share 22 px, so they
 * can only be shown as a shape and a number here — "2 sends stuck" and "2.0 MB"
 * both invite the question "which?", and answering it by dropping the reader at
 * the top of a six-section sheet makes them go hunting. Each segment also
 * carries its own `data-hint`, so a long press explains that reading rather
 * than the strip as a whole.
 *
 * Reading the graph: it is the last `GRAPH_N` PROBES, not a time axis. A gap
 * while the page was backgrounded leaves no samples (nothing is measured on a
 * phone in a pocket), so the marks are not evenly spaced in time and the strip
 * does not pretend otherwise.
 *
 * The middle carries the fact neither of those covers: whether what is on the
 * screen is CURRENT. Offline it counts up from the last frame the host sent — an
 * app that keeps rendering from snapshots (which this one does, deliberately)
 * has to say how old they are, since a session list from before a fifteen-minute
 * dead stretch looks exactly like one from a second ago. Online it is the age of
 * the last full sync, which is the OLDER of the session list and the repo
 * listing: they refresh over different transports and only the older one
 * describes the whole screen.
 *
 * The right-hand half is the other thing a link does: VOLUME. Latency alone
 * cannot tell an idle socket from one saturated by a 20 MB download, and on a
 * metered SIM the second number people want is not "how good" but "how much".
 * Rates only appear once something is actually moving — a readout that never
 * reads zero cannot say "nothing is happening" — while the totals stay put,
 * because they are the figure you go looking for.
 *
 * **What the red slot says, and what it used to say.** It used to read "54 pings
 * lost", which is the wrong fact in the most valuable place on the strip: a lost
 * ping is already drawn, as its own full-height mark, three pixels to the left —
 * so the words restated the graph — and, more to the point, a lost ping costs
 * nothing. Nothing typed goes missing because a probe went unanswered, and a
 * red sentence that means "no action required" is a red sentence that teaches
 * people to ignore red. The count is still kept and still worth reading; it
 * lives in the sheet's *Link right now* section, next to the window it is true
 * over. What is in the slot instead is the one link fact that IS an action:
 * sends that gave up. Those are prompts written on this phone that never
 * reached a session, they do not resolve themselves, and the tap goes straight
 * to the list of them with their words and their repos. The slot is empty when
 * there are none, exactly as the loss chip was — a strip that is quiet on a good
 * link is what makes it worth glancing at on a bad one.
 */

/** Probes drawn. Fewer than the window the store keeps: the median wants more
 *  samples than 84 px of screen can show without turning into a smear. */
const GRAPH_N = 30;
const W = 84;
const H = 16;

/** Ask App for the health sheet, at a section. Stops the event so a segment tap
 *  doesn't also fire the strip's own generic open behind it. */
function openHealth(focus: "link" | "currency" | "data" | "sends", e?: { stopPropagation(): void }): void {
  e?.stopPropagation();
  try { window.dispatchEvent(new CustomEvent("app:open-nethealth", { detail: { focus } })); } catch { /* no DOM */ }
}

function Spark({ samples, ceiling }: { samples: readonly PulseSample[]; ceiling: number }) {
  // Right-aligned: the newest sample is always at the right edge and older ones
  // march left, so a window that is not yet full grows into the space instead of
  // stretching a handful of points across it and implying a history that isn't
  // there.
  const shown = samples.slice(-GRAPH_N);
  const step = W / (GRAPH_N - 1);
  const x = (i: number) => W - (shown.length - 1 - i) * step;
  const y = (ms: number) => H - Math.min(1, ms / ceiling) * (H - 1) - 0.5;

  // One polyline per unbroken run of answered probes. Bridging a miss would draw
  // a line across the exact event the graph exists to show.
  const runs: string[] = [];
  let run: string[] = [];
  for (let i = 0; i < shown.length; i++) {
    const s = shown[i];
    if (s.ms == null) { if (run.length > 1) runs.push(run.join(" ")); run = []; continue; }
    run.push(`${x(i).toFixed(1)},${y(s.ms).toFixed(1)}`);
  }
  if (run.length > 1) runs.push(run.join(" "));
  // A lone answered probe between two misses has no line to be part of; draw it
  // as a point so it isn't silently dropped.
  const dots = shown
    .map((s, i) => (s.ms != null
      && (i === 0 || shown[i - 1].ms == null)
      && (i === shown.length - 1 || shown[i + 1].ms == null) ? { i, ms: s.ms } : null))
    .filter((d): d is { i: number; ms: number } => d != null);

  return (
    <svg className="np-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      {shown.map((s, i) => (s.ms == null ? (
        <rect key={`m${i}`} x={Math.max(0, x(i) - step / 2)} y={0} width={Math.max(1.5, step)} height={H} className="np-miss" />
      ) : null))}
      {runs.map((pts, i) => <polyline key={`r${i}`} points={pts} className="np-line" />)}
      {dots.map((d) => <circle key={`d${d.i}`} cx={x(d.i)} cy={y(d.ms)} r={1.2} className="np-dot" />)}
    </svg>
  );
}

/** Down and up: current rate when there is one, and the total either way.
 *  Two lucide arrows rather than words — 22 px of strip has room for numbers or
 *  for labels, not both, and the arrows survive being read at a glance. */
function Traffic({ t }: { t: LinkTraffic }) {
  const dn = fmtRate(t.downRate);
  const up = fmtRate(t.upRate);
  return (
    <span
      className="np-traf"
      role="button"
      data-hint="net.pulse.data"
      title={`downloaded ${fmtTotal(t.down)} · uploaded ${fmtTotal(t.up)} since ${new Date(t.since).toLocaleDateString()} — tap for the breakdown`}
      onClick={(e) => openHealth("data", e)}
    >
      <span className={`np-tr${dn ? " live" : ""}`}>
        <ArrowDown size={10} aria-hidden="true" />
        {dn ? <span className="np-rate">{dn}</span> : null}
        <span className="np-tot">{fmtTotal(t.down)}</span>
      </span>
      <span className={`np-tr${up ? " live" : ""}`}>
        <ArrowUp size={10} aria-hidden="true" />
        {up ? <span className="np-rate">{up}</span> : null}
        <span className="np-tot">{fmtTotal(t.up)}</span>
      </span>
    </span>
  );
}

/** Age of the screen's data, in the gap between the graph and the volume — the
 *  one slot on this strip that is otherwise empty, and while the link is down
 *  the most useful thing on it. */
function Freshness({ s }: { s: LinkSync }) {
  if (!s.online) {
    return (
      <span className="np-when stale" role="button" data-hint="net.pulse.when" onClick={(e) => openHealth("currency", e)}
        title={`last connected: ${whenText(s.lastSeenAt)} — tap for what is and isn't current`}>
        {s.lastSeenAt ? `last seen ${dur(s.lastSeenAt)}` : "never connected"}
      </span>
    );
  }
  if (s.syncedAt == null) {
    // Connected, but one of the two halves has not come back on THIS socket. Say
    // which — "syncing" that never resolves is a bug report, and the half that is
    // missing is the whole hint.
    return (
      <span className="np-when busy" role="button" data-hint="net.pulse.when" onClick={(e) => openHealth("currency", e)}
        title={`waiting for: ${s.pending.join(", ")} — tap for what is and isn't current`}>
        syncing {s.pending.join("+")}…
      </span>
    );
  }
  return (
    <span className="np-when" role="button" data-hint="net.pulse.when" onClick={(e) => openHealth("currency", e)}
      title={`last full sync: ${whenText(s.syncedAt)} (session list + repo listing) — tap for detail`}>
      synced {dur(s.syncedAt)}
    </span>
  );
}

/**
 * The prompts that never made it, in the strip's one red slot.
 *
 * Rendered only when there is at least one, and it names what it is: these are
 * SENDS, not pings — text written on this phone that never reached a session,
 * still kept, still sendable, and waiting on a decision. The tap lands on the
 * list of them rather than at the top of the sheet, because "which ones?" is
 * the only next question this number has.
 */
function Stuck({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="np-loss" role="button" data-hint="net.pulse.sends"
      title={`${n} send${n > 1 ? "s" : ""} gave up and ${n > 1 ? "have" : "has"} not been dealt with — written here, never typed into a session, so nothing ran. The words are kept. Tap for the list, with the repo each was written for`}
      onClick={(e) => openHealth("sends", e)}>{n} send{n > 1 ? "s" : ""} stuck</span>
  );
}

/**
 * **The green check: everything this phone wrote is on the desktop.**
 *
 * The strip's other readings are all about the LINK. This one is about your
 * words, and it is the question actually asked before putting the phone in a
 * pocket — not "is the tunnel good" but "did that arrive, can I stop looking at
 * this". Nothing on any screen answered it: a schedule armed, a note typed and
 * a prompt queued looked identical whether the desktop had them or whether they
 * were sitting in a phone that had been off the tunnel all afternoon.
 *
 * Three states, and the empty one is a state too:
 *
 *  - something outstanding ⇒ the COUNT, in the app's "on its way" colour. A
 *    number, because "2 not saved" and "17 not saved" are different afternoons.
 *  - nothing outstanding, and there once was ⇒ the green check.
 *  - nothing outstanding and nothing ever was ⇒ NOTHING, which is why this does
 *    not turn a quiet strip into a busy one. `everOutstanding` is that gate.
 *
 * It is withheld while a send is STUCK, even though a stuck send is not
 * outstanding (it is not going anywhere on its own). "All saved" beside "1 send
 * stuck" is a contradiction, and of the two the red one is the one to believe —
 * so this yields and the slot next door speaks.
 *
 * **What gives way when 22 px is not enough.** The strip has a stated order of
 * sacrifice and this reading had to be fitted INTO it, not bolted on: measured
 * at 412 px with a rate showing, a rigid segment here pushed the freshness label
 * — the one that matters most when the link is down — into an ellipsis. So the
 * green case is one short word and its span is the part that clips: the CHECK is
 * `flex: 0 0 auto` and survives any squeeze, because a green mark with its
 * sentence in the title, the hint and the sheet is still the answer, while half
 * a word is not. The count does NOT clip — "3" with the word gone is a reading,
 * "unsav…" is not, and a number that might be truncated is worse than no number.
 */
function Saved({ outstanding, ever, stuck }: { outstanding: number; ever: boolean; stuck: number }) {
  if (outstanding > 0) {
    return (
      <span className="np-unsaved" role="button" data-hint="net.pulse.saved"
        title={`${outstanding} thing${outstanding > 1 ? "s" : ""} written here that the desktop does not have yet — queued sends and settings still to push. They go as soon as the link allows. Tap for what is outstanding`}
        onClick={(e) => openHealth("sends", e)}>
        <CloudUpload size={10} aria-hidden="true" /> {outstanding}<span className="np-sv-t">&nbsp;unsaved</span>
      </span>
    );
  }
  if (!ever || stuck > 0) return null;
  return (
    <span className="np-saved" role="button" data-hint="net.pulse.saved"
      title="everything written on this phone has reached the desktop and been stored there — nothing is waiting on this device. Tap for the detail"
      onClick={(e) => openHealth("sends", e)}>
      <CircleCheck size={10} aria-hidden="true" /><span className="np-sv-t">&nbsp;saved</span>
    </span>
  );
}

/**
 * Which way the desktop is reached: its LAN address or the tailnet
 * (`lanLink.ts`). An icon and a word — the WHY is a sentence, and a sentence
 * does not fit 22 px, so the tap opens the health sheet's link section, which
 * prints it. Nothing drawn until the route is known.
 */
function RouteChip() {
  const route = useHostRoute();
  if (!route) return null;
  const lan = route.route === "lan";
  return (
    <span className={`np-route${lan ? " np-route-lan" : ""}`} role="button" data-hint="net.pulse.route"
      onClick={(e) => openHealth("link", e)}>
      {lan ? <Router size={10} aria-hidden="true" /> : <Globe size={10} aria-hidden="true" />}
      <span>{lan ? "LAN" : "tailnet"}</span>
    </span>
  );
}

/**
 * The switch, and nothing else.
 *
 * Split from the strip below so that a strip which is turned OFF holds no
 * subscription at all: `Strip` asks for the `live` clock — every reading on it
 * is a "how long ago" or a rate — and that ticker stops with its last listener.
 * Reading `enabled` out here instead is event-driven and costs nothing, which is
 * the point: the file measuring what the app costs a phone must not be the
 * reason it wakes up.
 */
export function NetPulseBar() {
  const enabled = useLink((s) => s.pulse.enabled);

  // The strip's own height is published as a CSS variable rather than measured
  // by every screen: `.screen` and `.sheet` add it to their top padding, so one
  // number keeps every view clear of the bar — including sheets written later,
  // which is the whole reason it is a variable and not a per-screen <NetPulse>.
  useEffect(() => {
    document.documentElement.style.setProperty("--ui-pulse-h", enabled ? "22px" : "0px");
    return () => { document.documentElement.style.removeProperty("--ui-pulse-h"); };
  }, [enabled]);

  return enabled ? <Strip /> : null;
}

function Strip() {
  const s = useLink<LinkSnapshot>((x) => x, true);
  const { status, samples } = s.pulse;
  const sum = summarize(samples);
  // A desktop restart outranks freshness: it is WHY nothing is syncing. The
  // strip already ticks every second (`useLink(…, true)`), so the count runs.
  const restart = restartLine(useSyncExternalStore(subscribeRestart, restartView), Date.now());
  const open = status === "open";
  const label = status === "open"
    ? (sum.last != null ? `${Math.round(sum.last)} ms` : sum.median != null ? `${Math.round(sum.median)} ms` : "…")
    : status === "connecting" ? "connecting" : "offline";
  // The median is the second number worth the space: one slow probe on a link
  // that is otherwise fine should not be the only figure on screen.
  const sub = open && sum.median != null && sum.last != null && Math.abs(sum.last - sum.median) > 40
    ? `~${Math.round(sum.median)}` : null;

  return (
    <div
      className={`net-pulse np-${status}${sum.misses ? " np-lossy" : ""}`}
      role="status"
      data-hint="net.pulse"
      title={`connection: ${status}${sum.median != null ? ` · median ${Math.round(sum.median)} ms` : ""}${sum.misses ? ` · ${sum.misses} of the last ${Math.min(samples.length, PULSE_CAP)} pings unanswered` : ""} · ${fmtTotal(s.traffic.down)} down / ${fmtTotal(s.traffic.up)} up since ${new Date(s.traffic.since).toLocaleDateString()} · last connected ${whenText(s.sync.lastSeenAt)} · last full sync ${whenText(s.sync.syncedAt ?? lastSyncEver())} — tap for connection health`}
      onClick={() => openHealth("link")}
    >
      <span className="np-led" />
      {/* Dot, graph and number are one reading — the state of the link — so they
          are one target rather than three neighbouring ones a thumb can't
          separate at this height. The unanswered probes are still IN the graph,
          drawn as their own marks; what left this strip is only the sentence
          counting them, which said nothing the marks did not. */}
      <span className="np-link" role="button" data-hint="net.pulse.graph" onClick={(e) => openHealth("link", e)}>
        <Spark samples={samples} ceiling={sum.ceiling} />
        <span className="np-ms">{label}{sub ? <span className="np-med"> {sub}</span> : null}</span>
      </span>
      <RouteChip />
      {restart
        ? <span className={`np-restart${restart.slow ? " np-restart-slow" : ""}`}>
            <RefreshCcw size={10} aria-hidden="true" /><span>{restart.text}</span>
          </span>
        : <Freshness s={s.sync} />}
      <span className="np-right">
        <Saved outstanding={s.outstanding} ever={s.everOutstanding} stuck={s.stuckSends} />
        <Stuck n={s.stuckSends} />
        <Traffic t={s.traffic} />
      </span>
    </div>
  );
}
