import { useEffect, useRef } from "react";
import { Activity, Copy, Cpu, Monitor, Fan, Gauge, HardDrive, MemoryStick, PowerOff, Thermometer } from "lucide-react";
import {
  RING_CAP, acquireLocalRtWatch, cpuSeries, cpuTempSeries, evictLocalModel, fanSeries, gbText, gpuSeries,
  gpuTempSeries, heldBytes, heldSeries, localRtState, machineText, memUsedSeries, seriesCeiling, useLocalRt,
  type LocalRtSnapshot,
} from "./localRt";
import type { LocalRtFocus } from "./LocalRtBar";
import { SysGraph } from "./SysGraph";
import { AgentsSection } from "./AgentsSection";
import { roomyCeiling } from "./graphGeom";
import { useLink } from "./link";
import { dur, hhmm, until } from "./format";
import { SheetHead } from "./Sheet";
import { BRAND } from "@waterplane/shared";
import { ConfirmButton } from "./Confirm";
import { SetWarn, SetNote } from "./SettingsKit";
import { copyText } from "./api";
import { showToast } from "./toast";
import {
  cpuSplitText, diskLow, diskSize, diskText, diskUsedPct, loadText, memNote, memSlices, procFoldText,
  rssSumText, slowAgeSec, swapText, tempText, uptimeText,
} from "./sysStat";
import { Button } from "./kit/Button";

/**
 * **This desktop, in full** — the tap destination for every reading on the
 * strip. Two orders, one set of sections: with a local model resident, that
 * model is the hero at the top (it is the thing holding gigabytes on its own);
 * with none, the machine leads — CPU, memory, what is holding it — and the
 * runner's state is a short section at the bottom, because "holding nothing"
 * is not a headline.
 *
 * The strip has 22 px and can only show a shape and a number; every one of
 * those numbers invites a question it has no room to answer. "18.2 GB" held by
 * WHAT, and for how much longer? "12%" of a machine with how much left? This is
 * where the four readings become four sections, and where the tap lands
 * directly — each strip segment carries its own focus, which is scrolled to and
 * flashed, because a sheet that silently opens mid-document reads as one that
 * opened at the wrong place.
 *
 * Three rules this screen holds, each of which is a way it could read
 * plausibly and wrongly:
 *
 *  • **An absent eviction time renders NOTHING.** The runner does not always
 *    say when it intends to drop a model, and both available inventions are
 *    claims: "never" would tell somebody their 18 GB is permanent, and "now"
 *    would tell them it is about to be free. A blank cell is the honest answer
 *    and it is what `wire/localrt.ts` made the field optional for.
 *
 *  • **Offline is said in the past tense, with its age.** This app renders from
 *    snapshots on purpose, so a screen showing a snapshot has to say how old it
 *    is — and a memory readout is the kind that looks exactly as authoritative
 *    at two hours old as at two seconds.
 *
 *  • **Everything else here is a readout — the eject button is the one
 *    exception, and it is a real one.** There is still no "free up memory" and
 *    no switch that stops a model from being loaded again; nothing here
 *    decides FOR the desktop. But a person looking at 20 GB resident and a
 *    count of who is using it has already made the decision, and making them
 *    walk to the desktop to act on their own read is the failure this button
 *    exists to close. It is a `ConfirmButton` (never `window.confirm`), it
 *    names what it is about to do, and the session count is said BEFORE the
 *    tap, not discovered after.
 *
 * Tokens per second is absent here too, for the reason stated in
 * `localRt.ts` — no measurement path exists, and an estimate would be wrong in
 * both directions that matter.
 *
 * ── The desktop half (`sysStat.ts`) ─────────────────────────────────────────
 *
 * The sections below "The desktop" exist because this screen used to say
 * **"memory free 1.1 GB of 64.0 GB"** about a machine holding no local model at
 * all, and had no answer to the question that provokes. `os.freemem()` counts
 * untouched pages, so a healthy Mac reports nearly nothing free for ever; the
 * same minute measured 33 GB available and 23 `claude` processes holding
 * 11.7 GB of it. Four things are drawn now — the CPU split against the load
 * average, where the memory went, which programs hold it, and the temperature —
 * and every one of them keeps this file's existing rules: an absent reader
 * renders a SENTENCE or nothing (never a 0°C, never a zero-width slice), a
 * reading taken on the slower cadence says its age, and nothing on the screen
 * acts on any of it.
 */

const ICON = 16;

/** An axis label in GB: whole numbers once they are big enough to read that way. */
const gbAxis = (v: number) => {
  const gb = Math.max(0, v) / 2 ** 30;
  return `${gb >= 10 || gb === 0 ? Math.round(gb) : gb.toFixed(1)} GB`;
};
const pctAxis = (v: number) => `${Math.round(v)}%`;
const tempAxis = (v: number) => `${Math.round(v)}°C`;
const rpmAxis = (v: number) => `${Math.round(v)} rpm`;

interface Props {
  onClose: () => void;
  /** Which strip reading sent the user here; scrolled to and flashed once. */
  focus?: LocalRtFocus;
  /** A row in the agents section, tapped: that session. */
  onOpenSession?: (id: string) => void;
}

export function LocalRtSheet({ onClose, focus, onOpenSession }: Props) {
  const s = useLocalRt<LocalRtSnapshot>((x) => x, true);
  const online = useLink((x) => x.online);
  // The sheet holds interest of its own: it may well be open with the strip
  // switched off, and a screen entirely about a live reading that quietly shows
  // a frozen one is worse than a screen that says it has nothing.
  useEffect(() => acquireLocalRtWatch(), []);

  const focusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = focusRef.current;
    if (!focus || !el) return;
    el.scrollIntoView({ block: "start" });
    el.classList.add("nh-flash");
    const t = window.setTimeout(() => el.classList.remove("nh-flash"), 1400);
    return () => window.clearTimeout(t);
  }, [focus]);

  const r = localRtState({
    last: s.last, disabled: s.disabled, online,
    askedAt: s.askedAt, answeredAt: s.answeredAt, now: s.now,
  });
  const series = heldSeries(s.samples);
  const gpuS = gpuSeries(s.samples);
  const cpuS = cpuSeries(s.samples);
  const memS = memUsedSeries(s.samples);
  const memTotal = r.sample?.memTotal ?? 0;
  const cpuTS = cpuTempSeries(s.samples);
  const gpuTS = gpuTempSeries(s.samples);
  const tempRead = cpuTS.some((v) => v != null) || gpuTS.some((v) => v != null);
  // Fans by the labels the latest reading names: a fan that stopped being
  // reported is not drawn as a line that ends, it is simply not listed now.
  const fanLines = (r.sample?.sys?.thermal?.fans ?? []).map((f, i) => ({
    key: `fan-${f.label}`, label: f.label, tone: (["app", "wired", "compressed"] as const)[i % 3],
    series: fanSeries(s.samples, f.label),
  }));
  const fanHi = roomyCeiling(fanLines.flatMap((l) => l.series), 2000, 500);
  const span = s.samples.length > 1 ? { from: s.samples[0].at, to: s.samples[s.samples.length - 1].at } : {};
  const gpuRead = gpuS.some((v) => v != null);
  const models = r.sample?.models ?? [];
  // The machine's own numbers, absent wholesale on a host that predates them
  // and section by section on a platform with no reader for one.
  const sys = r.sample?.sys;
  const slices = memSlices(sys?.mem, r.sample?.memTotal ?? 0);
  const swap = swapText(sys?.mem);
  // The two expensive readers run on a slower cadence than the poll, so a
  // sample can repeat a reading taken seconds earlier. Said, rather than drawn
  // as current — the rule this whole readout exists to keep.
  const procAge = sys?.procs && r.sample ? slowAgeSec(sys.procs.at, r.sample.at) : null;
  const thermAge = sys?.thermal && r.sample ? slowAgeSec(sys.thermal.at, r.sample.at) : null;
  const diskAge = sys?.disks && r.sample ? slowAgeSec(sys.disks.at, r.sample.at) : null;
  // The volume holding the home folder (the host lists ours first) — the one
  // the top section names, because it is where repos, builds and swap land.
  const homeDisk = sys?.disks?.volumes[0];

  const modelsPart = (
    <>
        <section className={`set-group${models.length > 0 ? " lrt-hero" : ""}`} ref={focus === "models" ? focusRef : undefined}>
          <h3 className="set-title">{models.length > 0 ? "Local model, resident" : "Local models"}</h3>
          {models.length > 0 ? (
            <>
              <div className="lrt-rows">
                {models.map((m) => (
                  <div className="lrt-row" key={m.name}>
                    <span className="lrt-name mono">{m.name}</span>
                    <span className="lrt-size">{gbText(m.size)}</span>
                    {/* Only when the host answered the join at all (`localrt.ts`'s
                        `installSessionModels`) — absent, never a guessed zero, on
                        a host that never wired it (see `wire/localrt.ts`). This is
                        also the sentence a tap should read BEFORE arming the
                        eject button below, which is why it sits beside the size
                        rather than folded into the confirm label alone. */}
                    {m.sessionsUsing != null && (
                      <span className="lrt-size">
                        {m.sessionsUsing === 0
                          ? "no active session"
                          : `${m.sessionsUsing} active session${m.sessionsUsing === 1 ? "" : "s"}`}
                      </span>
                    )}
                    <ConfirmButton className="link-btn lrt-eject" title={`unload ${m.name} now`}
                      confirm={m.sessionsUsing ? <>{m.sessionsUsing} active — eject anyway?</> : <>eject?</>}
                      confirmTitle={m.sessionsUsing
                        ? `${m.sessionsUsing} session${m.sessionsUsing === 1 ? "" : "s"} on ${m.name} will reload it from disk on the next reply`
                        : undefined}
                      onConfirm={() => evictLocalModel(m.name)}>
                      <PowerOff size={12} aria-hidden="true" /> eject
                    </ConfirmButton>
                    {/* Kept apart from the total on purpose: on a unified-memory
                        Mac these are the same number, and on a discrete-GPU box
                        the difference between them is the whole story. */}
                    <span className="lrt-vram">
                      <HardDrive size={11} aria-hidden="true" /> {gbText(m.vram)} on GPU
                    </span>
                    {/* ABSENT renders nothing. "never" and "now" are both claims
                        the runner did not make.
                        An instant that has ALREADY PASSED relative to the
                        reading it came with is not a countdown either: `until()`
                        answers "now" for it, so a stale sample rendered "evicts
                        in now" — ungrammatical, and a present-tense claim made
                        from an old reading. Past its own sample, the cell says
                        what it actually knows. */}
                    {m.expiresAt != null && (
                      <span className="lrt-evict">
                        {r.sample != null && m.expiresAt > r.sample.at
                          ? <>evicts in {until(m.expiresAt)}</>
                          : <>was due to be evicted by then</>}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <SetNote as="span">
                {gbText(heldBytes(models))} held in total by {models.length === 1 ? "one model" : `${models.length} models`}.
                The runner still evicts on its own schedule; *eject* on a row is the one thing on this
                screen that acts instead of just reading — nothing else here does.
              </SetNote>
            </>
          ) : (
            // Four different reasons there is no list, and they are four
            // different sentences. `localRtState` already picked which one.
            <SetNote as="span">{r.text}</SetNote>
          )}
        </section>

    </>
  );
  const heldPart = (
    <>
        <section className="set-group" ref={focus === "history" && models.length > 0 ? focusRef : undefined}>
          <h3 className="set-title">Held memory, recently</h3>
          {series.length > 1 ? (
            <>
              <SysGraph lines={[{ key: "held", label: "held", tone: "app", series }]}
                lo={0} hi={seriesCeiling(series)} fmt={gbAxis} {...span} />
              <SetNote as="span">
                The last {series.length} reading{series.length === 1 ? "" : "s"} (at most {RING_CAP}, roughly ten
                minutes). A model being loaded or evicted is a step, not a slope. A reading where the
                runner did not answer is drawn as its own full-height mark rather than averaged into
                the line or bridged across — those are a different kind of event, not a small number.
              </SetNote>
              <SetNote as="span">
                It is a series of READINGS, not a time axis: nothing is measured while this phone is
                in a pocket or off the tunnel, so the marks are not evenly spaced in time. Kept in
                memory only — a chart rebuilt from an old buffer after a reload would look exactly as
                current as this one, which is the failure this whole readout exists to avoid.
              </SetNote>
            </>
          ) : (
            <SetNote as="span">
              Nothing to draw yet. Readings arrive every few seconds while this screen or the strip is
              open, and they are not kept across a reload.
            </SetNote>
          )}
        </section>

    </>
  );
  const gpuPart = (
    <>
        <section className="set-group">
          <h3 className="set-title">GPU utilization, recently</h3>
          {gpuS.length > 1 && gpuRead ? (
            <>
              <SysGraph lines={[{ key: "gpu", label: "GPU busy", tone: "app", series: gpuS }]}
                lo={0} hi={100} fmt={pctAxis} {...span} />
              <SetNote as="span">
                Same shape as the memory graph above, but fixed 0-100% rather than fitted to the
                data — a line drawn to a floating ceiling makes 20% look identical to 80% across two
                readings. A gap is a stretch this phone was not watching, drawn as a break, never
                bridged.
              </SetNote>
            </>
          ) : s.samples.length > 1 ? (
            <SetNote as="span">
              No GPU reading from this desktop. Today that reader only exists for Apple Silicon
              (the OS's own utilization figure) — a discrete-GPU host or one running Linux has none
              yet, and this says so rather than drawing a flat line at 0%.
            </SetNote>
          ) : (
            <SetNote as="span">
              Nothing to draw yet. Readings arrive every few seconds while this screen or the strip is
              open, and they are not kept across a reload.
            </SetNote>
          )}
        </section>

    </>
  );
  const deskPart = (
    <>
        <section className="set-group" ref={focus === "cpu" || (focus === "memory" && !(slices.length > 0 && sys?.mem)) ? focusRef : undefined}>
          <h3 className="set-title">The desktop</h3>
          {r.sample ? (
            <>
              <div className="lrt-rows">
                {/* Two different questions, both drawn, never one standing in
                    for the other: "how much of the machine is busy" is a delta
                    between two readings, and the load average is how long the
                    queue is. A build can be 100% busy at a load of 2, or sit at
                    a load of 30 with the CPU idle and everything waiting on
                    disk. The busy figure needs a PREVIOUS reading, so the first
                    sample of a watch has none and this falls back to the one
                    the strip has always shown. */}
                {sys?.cpu ? (
                  <div className="lrt-row">
                    <span className="lrt-name"><Cpu size={11} aria-hidden="true" /> CPU busy</span>
                    <span className="lrt-size">{Math.round(sys.cpu.userPct + sys.cpu.sysPct)}%</span>
                    <span className="lrt-vram">{cpuSplitText(sys.cpu)}</span>
                  </div>
                ) : (
                  <div className="lrt-row">
                    <span className="lrt-name"><Cpu size={11} aria-hidden="true" /> CPU load</span>
                    <span className="lrt-size">{Math.round(r.sample.cpuPct)}%</span>
                    <span className="lrt-vram">the one-minute load average over the core count — a
                      queue length, not a utilization figure</span>
                  </div>
                )}
                {/* One bar per logical core. A machine at "25% busy" is either
                    four cores flat out or sixteen ticking over, and those are
                    different machines to be looking at. */}
                {sys?.cpu && sys.cpu.cores.length > 0 && (
                  <div className="lrt-row lrt-cores">
                    <span className="lrt-name"><Activity size={11} aria-hidden="true" /> per core</span>
                    <span className="sys-cores" aria-hidden="true">
                      {sys.cpu.cores.map((pct, i) => (
                        <span className="sys-core" key={i} title={`core ${i + 1}: ${pct}%`}>
                          <span className="sys-core-fill" style={{ height: `${Math.max(2, Math.min(100, pct))}%` }} />
                        </span>
                      ))}
                    </span>
                    <span className="lrt-vram">{sys.cpu.cores.filter((p) => p >= 80).length} of {sys.cpu.cores.length} cores above 80%</span>
                  </div>
                )}
                {sys && (
                  <div className="lrt-row">
                    <span className="lrt-name"><Gauge size={11} aria-hidden="true" /> load</span>
                    <span className="lrt-size">{sys.loadavg[0].toFixed(2)}</span>
                    <span className="lrt-vram">{loadText(sys)} · up {uptimeText(sys.uptimeSec)}</span>
                  </div>
                )}
                {/* Available FIRST where the host measured it: free memory is
                    the number that read 1.1 GB on a machine with 33 GB going
                    spare, and it is kept beside it rather than replaced,
                    because it is still what the model-pressure sentence uses. */}
                <div className="lrt-row">
                  <span className="lrt-name"><MemoryStick size={11} aria-hidden="true" /> memory {sys?.mem?.availableBytes != null ? "available" : "free"}</span>
                  <span className="lrt-size">{gbText(sys?.mem?.availableBytes ?? r.sample.memFree)}</span>
                  <span className="lrt-vram">
                    of {gbText(r.sample.memTotal)}
                    {sys?.mem?.availableBytes != null ? ` · ${gbText(r.sample.memFree)} of it untouched` : ""}
                  </span>
                </div>
                {/* ABSENT, not 0 — today that is every host but Apple Silicon
                    (`host.ts`'s `readGpuStat`), never a borrowed CPU number. */}
                {r.sample.gpuPct != null && (
                  <div className="lrt-row">
                    <span className="lrt-name"><Gauge size={11} aria-hidden="true" /> GPU utilization</span>
                    <span className="lrt-size">{Math.round(r.sample.gpuPct)}%</span>
                  </div>
                )}
                {r.sample.gpuMemInUse != null && (
                  <div className="lrt-row">
                    <span className="lrt-name"><HardDrive size={11} aria-hidden="true" /> GPU memory in use</span>
                    <span className="lrt-size">{gbText(r.sample.gpuMemInUse)}</span>
                  </div>
                )}
                {homeDisk && (
                  <div className="lrt-row">
                    <span className="lrt-name"><HardDrive size={11} aria-hidden="true" /> disk free</span>
                    <span className="lrt-size">{diskSize(homeDisk.availBytes)}</span>
                    <span className="lrt-vram">
                      of {diskSize(homeDisk.totalBytes)} · {homeDisk.name}
                      {diskLow(homeDisk) ? " · nearly full" : ""}
                    </span>
                  </div>
                )}
              </div>
              <SetNote as="span">
                These are the operating system's numbers, not the model's. Free memory understates
                what is really available — a page cache and a compressor are not in it — which is why
                this app warns about a second local model in a sentence and never refuses to start one.
                {r.sample.gpuPct != null && (
                  <> GPU figures are the driver's own, system-wide — not just what a model above is
                    holding, and absent entirely on a host this app has no reader for.</>
                )}
              </SetNote>
            </>
          ) : (
            <SetNote as="span">No reading from this desktop yet.</SetNote>
          )}
        </section>

    </>
  );
  const agentsPart = <AgentsSection ref={focus === "agents" ? focusRef : undefined} onOpenSession={onOpenSession} />;
  const graphsPart = (
    <>
        <section className="set-group" ref={focus === "history" && models.length === 0 ? focusRef : undefined}>
          <h3 className="set-title">The desktop, recently</h3>
          {cpuS.some((v) => v != null) && cpuS.length > 1 ? (
            <>
              <SysGraph lines={[{ key: "cpu", label: "CPU busy", tone: "app", series: cpuS }]}
                lo={0} hi={100} fmt={pctAxis} {...span} />
              {memS.some((v) => v != null) && memTotal > 0 && (
                <SysGraph lines={[{ key: "mem", label: "memory in use", tone: "wired", series: memS }]}
                  lo={0} hi={memTotal} fmt={gbAxis} {...span} />
              )}
              <SetNote as="span">
                CPU busy, then memory in use, over the last {cpuS.length} readings — both drawn against the
                whole machine (0-100%, 0 to {gbText(memTotal)}), never fitted to the data, so a flat line
                means a flat machine. A break is a stretch this phone was not watching, never bridged.
                Kept in memory only, so a reload starts it again rather than drawing an old buffer as
                current.
              </SetNote>
            </>
          ) : (
            <SetNote as="span">
              Nothing to draw yet. Readings arrive every few seconds while this screen or the strip is
              open, and they are not kept across a reload.
            </SetNote>
          )}
        </section>
    </>
  );
  const restPart = (
    <>
        {/* ── Where the memory has gone ──────────────────────────────────────
            The section this whole change exists for. "memory free 1.1 GB of
            64.0 GB" on a desktop holding no model at all is alarming,
            unactionable and very nearly meaningless — `os.freemem()` counts
            untouched pages only. The bar adds up to the machine, every slice
            says what it IS, and the caption leads with what is genuinely
            available. */}
        {slices.length > 0 && sys?.mem && (
          <section className="set-group" ref={focus === "memory" ? focusRef : undefined}>
            <h3 className="set-title">Where the memory has gone</h3>
            <div className="sys-bar" role="img"
              aria-label={slices.map((s) => `${s.label} ${gbText(s.bytes)}`).join(", ")}>
              {slices.map((s) => (
                <span className={`sys-seg sys-${s.tone}`} key={s.key} style={{ width: `${s.pct}%` }} />
              ))}
            </div>
            <div className="lrt-rows">
              {slices.map((s) => (
                <div className="lrt-row" key={s.key}>
                  <span className="lrt-name">
                    <span className={`sys-dot sys-${s.tone}`} aria-hidden="true" /> {s.label}
                  </span>
                  <span className="lrt-size">{gbText(s.bytes)}</span>
                  <span className="lrt-vram">{s.what}</span>
                </div>
              ))}
              {/* Swap only where there IS a swap file. A nearly-full one is the
                  most actionable number on this screen — this desktop measured
                  8.8 GB of 10 GB in use while it looked idle. */}
              {swap && (
                <div className="lrt-row">
                  <span className="lrt-name"><HardDrive size={11} aria-hidden="true" /> swap</span>
                  <span className="lrt-size">{swap}</span>
                  <span className="lrt-vram">
                    pages the machine pushed out to disk — swap filling up is what slows a desktop
                    down long before the memory number does
                  </span>
                </div>
              )}
            </div>
            {/* raw: memNote can be null, and SetNote would drop the empty box this draws */}
            <span className="set-note">{memNote(sys.mem, r.sample?.memFree ?? 0)}</span>
          </section>
        )}

        {/* ── What is holding it ─────────────────────────────────────────────
            The answer to the question the readout above provokes. Rows are
            folded BY PROGRAM: twenty-three `claude` processes holding 11.7 GB
            is the answer somebody is looking for, and twenty-three identical
            rows is not. */}
        <section className="set-group">
          <h3 className="set-title">What is holding it</h3>
          {sys?.procs ? (
            <>
              <div className="lrt-rows">
                {sys.procs.byMem.map((p) => (
                  <div className="lrt-row" key={`m-${p.name}`}>
                    <span className="lrt-name mono">{p.name}</span>
                    <span className="lrt-size">{gbText(p.rssBytes)}</span>
                    <span className="lrt-vram">{procFoldText(p)} · {p.cpuPct.toFixed(0)}% CPU</span>
                  </div>
                ))}
              </div>
              <SetNote as="span">
                {rssSumText(sys.procs.rssSumBytes, r.sample?.memTotal ?? 0)} {sys.procs.count} processes are
                running; these are the {sys.procs.byMem.length} biggest.
                {procAge != null ? ` Read ${procAge}s before the rest of this sample.` : ""}
              </SetNote>
              {sys.procs.byCpu.length > 0 && (
                <>
                  <h3 className="set-title">…and what is using the CPU</h3>
                  <div className="lrt-rows">
                    {sys.procs.byCpu.map((p) => (
                      <div className="lrt-row" key={`c-${p.name}`}>
                        <span className="lrt-name mono">{p.name}</span>
                        <span className="lrt-size">{p.cpuPct.toFixed(0)}%</span>
                        <span className="lrt-vram">{procFoldText(p)} · {gbText(p.rssBytes)}</span>
                      </div>
                    ))}
                  </div>
                  <SetNote as="span">
                    A percentage per core, summed across the fold, exactly as `top` reports it — so a
                    row can read well past 100% and that is several cores, not an error.
                  </SetNote>
                </>
              )}
            </>
          ) : (
            // Switched off, unreadable, or a host that predates this — three
            // different facts, and the host words which. Never "nothing is
            // running", which is not a thing this can mean.
            // raw: a host-sent note may be "" (?? keeps it); SetNote would drop the empty box
            <span className="set-note">
              {sys?.procsNote ?? `This desktop is not sending a process list — its ${BRAND.name} predates this readout.`}
            </span>
          )}
        </section>

        {/* ── Disk space ─────────────────────────────────────────────────────
            One row per VOLUME, not per folder: home, the code root and the
            state dir are usually the same disk, and `holds` says so. Each bar
            is the whole volume, used against free, never fitted. */}
        <section className="set-group">
          <h3 className="set-title">Disk space</h3>
          {sys?.disks ? (
            <>
              {sys.disks.volumes.map((v) => (
                <div className="sys-disk" key={v.path}>
                  <div className="lrt-row">
                    <span className="lrt-name"><HardDrive size={11} aria-hidden="true" /> {v.name}</span>
                    <span className="lrt-size">{diskSize(v.availBytes)} free</span>
                    <span className="lrt-vram">
                      {diskText(v)} · {Math.round(diskUsedPct(v))}% used
                      {v.holds.length > 0 ? ` · holds ${v.holds.join(", ")}` : ""}
                    </span>
                  </div>
                  <div className="sys-bar" role="img" aria-label={`${v.name}: ${diskText(v)}`}>
                    <span className={`sys-seg ${diskLow(v) ? "sys-disk-low" : "sys-app"}`} style={{ width: `${diskUsedPct(v)}%` }} />
                    <span className="sys-seg sys-available" style={{ flex: 1 }} />
                  </div>
                  {diskLow(v) && (
                    <SetWarn>
                      {v.name} is nearly full — builds, model downloads and the swap file are what
                      fill the last of a disk, and a full one fails them part-way.
                    </SetWarn>
                  )}
                </div>
              ))}
              <SetNote as="span">
                Free is what a program could still write. On a Mac it leaves out purgeable space
                (local snapshots, files iCloud can fetch again), so Finder may say more is free.
                What this app itself keeps on the desktop is listed on the Storage screen.
                {diskAge != null ? ` Read ${diskAge}s before the rest of this sample.` : ""}
              </SetNote>
            </>
          ) : (
            // raw: a host-sent note may be "" (?? keeps it); SetNote would drop the empty box
            <span className="set-note">
              {sys?.disksNote ?? `This desktop is not sending disk readings — its ${BRAND.name} predates this readout.`}
            </span>
          )}
        </section>

        {/* ── Temperature and fans ───────────────────────────────────────────
            Absent on macOS by default, and the sentence says why: the SMC
            sensors are root-only and a daemon that spawns your CLI has no
            business asking for a password. An unexplained blank reads as a bug
            in this app, which is why the note is as load-bearing as the row. */}
        <section className="set-group">
          <h3 className="set-title">Temperature and fans</h3>
          {sys?.thermal ? (
            <>
              <div className="lrt-rows">
                {tempText(sys.thermal.cpuTempC) && (
                  <div className="lrt-row">
                    <span className="lrt-name"><Thermometer size={11} aria-hidden="true" /> CPU</span>
                    <span className="lrt-size">{tempText(sys.thermal.cpuTempC)}</span>
                  </div>
                )}
                {tempText(sys.thermal.gpuTempC) && (
                  <div className="lrt-row">
                    <span className="lrt-name"><Thermometer size={11} aria-hidden="true" /> GPU</span>
                    <span className="lrt-size">{tempText(sys.thermal.gpuTempC)}</span>
                  </div>
                )}
                {sys.thermal.fans.map((f) => (
                  <div className="lrt-row" key={f.label}>
                    <span className="lrt-name"><Fan size={11} aria-hidden="true" /> {f.label}</span>
                    <span className="lrt-size">{f.rpm} rpm</span>
                  </div>
                ))}
              </div>
              {tempRead && s.samples.length > 1 && (
                <SysGraph
                  lines={[
                    ...(cpuTS.some((v) => v != null) ? [{ key: "cpu-t", label: "CPU", tone: "app" as const, series: cpuTS }] : []),
                    ...(gpuTS.some((v) => v != null) ? [{ key: "gpu-t", label: "GPU", tone: "wired" as const, series: gpuTS }] : []),
                  ]}
                  lo={20} hi={Math.max(100, ...[...cpuTS, ...gpuTS].filter((v): v is number => v != null))}
                  fmt={tempAxis} {...span} />
              )}
              {fanLines.length > 0 && s.samples.length > 1 && (
                <SysGraph lines={fanLines} lo={0} hi={fanHi} fmt={rpmAxis} {...span} />
              )}
              <SetNote as="span">
                {s.samples.length > 1 && (tempRead || fanLines.length > 0) && (
                  <>Temperature is drawn 20-100°C, fixed, so a warm minute is not stretched into a
                    fever. Fans are the one fitted axis — the sensor names no maximum — so read their
                    rpm, not the height. The sensor is read on a slower beat than the rest, so a step
                    is a fresh reading arriving, not a jump. </>
                )}
                Read by <span className="mono">{sys.thermal.source}</span> — a sensor tool this app
                does not own, so these are its numbers and not ours.
                {sys.thermal.fans.length === 0 ? " It reported no fans: a fanless machine, or a VM." : ""}
                {thermAge != null ? ` Read ${thermAge}s before the rest of this sample.` : ""}
              </SetNote>
            </>
          ) : (
            <>
              {/* raw: a host-sent note may be "" (?? keeps it); SetNote would drop the empty box */}
              <span className="set-note">
                {sys?.thermalNote ?? `This desktop is not sending a temperature reading — its ${BRAND.name} predates this readout.`}
              </span>
              {sys?.thermalFix?.map((cmd) => (
                <div className="cmd-copy" key={cmd}>
                  <code>{cmd}</code>
                  <Button aria-label="copy command" onClick={async () => showToast(await copyText(cmd) ? "command copied" : "copy failed")}><Copy size={16} /></Button>
                </div>
              ))}
            </>
          )}
        </section>

    </>
  );
  const notHerePart = (
    <>
        <section className="set-group">
          <h3 className="set-title">What is not here</h3>
          <SetNote as="span">
            There is no tokens-per-second figure anywhere in this app, deliberately. Neither the
            runner nor the coding CLI publishes live throughput, and the only thing that could be
            estimated from what this host can see — bytes off the terminal over wall clock — is wrong
            in both directions that matter: a terminal repaints, so screen bytes are not output
            tokens, and a model thinking silently produces nothing at all while doing the expensive
            part. A speed nobody can act on is worse than a blank space.
          </SetNote>
        </section>
    </>
  );

  return (
    <div className="sheet">
      <SheetHead title="This desktop" icon={<Monitor size={ICON} />} onClose={onClose} />
      <div className="sheet-body">
        {/* The headline follows the strip: a resident model when there is one,
            otherwise the machine itself, with the runner's state demoted to
            its own section at the bottom. */}
        <p className={`lrt-verdict${r.stale ? " stale" : ""}`}>
          {models.length === 0 && r.sample ? machineText(r.sample, r.stale) : r.text}
        </p>
        {/* The age line, and only when the reading is not current. A timestamp
            printed beside a live number is noise; printed beside a stale one it
            is the entire difference between a readout and a lie. */}
        {r.stale && r.at != null && (
          <SetNote as="p">
            Read {dur(r.at)} ago, at {hhmm(r.at)}
            {online ? "" : " — this phone is not connected to the desktop right now"}.
            {s.seenAt != null && s.seenAt !== r.at ? ` Last frame from the desktop ${dur(s.seenAt)} ago.` : ""}
          </SetNote>
        )}

        {/* Arriving from the strip's agent count, the agents lead; otherwise
            they sit after the machine they run on. */}
        {focus === "agents" && agentsPart}
        {models.length > 0 ? (
          <>
            {modelsPart}
            {heldPart}
            {gpuPart}
            {deskPart}
            {graphsPart}
            {focus !== "agents" && agentsPart}
            {restPart}
            {notHerePart}
          </>
        ) : (
          <>
            {deskPart}
            {graphsPart}
            {focus !== "agents" && agentsPart}
            {gpuRead ? gpuPart : null}
            {restPart}
            {modelsPart}
          </>
        )}
      </div>
    </div>
  );
}
