/**
 * The local-runner store's pure half, pinned without a browser.
 *
 * Same arrangement as `backendCaps.test.mjs`: `node --test` runs straight over
 * the TypeScript using node's own type stripping, and `npm run test:unit`
 * discovers it.
 *
 *     node --test packages/web/src/localRt.test.mjs
 *
 * Two things are worth this file, and both fail SILENTLY on a screen:
 *
 *  - **The five states.** Each one is a different thing for a person to do, and
 *    a collapse between any two of them produces a readout that is confidently
 *    wrong: "the runner is holding nothing" printed about a desktop that was
 *    never asked, "the runner did not answer" printed about a desktop that does
 *    not poll at all, or either of those printed about a host too old to have
 *    heard the question. None of that throws; it just reads as fact.
 *  - **The provider prefix.** opencode's id is `ollama/qwen3-coder:30b`, the
 *    runner's name for the same bytes is `qwen3-coder:30b`. Matched
 *    unstripped, the model that is already loaded looks absent, and the phone
 *    warns about "a second model" while describing the only one running. A
 *    warning that fires on the happy path is one people learn to ignore.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { envName, memoryPressureNote } from "@waterplane/shared";
import { AUTO_LINGER_MS, SERIES_GAP_MS, barVisible, heldUntil,
  ANSWER_GRACE_MS, SAMPLE_FRESH_MS,
  freshSample, gbText, gpuSeries, heldBytes, heldSeries, isResident,
  localRtState, modelBaseName, seriesCeiling,
  cpuBusyPct, cpuSeries, machineText, memAvailBytes, memTight, memUsedSeries,
  localRtMode, readLocalRtMode,
} from "./localRt.ts";
import { setDemoActive } from "./demo/mode.ts";
import { LS } from "./storage.ts";

const GB = 2 ** 30;
const NOW = 1_700_000_000_000;
const model = (name, gb) => ({ name, size: gb * GB, vram: gb * GB });
const sample = (o = {}) => ({ at: NOW, models: [], reachable: true, cpuPct: 12, memTotal: 64 * GB, memFree: 20 * GB, ...o });
const input = (o = {}) => ({ last: null, disabled: false, online: true, askedAt: NOW - 1000, answeredAt: NOW - 900, now: NOW, ...o });

// ── The five states, worded apart ──────────────────────────────────────────

test("1. reachable with models is the readout — names and the held total", () => {
  const r = localRtState(input({ last: sample({ models: [model("qwen3-coder:30b", 18)] }) }));
  assert.equal(r.kind, "holding");
  assert.equal(r.stale, false);
  assert.match(r.text, /qwen3-coder:30b/);
  assert.match(r.text, /18\.0 GB/);
});

test("2. reachable and EMPTY says the runner is up and holding nothing", () => {
  const r = localRtState(input({ last: sample({ models: [] }) }));
  assert.equal(r.kind, "idle");
  assert.match(r.text, /up and holding nothing/);
});

test("3. reachable:false says the runner did not answer — never “holding nothing”", () => {
  // The whole reason `reachable` is on the wire. A desktop with no runner
  // installed is the normal case, and rendering it as a runner holding zero
  // bytes is a claim about a program that is not there.
  const r = localRtState(input({ last: sample({ reachable: false, models: [] }) }));
  assert.equal(r.kind, "unreachable");
  assert.match(r.text, /did not answer/);
  assert.ok(!/holding nothing/.test(r.text));
});

test("4. disabled says polling is off HERE, and names the variable", () => {
  // Arrives as `reachable: false` too, which is exactly why it must outrank it:
  // "nobody polls on this desktop" and "the runner did not answer" are opposite
  // facts with opposite fixes.
  const r = localRtState(input({ disabled: true, last: sample({ reachable: false }) }));
  assert.equal(r.kind, "disabled");
  assert.match(r.text, new RegExp(`${envName("LOCAL_RUNTIME")}=0`));
  assert.ok(!/did not answer/.test(r.text));
});

test("5. a lease out over a live socket with NO answer blames the desktop's version", () => {
  // The host answers a watch immediately and before any poll timer, so this
  // silence means one specific thing: an older host ignoring a message type it
  // has never heard of (an unknown `t` is ignored, never thrown — the wire is
  // versioned). Different sentence, different fix.
  const r = localRtState(input({ answeredAt: null, askedAt: NOW - ANSWER_GRACE_MS - 1 }));
  assert.equal(r.kind, "unanswered");
  assert.match(r.text, /predate/);
});

test("…but inside the grace window it claims nothing at all", () => {
  // `pending` is the absence of a claim, not a sixth one. Saying "this desktop
  // is too old" half a second after asking would be wrong about every desktop.
  const r = localRtState(input({ answeredAt: null, askedAt: NOW - 1 }));
  assert.equal(r.kind, "pending");
  assert.ok(!/predate/.test(r.text));
});

test("no lease has gone out yet ⇒ pending, and it says which silence it is", () => {
  assert.equal(localRtState(input({ answeredAt: null, askedAt: null })).kind, "pending");
  const off = localRtState(input({ answeredAt: null, askedAt: null, online: false }));
  assert.equal(off.kind, "pending");
  assert.match(off.text, /hasn’t heard from the desktop/);
});

test("a dead socket never produces the unanswered verdict", () => {
  // Nothing was asked, so nothing failed to answer. Blaming the desktop's
  // version for a dead tunnel sends somebody to upgrade the wrong machine.
  const r = localRtState(input({ answeredAt: null, askedAt: NOW - 60_000, online: false }));
  assert.equal(r.kind, "pending");
});

test("the five never collapse: five inputs, five kinds", () => {
  const kinds = [
    localRtState(input({ last: sample({ models: [model("a", 1)] }) })).kind,
    localRtState(input({ last: sample({ models: [] }) })).kind,
    localRtState(input({ last: sample({ reachable: false }) })).kind,
    localRtState(input({ disabled: true })).kind,
    localRtState(input({ answeredAt: null, askedAt: NOW - 10_000 })).kind,
  ];
  assert.equal(new Set(kinds).size, 5, kinds.join(","));
});

// ── Stale is about whether we still believe it, not about what was said ────

test("offline turns every reading past tense without changing what it says", () => {
  const r = localRtState(input({ online: false, last: sample({ models: [model("qwen3-coder:30b", 18.2)] }) }));
  assert.equal(r.kind, "holding");
  assert.equal(r.stale, true);
  assert.match(r.text, /^Last seen: qwen3-coder:30b holding 18\.[12] GB\./);
  assert.equal(r.at, NOW, "it carries the sample's own timestamp, so the age line is about the READING");
});

test("an old sample over a live socket is stale too", () => {
  const r = localRtState(input({ last: sample({ at: NOW - SAMPLE_FRESH_MS - 1, models: [model("a", 1)] }) }));
  assert.equal(r.stale, true);
  assert.match(r.text, /^Last seen/);
});

test("a fresh sample is present tense and carries no “last seen”", () => {
  const r = localRtState(input({ last: sample({ at: NOW - 1000, models: [model("a", 1)] }) }));
  assert.equal(r.stale, false);
  assert.ok(!/Last seen/.test(r.text));
});

test("every state answers with a sentence — nothing renders an empty readout", () => {
  for (const i of [input(), input({ disabled: true }), input({ last: sample() }),
    input({ last: sample({ reachable: false }) }), input({ answeredAt: null, askedAt: NOW - 10_000 })]) {
    const r = localRtState(i);
    assert.equal(typeof r.text, "string");
    assert.ok(r.text.length > 10, r.kind);
  }
});

// ── The provider prefix ────────────────────────────────────────────────────

test("a provider prefix is stripped at the FIRST slash only", () => {
  assert.equal(modelBaseName("ollama/qwen3-coder:30b"), "qwen3-coder:30b");
  assert.equal(modelBaseName("qwen3-coder:30b"), "qwen3-coder:30b");
  // Anything past the first segment is part of the real name, which is the same
  // rule the host's opencode catalogue is parsed with.
  assert.equal(modelBaseName("openrouter/meta/llama-4"), "meta/llama-4");
  assert.equal(modelBaseName(""), "");
});

test("THE BUG: an unstripped id makes the loaded model look absent", () => {
  const loaded = [model("qwen3-coder:30b", 18)];
  assert.equal(isResident(loaded, "ollama/qwen3-coder:30b"), false, "unstripped — this is the trap");
  assert.equal(isResident(loaded, modelBaseName("ollama/qwen3-coder:30b")), true);
});

test("…and that is exactly what would make the pressure note lie", () => {
  // End to end, the way `ModelField` asks it. Unstripped, the note fires about
  // the model that is already running — a warning on the happy path. Stripped,
  // it is silent, which is the correct answer for opening a second session on
  // the SAME local model: no second copy, no pressure, nothing to say.
  const loaded = [model("qwen3-coder:30b", 18)];
  const id = "ollama/qwen3-coder:30b";
  assert.ok(memoryPressureNote(loaded, id, 4 * GB), "the trap: a note about the model already loaded");
  assert.equal(memoryPressureNote(loaded, modelBaseName(id), 4 * GB), null);
  // A genuinely different model still gets the sentence.
  assert.ok(memoryPressureNote(loaded, modelBaseName("ollama/gemma4:e4b"), 4 * GB));
});

// ── Drawing the ring ───────────────────────────────────────────────────────

test("an unreachable sample is a null in the series — never 0, never skipped", () => {
  // Zero is a real reading ("up, holding nothing"). Skipping bridges the line
  // across the exact event the graph exists to show. Both are the same bug.
  const series = heldSeries([
    sample({ models: [model("a", 2)] }),
    sample({ reachable: false, models: [] }),
    sample({ models: [] }),
  ]);
  assert.deepEqual(series, [2 * GB, null, 0]);
});

test("the ceiling is floored, and never fitted below what is actually held", () => {
  assert.equal(seriesCeiling([]), 1 * GB);
  assert.equal(seriesCeiling([null, null]), 1 * GB);
  assert.equal(seriesCeiling([0.2 * GB]), 1 * GB, "a small holding stays small rather than filling the graph");
  assert.equal(seriesCeiling([18 * GB, null, 2 * GB]), 18 * GB);
});

test("held bytes sum the models and survive a runner that answered rubbish", () => {
  assert.equal(heldBytes([]), 0);
  assert.equal(heldBytes([model("a", 1), model("b", 2)]), 3 * GB);
  assert.equal(heldBytes([{ name: "x", size: NaN, vram: 0 }]), 0, "never NaN — it would poison every total drawn from it");
});

test("bytes are said one way, so a strip and a sentence cannot print two numbers", () => {
  assert.equal(gbText(18.2 * GB), "18.2 GB");
  assert.equal(gbText(0), "0.0 GB");
  assert.equal(gbText(-5), "0.0 GB");
});

// ── The freshness gate ModelField hangs off ────────────────────────────────

test("a stale sample is withheld entirely rather than warned from", () => {
  // The note would otherwise describe models a desktop may have evicted twenty
  // minutes ago — and it is a sentence somebody would reasonably act on.
  assert.equal(freshSample(sample({ at: NOW - SAMPLE_FRESH_MS - 1 }), NOW), null);
  const fresh = sample({ at: NOW - 1000 });
  assert.equal(freshSample(fresh, NOW), fresh, "a current sample comes back as itself");
  assert.equal(freshSample(null, NOW), null);
});

// ── The three-state switch ──────────────────────────────────────────────────
// `off` / `auto` / `always`. The rule that matters: `always` is its own choice
// and not a stronger `auto` — auto's vanishing act makes it impossible to watch
// a model NOT be there, which is exactly what somebody debugging a slow local
// session is doing.

test("off draws nothing, always draws regardless of what is loaded", () => {
  const none = { holding: false, lastHeldAt: null, now: 1_000_000 };
  assert.equal(barVisible("off", none), false);
  assert.equal(barVisible("off", { holding: true, lastHeldAt: 1_000_000, now: 1_000_000 }), false);
  // The whole point of `always`: nothing loaded, nothing ever loaded, still drawn.
  assert.equal(barVisible("always", none), true);
});

test("auto draws while something is resident", () => {
  assert.equal(barVisible("auto", { holding: true, lastHeldAt: 1_000_000, now: 1_000_000 }), true);
});

test("auto LINGERS past an eviction, or it hides the event it exists to show", () => {
  // `keep_alive` evicts on a timer. A bar that vanished the instant a model was
  // unloaded would take the eviction off screen with it.
  const at = 1_000_000;
  assert.equal(barVisible("auto", { holding: false, lastHeldAt: at, now: at + 1_000 }), true);
  assert.equal(barVisible("auto", { holding: false, lastHeldAt: at, now: at + AUTO_LINGER_MS - 1 }), true);
  assert.equal(barVisible("auto", { holding: false, lastHeldAt: at, now: at + AUTO_LINGER_MS }), false);
});

test("auto with nothing ever loaded is hidden — that is what distinguishes it", () => {
  assert.equal(barVisible("auto", { holding: false, lastHeldAt: null, now: 1_000_000 }), false);
});

test("heldUntil reads the newest RESIDENT instant, not the newest sample", () => {
  // The last sample says nothing is loaded; the grace period is measured from
  // the one before it.
  const s = (at, models, reachable = true) => ({ at, models, reachable, cpuPct: 1, memTotal: 1, memFree: 1 });
  const ring = [s(100, [{ name: "a", size: 1, vram: 1 }]), s(200, [{ name: "a", size: 1, vram: 1 }]), s(300, [])];
  assert.equal(heldUntil(ring, null), 200);
  // Nothing ever resident ⇒ null, never 0 (which would read as an instant).
  assert.equal(heldUntil([s(100, []), s(200, [])], null), null);
  // An unreachable sample is not evidence that anything was held.
  assert.equal(heldUntil([s(100, [{ name: "a", size: 1, vram: 1 }], false)], null), null);
  // Cold open: the persisted last sample stands in for an empty ring.
  assert.equal(heldUntil([], s(900, [{ name: "a", size: 1, vram: 1 }])), 900);
  assert.equal(heldUntil([], null), null);
});

test("a stretch nobody measured is CUT, never bridged", () => {
  // The pump stops while the page is hidden, so the ring survives a pocket with
  // a hole in it. Index-spaced, the spark would join the two ends into one
  // continuous line — the lie this module's own switch comment names.
  const s = (at, mb) => ({ at, reachable: true, models: [{ name: "m", size: mb * 2 ** 20, vram: 0 }], cpuPct: 1, memTotal: 1, memFree: 1 });
  const dense = heldSeries([s(0, 1), s(5_000, 1), s(10_000, 1)]);
  assert.equal(dense.length, 3, "no gap inserted where the samples are contiguous");
  const gapped = heldSeries([s(0, 1), s(600_000, 1)]);
  assert.deepEqual(gapped.map((v) => v == null), [false, true, false], "the hole gets its own mark");
  // Exactly at the threshold is still contiguous; past it is not.
  assert.equal(heldSeries([s(0, 1), s(SERIES_GAP_MS, 1)]).length, 2);
  assert.equal(heldSeries([s(0, 1), s(SERIES_GAP_MS + 1, 1)]).length, 3);
});

test("GPU series is gated on gpuPct alone, not ollama's reachable", () => {
  // The GPU reading is an OS-level fact independent of ollama: a dead runner
  // must not blank a live GPU reading, and a host with no GPU reader must not
  // print a borrowed 0.
  const series = gpuSeries([
    sample({ gpuPct: 37, reachable: true }),
    sample({ gpuPct: 5, reachable: false }), // ollama down, GPU still answered
    sample({ reachable: true }), // no reader at all on this host
  ]);
  assert.deepEqual(series, [37, 5, null]);
});

test("GPU series cuts the same gaps the memory series does", () => {
  const s = (at, gpuPct) => ({ at, reachable: true, models: [], gpuPct, cpuPct: 1, memTotal: 1, memFree: 1 });
  const gapped = gpuSeries([s(0, 10), s(600_000, 20)]);
  assert.deepEqual(gapped.map((v) => v == null), [false, true, false]);
});

// ── The machine half: the strip's line when no model is resident ───────────

test("the machine's CPU line is drawn whether or not the runner answered", () => {
  // A desktop with no runner is the normal case; its CPU is still a reading.
  const series = cpuSeries([sample({ at: NOW, reachable: false, cpuPct: 30 }), sample({ at: NOW + 5000, cpuPct: 40 })]);
  assert.deepEqual(series, [30, 40]);
});

test("CPU busy prefers the kernel's split over the load-average fallback", () => {
  const cpu = { userPct: 11, sysPct: 7, idlePct: 82, cores: [], spanMs: 2000 };
  assert.equal(cpuBusyPct(sample({ cpuPct: 50, sys: { cpu } })), 18);
  assert.equal(cpuBusyPct(sample({ cpuPct: 50 })), 50);
});

test("memory available leads with availableBytes, never the untouched-pages figure", () => {
  const sys = { mem: { availableBytes: 38 * GB, source: "vm_stat" } };
  assert.equal(memAvailBytes(sample({ memFree: 6 * GB, sys })), 38 * GB);
  assert.equal(memAvailBytes(sample({ memFree: 6 * GB })), 6 * GB);
  // In-use is the whole machine minus available, so a filling desktop goes UP.
  assert.deepEqual(memUsedSeries([sample({ memFree: 6 * GB, sys })]), [26 * GB]);
});

test("the machine series breaks across a gap rather than bridging it", () => {
  assert.deepEqual(cpuSeries([sample({ at: NOW, cpuPct: 10 }), sample({ at: NOW + 600_000, cpuPct: 20 })]), [10, null, 20]);
});

test("memory is tight below a tenth available, or a nearly-full swap with little available — never on swap alone", () => {
  assert.equal(memTight(sample({ memFree: 20 * GB })), false);
  assert.equal(memTight(sample({ memFree: 5 * GB })), true);
  const swap = (used, total, avail = 12 * GB) => sample({ sys: { mem: { availableBytes: avail, swapUsedBytes: used, swapTotalBytes: total, source: "vm_stat" } } });
  assert.equal(memTight(swap(8.8 * GB, 10 * GB)), true);
  assert.equal(memTight(swap(1 * GB, 10 * GB)), false);
  assert.equal(memTight(swap(undefined, undefined)), false);
  // macOS keeps paged-out cold pages in a swap file sized to fit them: 11 of 12 GB
  // "used" beside 40.5 GB available is a calm machine, not a tight one.
  assert.equal(memTight(swap(11 * GB, 12 * GB, 40.5 * GB)), false);
});

test("the machine sentence says available, names the GPU only when read, and keeps the past tense when stale", () => {
  assert.equal(machineText(sample(), false), "CPU 12% busy, 20.0 GB of 64.0 GB available.");
  assert.equal(machineText(sample({ gpuPct: 41.6 }), false), "CPU 12% busy, GPU 42%, 20.0 GB of 64.0 GB available.");
  assert.match(machineText(sample({ memFree: 2 * GB }), true), /^Last seen: .* — memory is tight\.$/);
});

// ── The strip's mode when nobody picked one ───────────────────────────────

test("an unpicked strip mode is always — except in the demo, which has no runner and so shows no strip; a picked one is read as picked", () => {
  const store = new Map();
  const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, String(v)); } },
  });
  try {
    assert.equal(readLocalRtMode(), "always", "the real app's default is unchanged");
    assert.equal(localRtMode(), "always");
    setDemoActive("first-look");
    assert.equal(readLocalRtMode(), "auto", "in the demo it is read when asked, not fixed at import");
    assert.equal(localRtMode(), "auto");
    assert.equal(barVisible(localRtMode(), { holding: false, lastHeldAt: null, now: NOW }), false, "and `auto` with no model resident draws nothing");
    store.set(LS.localRtBar, JSON.stringify("always"));
    assert.equal(readLocalRtMode(), "always", "a mode somebody picked stays theirs, demo or not");
    store.set(LS.localRtBar, JSON.stringify("off"));
    assert.equal(readLocalRtMode(), "off");
  } finally {
    setDemoActive(null);
    if (had) Object.defineProperty(globalThis, "localStorage", had); else delete globalThis.localStorage;
  }
});
