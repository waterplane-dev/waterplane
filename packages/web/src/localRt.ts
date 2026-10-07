import { useEffect, useRef, useState } from "react";
import { LS, lsGet, lsJson, lsSet, lsSetJson } from "./storage.ts";
import { BRAND, envName, type ClientMessage, type HostMessage, type LoadedModel, type LocalRuntimeSample } from "@waterplane/shared";
export { modelBaseName } from "@waterplane/shared";
import type { LinkStatus } from "./link.ts";
import { showToast } from "./toast.ts";

/**
 * **The local model runner, as one store.**
 *
 * `link.ts` is the shape this follows, deliberately and line by line: one
 * writer, one document, one subscribe/emit, a `useX` hook over it, and a strip
 * that draws it. That file exists because six modules had grown four
 * independent derivations of "am I online", and two readouts disagreeing about
 * one fact is a whole bug class. This is the same fact-shaped problem one layer
 * down — "what is this desktop holding in memory right now" — and starting it as
 * six call sites would end in the same place.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * A hosted model's cost is a line on somebody's invoice. A local model's cost is
 * the machine you are driving: 18 GB resident for `qwen3-coder:30b`, measured,
 * on a desktop that was already at 59.3 GB of RSS with a nearly-full swap file.
 * Today the phone shows a session working and says nothing whatsoever about the
 * 18 GB it just paged in, or about the fact that starting a second local model
 * will evict the first and reload it from disk on every switch.
 *
 * ── The rules, and why each one is a rule ───────────────────────────────────
 *
 *  • **One writer.** `noteLocalRtSample()` is the only thing that changes what
 *    this store believes. Every reading in the app derives from it.
 *
 *  • **The ring is MEMORY ONLY** (`RING_CAP`, ~10 minutes at the host's 5 s
 *    poll). It is deliberately not persisted: a series drawn as current must BE
 *    current, and a chart rebuilt out of an hour-old buffer after a reload is
 *    precisely the stale-presented-as-live failure this readout exists to
 *    prevent. What IS persisted is the last sample and its timestamps, so an
 *    offline open can say "last seen: qwen3-coder:30b holding 18.2 GB, 2h ago"
 *    — a sentence in the past tense, which is honest, rather than a live-looking
 *    graph of a machine nobody has spoken to since breakfast.
 *
 *  • **An unreachable sample is a MISS MARK, never an average and never a
 *    bridge.** `link.ts`'s Spark rule, for its reason: "the runner is holding
 *    nothing" and "nobody could ask the runner" are opposite facts, and a line
 *    drawn across the gap hides the exact event the graph is for.
 *
 *  • **Five client states, worded apart, from one pure function**
 *    (`localRtState`). They are five different things to do about it, and
 *    collapsing any two produces a readout that is confidently wrong:
 *      1. reachable with models — the readout;
 *      2. reachable and empty — the runner is up and holding nothing;
 *      3. `reachable: false` — the runner did not answer;
 *      4. `disabled` — polling is switched off on this desktop;
 *      5. a lease sent over an open socket and NO frame back — this desktop
 *         didn't answer at all, and the likeliest reason is that its host
 *         predates this readout (an unknown `t` is ignored, never thrown: that
 *         is the wire being versioned, and it is why the host answers a watch
 *         immediately — the answer is the only thing that separates 5 from 2).
 *
 *  • **It observes, it never steers.** Nothing here touches a session, a
 *    launch, the send queue or a model choice. The strongest thing the whole
 *    feature does is put a SENTENCE under a picker (`memoryPressureNote`, in
 *    `@waterplane/shared`). CLAUDE.md: nothing applies itself.
 *
 *  • **Tokens per second is deliberately absent.** Not "not yet" in the sense
 *    of a placeholder — there is no field, no gap and no dash. Neither the
 *    runner nor opencode publishes live throughput, and the available estimate
 *    (PTY bytes over wall clock) is wrong in both directions that matter.
 *
 * ── Why the transport is structural ─────────────────────────────────────────
 *
 * `LocalRtSource` is a shape, not `HostConnection`. This module has no business
 * importing `ws.ts`, which pulls in half the app's transport — the same
 * argument `link.ts` makes for `PulseSource`, plus one this file cares about
 * more: it keeps the pure half runnable under `node --test` straight over the
 * TypeScript, which is where the five states and the provider-prefix rule are
 * pinned. `main.tsx` hands over the real connection.
 *
 * **Online-ness is not derived here.** That is `link.ts`'s one job and the thing
 * it was created to stop being re-derived; `localRtState` takes `online` as an
 * argument and the bar reads it from `useLink`. The `status` on the source is
 * used for one thing only — not writing a lease into a socket that is not open —
 * and never as a readout.
 */

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

/** ~10 minutes at the host's default 5 s poll. Long enough to show a model
 *  being loaded and evicted, short enough that it is plainly "recent". */
export const RING_CAP = 120;

/**
 * How often a lease is renewed. Comfortably under the host's 60 s lease, so a
 * missed tick (a backgrounded WebView, a reconnect) costs a renewal and not the
 * readout.
 */
export const LEASE_RENEW_MS = 25_000;

/**
 * How long a lease may go unanswered before the phone says so.
 *
 * Generous against the host's immediate reply — that frame is sent before any
 * poll timer starts, so the only things between the ask and the answer are one
 * loopback GET with a 1.5 s timeout and the tunnel. Past this, silence means
 * the desktop never understood the question.
 */
export const ANSWER_GRACE_MS = 5_000;

/**
 * Past this, a sample is not a statement about NOW.
 *
 * Used by the two places that must not act on a stale reading: the strip, which
 * switches to past tense, and `ModelField`, which withholds the pressure note
 * entirely rather than warning about models a desktop may have evicted twenty
 * minutes ago.
 */
export const SAMPLE_FRESH_MS = 30_000;

/** Writes wait for their neighbours; the flush that cannot wait is `pagehide`. */
const WRITE_DEBOUNCE_MS = 3_000;

// ────────────────────────────────────────────────────────────────────────────
// Pure rules
// ────────────────────────────────────────────────────────────────────────────

/** Bytes as the rest of this feature says them — one decimal, binary GB, the
 *  same wording `memoryPressureNote` uses, so a strip and a sentence about the
 *  same 18 GB cannot print two different numbers. */
export function gbText(bytes: number): string {
  return `${(Math.max(0, bytes) / 2 ** 30).toFixed(1)} GB`;
}

/** Is this model resident right now? Matched on the runner's name, so the id
 *  must already have been through `modelBaseName`. */
export function isResident(models: readonly LoadedModel[], name: string): boolean {
  return models.some((m) => m.name === name);
}

/** Bytes held by everything resident in one sample. */
export function heldBytes(models: readonly LoadedModel[]): number {
  return models.reduce((n, m) => n + (Number.isFinite(m.size) ? m.size : 0), 0);
}

/**
 * The ring as something drawable: held bytes per sample, and **`null` for a
 * sample where the runner did not answer**.
 *
 * The null is the whole point and it is not a missing value: it is a different
 * KIND of event. `link.ts` draws its equivalent as a full-height mark rather
 * than letting it into the line, because averaging it in — or bridging it —
 * hides the one thing the graph exists to show. Zero would be worse still: zero
 * is a real reading that means "up and holding nothing".
 */
/**
 * How long a hole between two samples may be before it is DRAWN as a hole.
 *
 * Three poll periods. The pump only runs while the page is visible, so a phone
 * in a pocket leaves a gap in the ring of exactly the length of the pocket —
 * and an index-spaced spark would join the two ends into one continuous line.
 * That is the "samples kept across a stretch when nothing was being measured,
 * then drawn as a series" that this file's own switch calls the lie it refuses
 * to tell; it was true of the ring as well as of the persisted doc, and only
 * the sheet disclosed it in prose. A null here becomes the same full-height
 * miss mark an unreachable runner gets, which is honest: in both cases nothing
 * was measured.
 */
export const SERIES_GAP_MS = 3 * 5_000;

/**
 * The spark's series: bytes held per sample, `null` where nothing was measured.
 *
 * `null` means BOTH "the runner did not answer" and "nobody asked" — different
 * events, same truthful mark, because the graph's claim is only ever "there is
 * no reading here". The sheet's prose keeps the distinction; 22 px cannot.
 */
export function heldSeries(samples: readonly LocalRuntimeSample[]): (number | null)[] {
  return seriesOf(samples, (s) => (s.reachable ? heldBytes(s.models) : null));
}

/** Y ceiling for the spark, with a floor so a machine holding 200 MB does not
 *  draw a mountain range. Never fitted below the floor, never above the peak. */
export function seriesCeiling(series: readonly (number | null)[], floorBytes = 2 ** 30): number {
  let peak = 0;
  for (const v of series) if (v != null && v > peak) peak = v;
  return Math.max(floorBytes, peak);
}

/**
 * GPU utilization per sample, `null` where there is no reading — same shape as
 * `heldSeries`, same gap rule (`SERIES_GAP_MS`), but gated on `gpuPct` alone
 * rather than `reachable`: the GPU reading is an OS-level fact independent of
 * whether ollama answered (`host.ts`'s `readGpuStat` runs regardless), so a
 * dead runner beside a live GPU reading must not blank this line too.
 *
 * A host with no GPU reader at all (today: anything but Apple Silicon) draws
 * every point `null` — this function does not distinguish "never measured"
 * from "not readable here"; the sheet's prose does, off whether ANY point in
 * the series is non-null.
 */
export function gpuSeries(samples: readonly LocalRuntimeSample[]): (number | null)[] {
  return seriesOf(samples, (s) => s.gpuPct);
}

/**
 * CPU busy per sample, 0-100, `null` where nothing was measured — the
 * machine's own line, so it is gated on NOTHING about the runner: a desktop
 * with no runner at all is the normal case and its CPU is still a reading.
 *
 * `sys.cpu` (a delta between two kernel counters) where the host sent it, else
 * the older `cpuPct`, which is a load average over the core count. Both are
 * honest 0-100 figures; the sheet words which one a row is.
 */
export function cpuSeries(samples: readonly LocalRuntimeSample[]): (number | null)[] {
  return seriesOf(samples, cpuBusyPct);
}

/**
 * Memory IN USE per sample, in bytes — total minus what a new program could
 * actually get (`availableBytes`), falling back to total minus free on a host
 * that predates the breakdown. Drawn as "in use" rather than "free" because a
 * filling machine should read as a line going UP, the way every other graph
 * here reads pressure.
 */
export function memUsedSeries(samples: readonly LocalRuntimeSample[]): (number | null)[] {
  return seriesOf(samples, (s) => (s.memTotal > 0 ? Math.max(0, s.memTotal - memAvailBytes(s)) : null));
}

/**
 * CPU and GPU temperature per sample, °C, `null` where the sample carried no
 * thermal reading — a host with no sensor reader draws nothing, never 0°C.
 * The thermal reader runs on the slow cadence, so neighbouring samples can
 * repeat one reading; a step rather than a slope is that, not the machine.
 */
export function cpuTempSeries(samples: readonly LocalRuntimeSample[]): (number | null)[] {
  return seriesOf(samples, (s) => s.sys?.thermal?.cpuTempC);
}
export function gpuTempSeries(samples: readonly LocalRuntimeSample[]): (number | null)[] {
  return seriesOf(samples, (s) => s.sys?.thermal?.gpuTempC);
}

/** One fan's rpm per sample, matched by the sensor's LABEL (not its index —
 *  a reader that lists one fan fewer must not shift fan 2's line onto fan 1's). */
export function fanSeries(samples: readonly LocalRuntimeSample[], label: string): (number | null)[] {
  return seriesOf(samples, (s) => s.sys?.thermal?.fans.find((f) => f.label === label)?.rpm);
}

/** The one place the gap rule lives for every per-sample series. */
function seriesOf(samples: readonly LocalRuntimeSample[], pick: (s: LocalRuntimeSample) => number | null | undefined): (number | null)[] {
  const out: (number | null)[] = [];
  let prev: number | null = null;
  for (const s of samples) {
    if (prev != null && s.at - prev > SERIES_GAP_MS) out.push(null);
    out.push(pick(s) ?? null);
    prev = s.at;
  }
  return out;
}

/** How busy the CPU is in one sample: the kernel's busy split where measured,
 *  else the load-over-cores figure every host has always sent. */
export function cpuBusyPct(s: LocalRuntimeSample): number {
  const c = s.sys?.cpu;
  return c ? c.userPct + c.sysPct : s.cpuPct;
}

/** What a new program could get: `availableBytes` where the host measured it,
 *  else `os.freemem()` — which understates it, and is said so on the sheet. */
export function memAvailBytes(s: LocalRuntimeSample): number {
  return s.sys?.mem?.availableBytes ?? s.memFree;
}

/**
 * Is the machine short of memory? `tight` when less than a tenth of it is
 * available, or the swap file is more than four-fifths full WHILE less than a
 * quarter is available. Swap alone is history, not pressure: macOS grows the
 * swap file to fit what was paged out and keeps those cold pages there long
 * after the pressure is gone, so 11 of 12 GB swap "used" sat beside 40.5 GB
 * available and the strip went amber on a calm machine. Never `tight` on a
 * reading that cannot say: an absent swap file is not a full one.
 */
export function memTight(s: LocalRuntimeSample): boolean {
  if (!(s.memTotal > 0)) return false;
  const avail = memAvailBytes(s);
  if (avail < s.memTotal / 10) return true;
  const m = s.sys?.mem;
  return avail < s.memTotal / 4
    && m?.swapTotalBytes != null && m.swapTotalBytes > 0 && m.swapUsedBytes != null
    && m.swapUsedBytes / m.swapTotalBytes > 0.8;
}

/**
 * The machine in one sentence — the sheet's verdict when no model is loaded,
 * where the runner's own state is a footnote rather than the headline.
 */
export function machineText(s: LocalRuntimeSample, stale: boolean): string {
  const gpu = s.gpuPct != null ? `, GPU ${Math.round(s.gpuPct)}%` : "";
  const body = `CPU ${Math.round(cpuBusyPct(s))}% busy${gpu}, ${gbText(memAvailBytes(s))} of ${gbText(s.memTotal)} available`;
  const tight = memTight(s) ? " — memory is tight" : "";
  return stale ? `Last seen: ${body}${tight}.` : `${body}${tight}.`;
}

/**
 * The five states, and one transient that makes no claim at all.
 *
 * `pending` is not a sixth claim: it is the absence of one, drawn while a lease
 * is still within its grace window or before this phone has ever heard from the
 * desktop. It says nothing about the runner, which is the only honest thing to
 * say before an answer arrives — and it is specifically NOT `unanswered`, which
 * IS a claim ("this desktop did not understand the question").
 */
export type LocalRtKind = "holding" | "idle" | "unreachable" | "disabled" | "unanswered" | "pending";

export interface LocalRtReading {
  kind: LocalRtKind;
  /** One sentence, always present. A readout with nothing to say says that. */
  text: string;
  /**
   * True when the sentence is about the PAST — the socket is down, or the
   * newest sample is older than `SAMPLE_FRESH_MS`. The text is already written
   * in the past tense when this is set; the caller adds the age, which is the
   * one part that has to be computed at paint time.
   */
  stale: boolean;
  /** When the sample this is about was taken, for that age line. */
  at: number | null;
  /** The sample the sentence describes, so a caller need not re-find it. */
  sample: LocalRuntimeSample | null;
}

export interface LocalRtInput {
  /** Newest sample known, live or restored from the persisted document. */
  last: LocalRuntimeSample | null;
  /** A `disabled: true` frame arrived: this desktop does not poll at all. */
  disabled: boolean;
  /** Is there a live socket? Taken from `link.ts` — never re-derived here. */
  online: boolean;
  /** When a lease last went out over an open socket. */
  askedAt: number | null;
  /** When a `localrt.sample` frame last arrived, ever. */
  answeredAt: number | null;
  now: number;
}

export function localRtState(i: LocalRtInput): LocalRtReading {
  const none = { stale: false, at: null, sample: null } as const;

  // 4. Switched off on the desktop. FIRST, because it is the one state that is
  //    a standing fact about the machine rather than a reading: it outranks a
  //    stale sample from before somebody set the variable, and it must never be
  //    allowed to read as "the runner did not answer" — which is what it would
  //    look like, since the frame carries `reachable: false` too.
  if (i.disabled) {
    return {
      ...none,
      kind: "disabled",
      text: `The local-runner poll is switched off on this desktop (${envName("LOCAL_RUNTIME")}=0). Nothing here is being measured.`,
    };
  }

  // 5. Asked, over a live socket, and nothing came back. The host answers a
  //    watch IMMEDIATELY and before any poll timer, precisely so this silence
  //    means something specific: an older host ignoring a message type it has
  //    never heard of. That is the wire being versioned and is not a fault —
  //    but it is a completely different sentence from a quiet runner.
  if (i.answeredAt == null && i.askedAt != null && i.online && i.now - i.askedAt > ANSWER_GRACE_MS) {
    return {
      ...none,
      kind: "unanswered",
      text: `This desktop didn’t answer — its ${BRAND.name} may predate this readout.`,
    };
  }

  if (!i.last) {
    return {
      ...none,
      kind: "pending",
      text: i.online
        ? "Asking this desktop what its local runner is holding…"
        : "No reading yet — this phone hasn’t heard from the desktop.",
    };
  }

  const stale = !i.online || i.now - i.last.at > SAMPLE_FRESH_MS;
  const at = i.last.at;
  const sample = i.last;

  // 3. Nobody answered the runner. NOT an empty model list: a desktop with no
  //    runner installed is the normal case, and rendering it as a runner
  //    holding zero bytes is a claim about a program that is not there.
  if (!i.last.reachable) {
    return {
      kind: "unreachable", stale, at, sample,
      text: stale
        ? "Last seen: the local runner did not answer."
        : "The local runner did not answer — nothing is running it, or it is not listening where this desktop looks.",
    };
  }

  // 2. It answered, and it is holding nothing.
  if (!i.last.models.length) {
    return {
      kind: "idle", stale, at, sample,
      text: stale
        ? "Last seen: the runner was up and holding nothing."
        : "The runner is up and holding nothing.",
    };
  }

  // 1. The readout.
  const names = i.last.models.map((m) => m.name).join(", ");
  const held = gbText(heldBytes(i.last.models));
  return {
    kind: "holding", stale, at, sample,
    text: stale
      ? `Last seen: ${names} holding ${held}.`
      : `${names} ${i.last.models.length === 1 ? "is" : "are"} resident, holding ${held}.`,
  };
}

/**
 * The newest sample, but only if it is still a statement about NOW.
 *
 * The gate `ModelField` uses. A stale sample there is worse than none: it would
 * warn about a model this desktop may have evicted twenty minutes ago, which is
 * a sentence somebody would reasonably act on.
 */
export function freshSample(last: LocalRuntimeSample | null, now: number): LocalRuntimeSample | null {
  if (!last) return null;
  return now - last.at <= SAMPLE_FRESH_MS ? last : null;
}

// ────────────────────────────────────────────────────────────────────────────
// The switch
// ────────────────────────────────────────────────────────────────────────────

/**
 * Three states, not two.
 *
 * `off` / `auto` / `always`, per DEVICE (`LS.localRtBar`, not synced) for
 * `netPulse`'s argument verbatim: the strip spends this desktop's poll, this
 * phone's radio and a line of this screen, all three facts about the pair of
 * devices in play and none about the person.
 *
 * **Why `auto` exists.** A strip about local models is noise on a phone driving
 * a desktop that is not running one — which, for most of any given day, is
 * every desktop. `auto` draws it while a model is actually resident and gets
 * out of the way otherwise.
 *
 * **Why `always` exists, separately.** `auto`'s vanishing act makes one thing
 * impossible: watching a model NOT be there. "Nothing is loaded" and "the
 * runner did not answer" are the two facts this readout was built to keep
 * apart (`shared/wire/localrt.ts`), and a bar that hides itself for both is a
 * bar that can only report good news. Somebody debugging why a local session is
 * slow wants the strip pinned.
 *
 * **What `auto` does NOT save.** It still polls — it cannot know whether to
 * draw itself without asking. The saving is a line of screen, not battery and
 * not the desktop's work. The settings row says so out loud rather than letting
 * the word "auto" imply a frugality it does not have.
 */
export type LocalRtMode = "off" | "auto" | "always";

export const LOCAL_RT_MODES: readonly LocalRtMode[] = ["off", "auto", "always"];

/** What each mode says on the settings row — one wording, so the button and any
 *  sentence about it cannot drift. */
export const LOCAL_RT_MODE_LABEL: Record<LocalRtMode, string> = {
  off: "off",
  auto: "while a model is loaded",
  always: "always on",
};

/**
 * Read the stored mode, migrating the boolean this key used to hold.
 *
 * The old values were `true`/`false` and the old `true` meant "always drawn",
 * so it migrates to `always` and NOT to `auto`: a preference already expressed
 * must not quietly become a weaker one on upgrade. Unset is `always`,
 * the default for a new device; anything unrecognised is `off` — never a mode
 * somebody did not pick.
 */
export function readLocalRtMode(): LocalRtMode {
  const raw = lsGet(LS.localRtBar);
  if (raw === null) return "always";
  const v = raw.replace(/^"|"$/g, "");
  if (v === "off" || v === "auto" || v === "always") return v;
  return v === "true" ? "always" : "off";
}

let barMode: LocalRtMode = readLocalRtMode();

export function localRtMode(): LocalRtMode { return barMode; }

/**
 * **`localRtEnabled` / `setLocalRtEnabled` are a frozen contract** — kept
 * because the settings row and any later caller import exactly these names.
 * "Enabled" now means "not off", i.e. this device is watching; whether the
 * strip is DRAWN right now is `barVisible()`, which is a different question.
 */
export function localRtEnabled(): boolean { return barMode !== "off"; }

export function setLocalRtEnabled(on: boolean): void {
  setLocalRtMode(on ? "always" : "off");
}

export function setLocalRtMode(mode: LocalRtMode): void {
  if (barMode === mode) return;
  barMode = mode;
  lsSet(LS.localRtBar, JSON.stringify(mode));
  // Off drops the ring rather than freezing it: samples kept across a stretch
  // when nothing was being measured, and then drawn as a series, is the exact
  // lie this file refuses to tell. `auto` keeps its ring — but the watch DOES
  // stop while the page is hidden, so a hole is drawn as a hole rather than
  // bridged (`heldSeries` / `SERIES_GAP_MS`) instead of being assumed away.
  if (mode === "off") ring = [];
  invalidate();
  emit();
}

/**
 * Should the strip be DRAWN right now?
 *
 * Pure, so the one rule that decides it is pinned rather than re-derived in a
 * component. `auto` shows the strip while a model is resident AND for a grace
 * period afterwards: `keep_alive` evicts on a timer, and a bar that vanished
 * the instant a model was unloaded would take the eviction — the event somebody
 * turned this on to watch — off screen with it.
 */
export const AUTO_LINGER_MS = 60_000;

/**
 * The newest instant at which the runner was holding anything, or null.
 *
 * Read off the ring so `auto`'s linger survives an eviction: the last SAMPLE
 * says nothing is loaded, and the instant before it is what the grace period is
 * measured from. Falls back to the persisted last sample on a cold open.
 */
export function heldUntil(
  samples: readonly LocalRuntimeSample[],
  last: LocalRuntimeSample | null,
): number | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (s.reachable && s.models.length > 0) return s.at;
  }
  if (last && last.reachable && last.models.length > 0) return last.at;
  return null;
}

export function barVisible(
  mode: LocalRtMode,
  o: { holding: boolean; lastHeldAt: number | null; now: number },
): boolean {
  if (mode === "off") return false;
  if (mode === "always") return true;
  if (o.holding) return true;
  return o.lastHeldAt != null && o.now - o.lastHeldAt < AUTO_LINGER_MS;
}

// ────────────────────────────────────────────────────────────────────────────
// The document: the ring (memory) and the last sample (persisted)
// ────────────────────────────────────────────────────────────────────────────

/** Persisted. Deliberately the SMALLEST thing that answers "what was it doing
 *  last time anybody could see?" — see the note at the top on why the ring is
 *  not in here. */
interface LocalRtDoc {
  last: LocalRuntimeSample | null;
  disabled: boolean;
  /** When a frame last arrived, across page lives. */
  seenAt: number | null;
}

function load(): LocalRtDoc {
  const d = lsJson<Partial<LocalRtDoc>>(LS.localRt, {});
  const last = d.last && typeof d.last.at === "number" && Array.isArray(d.last.models) ? (d.last as LocalRuntimeSample) : null;
  return { last, disabled: d.disabled === true, seenAt: typeof d.seenAt === "number" ? d.seenAt : null };
}

let doc: LocalRtDoc = load();
/** Memory only. Never written, never read back from storage. */
let ring: LocalRuntimeSample[] = [];
let askedAt: number | null = null;
/** This page life's answer clock. `doc.seenAt` is the across-lives one; they
 *  are kept apart because state 5 is a claim about THIS socket, and a frame
 *  from yesterday must not clear it. */
let answeredAt: number | null = null;

let writeTimer: number | null = null;

function persist(): void {
  if (writeTimer != null) return;
  writeTimer = window.setTimeout(() => { writeTimer = null; lsSetJson(LS.localRt, doc); }, WRITE_DEBOUNCE_MS);
}

function persistNow(): void {
  if (writeTimer != null) { window.clearTimeout(writeTimer); writeTimer = null; }
  lsSetJson(LS.localRt, doc);
}

/**
 * **The one writer.** A sample arrived from the desktop.
 *
 * A `disabled` frame is recorded as the standing fact it is and is NOT pushed
 * into the ring: it carries `reachable: false` because nobody asked, and drawn
 * as a series it would paint a wall of miss marks describing a runner that was
 * never polled. The ring is a record of what the runner said, and on a disabled
 * desktop the runner says nothing because nobody speaks to it.
 */
export function noteLocalRtSample(sample: LocalRuntimeSample, disabled = false): void {
  const now = Date.now();
  answeredAt = now;
  doc.seenAt = now;
  doc.disabled = disabled;
  doc.last = sample;
  if (!disabled) {
    ring.push(sample);
    if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
  } else {
    ring = [];
  }
  persist();
  invalidate();
  emit();
}

// ────────────────────────────────────────────────────────────────────────────
// The one subscribe/emit
// ────────────────────────────────────────────────────────────────────────────

export interface LocalRtSnapshot {
  /** This device is WATCHING (mode is not `off`). Not the same question as
   *  whether the strip is drawn — that is `barVisible()`. */
  enabled: boolean;
  mode: LocalRtMode;
  /** The ring. Memory only, newest last, `RING_CAP` at most. */
  samples: readonly LocalRuntimeSample[];
  /** Newest known sample — from this page life, or restored from storage. */
  last: LocalRuntimeSample | null;
  /** This desktop does not poll at all. */
  disabled: boolean;
  askedAt: number | null;
  answeredAt: number | null;
  /** When a frame last arrived, across page lives — what "2h ago" is measured
   *  from on a phone that has just been opened. */
  seenAt: number | null;
  /** The once-a-second clock, for `live` subscribers. */
  now: number;
}

let snap: LocalRtSnapshot | null = null;

function invalidate(): void { snap = null; }

export function localRtSnapshot(): LocalRtSnapshot {
  if (snap) return snap;
  snap = {
    enabled: barMode !== "off",
    mode: barMode,
    samples: ring.slice(),
    last: ring.length ? ring[ring.length - 1] : doc.last,
    disabled: doc.disabled,
    askedAt,
    answeredAt,
    seenAt: doc.seenAt,
    now: clockNow,
  };
  return snap;
}

interface Listener { fn: (s: LocalRtSnapshot) => void; live: boolean }
const listeners = new Set<Listener>();
let ticker: number | null = null;
let clockNow = Date.now();

function emit(): void {
  if (!listeners.size) return;
  const s = localRtSnapshot();
  for (const l of listeners) l.fn(s);
}

function tickClock(): void {
  clockNow = Date.now();
  invalidate();
  emit();
}

function retimeTicker(): void {
  const wantsClock = [...listeners].some((l) => l.live);
  if (wantsClock && ticker == null) ticker = window.setInterval(tickClock, 1000);
  if (!wantsClock && ticker != null) { window.clearInterval(ticker); ticker = null; }
}

/**
 * Subscribe to the whole store.
 *
 * `live` opts into the once-a-second clock, which is what anything with an age
 * in it needs — and which the unanswered verdict needs too, since that one
 * turns true by the clock alone. Opt-in for `link.ts`'s reason: a timer waking
 * a backgrounded phone to recompute a number nobody is looking at is the cost
 * this whole family of readouts is supposed to be measuring, not paying.
 */
export function subscribeLocalRt(fn: (s: LocalRtSnapshot) => void, live = false): () => void {
  const l: Listener = { fn, live };
  listeners.add(l);
  retimeTicker();
  fn(localRtSnapshot());
  return () => { listeners.delete(l); retimeTicker(); };
}

/**
 * The React half of that one subscription — `useLink`'s twin, including the
 * selector-in-a-ref trick: the selector is written inline at every call site,
 * so a dependency array would resubscribe on every render, and for a store
 * whose subscribe emits immediately that is an infinite loop rather than a slow
 * path.
 */
export function useLocalRt<T>(select: (s: LocalRtSnapshot) => T, live = false): T {
  const sel = useRef(select);
  sel.current = select;
  const [v, setV] = useState<T>(() => select(localRtSnapshot()));
  useEffect(() => subscribeLocalRt((s) => {
    const next = sel.current(s);
    setV((prev) => (Object.is(prev, next) ? prev : next));
  }, live), [live]);
  return v;
}

// ────────────────────────────────────────────────────────────────────────────
// The lease pump
// ────────────────────────────────────────────────────────────────────────────

/** Anything that can carry a lease. Structural on purpose — see the top. */
export interface LocalRtSource {
  readonly status: LinkStatus;
  send(msg: ClientMessage): void;
  on(fn: (msg: HostMessage) => void): () => void;
}

let src: LocalRtSource | null = null;
let pumpTimer: number | null = null;
let interest = 0;

/**
 * **Ref-counted interest.** Two independent things want this readout — the
 * strip, and a mounted `ModelField` about to offer a local model — and neither
 * should be able to switch the other's lease off by unmounting. Returns the
 * release; call it from an effect's cleanup.
 *
 * Nobody interested ⇒ no lease is renewed ⇒ the host's own lease lapses within
 * a minute and its poll timer stops with its last watcher. The desktop stops
 * paying for a readout nobody is looking at, without either end having to be
 * told so.
 */
export function acquireLocalRtWatch(): () => void {
  interest++;
  retimePump();
  return () => { interest = Math.max(0, interest - 1); retimePump(); };
}

function retimePump(): void {
  const want = interest > 0;
  if (want && pumpTimer == null) {
    pumpTimer = window.setInterval(pump, LEASE_RENEW_MS);
    pump();   // now, rather than in 25 s — a strip that shows nothing for half a
              // minute after being switched on is a strip people conclude is broken
  }
  if (!want && pumpTimer != null) { window.clearInterval(pumpTimer); pumpTimer = null; }
}

/**
 * Renew the lease, if there is anything to renew it over.
 *
 * **Only while the page is visible.** A backgrounded phone must not keep a
 * desktop polling its runner for a strip nobody can see; the lease lapses on
 * its own and the next foreground tick takes it back out.
 */
function pump(): void {
  if (!src || interest <= 0) return;
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  if (src.status !== "open") return;
  src.send({ t: "localrt.watch" });
  askedAt = Date.now();
  invalidate();
  emit();
}

/**
 * Unload one resident model now, from the sheet's eject button.
 *
 * Fire-and-toast, `App.tsx`'s `liveSend` shape but kept HERE rather than
 * routed through that outbox: this store already owns the one `send`/`on`
 * pair this feature needs (`LocalRtSource`), and a second path into the same
 * socket would be a second place that could disagree about whether it is
 * open. Not queued offline and no `ackId` — the wire message's own doc
 * comment says why: an eject means something only right now.
 */
export function evictLocalModel(name: string): void {
  if (!src || src.status !== "open") {
    showToast("no connection — the local runner lives on the desktop and can't be ejected from here");
    return;
  }
  src.send({ t: "localrt.evict", name });
  showToast(`ejecting ${name}…`);
}

/**
 * Attach the store to the transport. Called once from `main.tsx`, beside the
 * pulse probe, for the reason every always-on layer lives there: `App.tsx`
 * returns early once per overlay, so anything mounted inside it is missing from
 * whichever sheet somebody writes next.
 *
 * Idempotent — a second call with the same singleton connection would otherwise
 * register a second listener and double every sample.
 */
export function startLocalRtWatch(source: LocalRtSource): void {
  if (src) return;
  src = source;
  source.on((msg) => {
    if (msg.t === "localrt.sample") {
      noteLocalRtSample(msg.sample, msg.disabled === true);
      return;
    }
    if (msg.t === "localrt.evict") {
      showToast(msg.ok ? `${msg.name} ejected` : `could not eject ${msg.name}${msg.error ? ` — ${msg.error}` : ""}`);
      return;
    }
    // **A new socket carries no lease.** The host keys its watcher map by the
    // socket object itself, so the lease this phone held died with the
    // connection that took it — and `welcome` is the first frame of the new
    // one. Without this, a reconnect leaves the strip frozen on whatever it
    // last saw until the 25 s pump comes round, which on a flaky tunnel is
    // most of the time.
    if (msg.t === "welcome") pump();
  });
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") pump();
    });
  }
  if (typeof window !== "undefined") {
    // The last sample is what an offline open renders from, and the moment it
    // is most likely to be wanted is after the app was closed — so it must not
    // be sitting in a debounce when the page goes away.
    window.addEventListener("pagehide", () => persistNow());
  }
  retimePump();
  // Interest may already have been taken before the transport arrived (effect
  // order is not a contract worth relying on), in which case the pump timer is
  // running but its first tick was spent with nothing to send. A no-op when the
  // socket is not open yet — the `welcome` handler above covers that case.
  pump();
}
