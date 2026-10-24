/**
 * The backend registry: a plugin's backend joins the live list and leaves it
 * again, and every refusal is a sentence naming what WOULD have worked
 * (`docs/analysis/backends-design.md` §1.2). Also pins that the wire booleans
 * are derived from BOTH halves — the screen-reader caps and the `sources`.
 */
import "../../../scripts/lib-tmuxiso.mjs"; // any tmux this test starts runs in a socket dir of its own
import { test } from "node:test";
import assert from "node:assert/strict";


const idx = await import("../dist/backends/index.js");
const { resolveBackend, knownBackend, backendInfos, forkAtTurnRefusal, claudeBackend, registerBackend,
  unregisterBackend, onBackendsChanged, BACKENDS, registerScreenReader, registerStoreReader,
  screenReaderFor, storeReaderFor, namesStoreReader, factProblems, contributedReaders } = idx;
// No extension is registered here: core's three are the whole list, whatever `packages/extensions/`
// holds (opencode's own registry assertions are `packages/extensions/opencode/test/`).

/** A contributed screen reader and store reader, the shape `api.screenReader` / `api.storeReader` take. */
const NAV = { candidate: () => false, read: () => null, prompt: () => null, stillUp: () => false, navTo: () => null };
const STORE = {
  source: "backend", updatedAt: () => null, pollUnchanged: () => false, transcript: () => null,
  toolDetails: () => null, contextSeries: () => null, discover: () => ({ id: null, carry: null }),
};

/** A plugin-shaped descriptor: claude's, renamed, with the provider table the test turns —
 *  minus claude's own `sources` (its hook pipe, design §10): a plugin brings its own. */
function plugin(id, facts = {}, extra = {}) {
  return { ...claudeBackend, id, label: id, facts: { ...claudeBackend.facts, ...facts }, sources: undefined, ...extra };
}
/** No provider for anything — every reader fact ABSENT. */
const BARE = { turns: [], dialogs: [], questions: [], plan: [], asking: [], limits: [], transcript: [], context: [], usage: [], agents: [], conversations: [] };
const SRC = { attach: async () => ({ close: async () => {}, health: () => ({ state: "up", since: 0 }) }) };

test("register, resolve, unregister: the list is live", () => {
  const seen = [];
  const off = onBackendsChanged(() => seen.push(BACKENDS.map((b) => b.id).join(",")));
  try {
    registerBackend(plugin("stubcli"));
    assert.equal(knownBackend("stubcli"), true);
    assert.equal(resolveBackend("stubcli").id, "stubcli");
    assert.ok(backendInfos().some((i) => i.id === "stubcli"), "the wire frame lists it");
    assert.equal(unregisterBackend("stubcli"), true);
    assert.equal(knownBackend("stubcli"), false);
    assert.equal(unregisterBackend("stubcli"), false, "removing what is not there says so, throws nothing");
    assert.deepEqual(seen, ["claude,claude-local,claude-endpoint,shell,stubcli", "claude,claude-local,claude-endpoint,shell"], "one change event per real change");
  } finally { off(); }
});

test("an unknown id is refused with a sentence listing the LIVE ids, plugin ones included", () => {
  registerBackend(plugin("stubcli"));
  try {
    assert.throws(() => resolveBackend("nope"), /no backend called "nope"\. It can run: claude, claude-local, claude-endpoint, shell, stubcli\./);
  } finally { unregisterBackend("stubcli"); }
  assert.throws(() => resolveBackend("nope"), /It can run: claude, claude-local, claude-endpoint, shell\./);
});

test("a duplicate id is refused, naming the live ids, and replaces nothing", () => {
  assert.throws(() => registerBackend(plugin("claude")), /"claude" is already registered; the live ones are: claude, claude-local, claude-endpoint, shell/);
  assert.equal(resolveBackend("claude"), claudeBackend);
});

test("a core backend cannot be unregistered", () => {
  assert.throws(() => unregisterBackend("claude-local"), /built into this host/);
  assert.equal(knownBackend("claude-local"), true);
});

test("an id that is not a plain word is refused", () => {
  assert.throws(() => registerBackend(plugin("Bad Id")), /short lowercase word/);
  assert.throws(() => registerBackend(plugin("")), /short lowercase word/);
});

test("a reader this host does not have is refused at registration, listing the ones it has", () => {
  assert.throws(
    () => registerBackend(plugin("cp", { dialogs: [{ screen: "copilot-numbered" }] })),
    /no screen reader called `copilot-numbered` answers dialogs; this host has: claude-numbered$/,
  );
  assert.throws(
    () => registerBackend(plugin("cp", { transcript: [{ store: "copilot-events" }] })),
    /no store reader called `copilot-events` answers transcript; this host has: claude-jsonl$/,
  );
  assert.equal(knownBackend("cp"), false, "nothing half-registered");
  assert.deepEqual(factProblems({ dialogs: [], transcript: [] }, contributedReaders()), []);
});

test("backendInfos derives each wire boolean from caps OR a source", () => {
  const bare = plugin("bare", BARE);
  const fed = plugin("fed", { ...BARE, turns: [{ source: true }], dialogs: [{ source: true }], transcript: [{ source: true }], context: [{ source: true }] }, {
    sources: { ...SRC, turns: {}, dialogs: {}, transcript: {}, context: {} },
  });
  // A slot nobody listed in `facts` is never asked: the source alone does not make the fact exist.
  const unlisted = plugin("unlisted", BARE, { sources: { ...SRC, turns: {}, dialogs: {}, transcript: {}, context: {} } });
  registerBackend(bare);
  registerBackend(fed);
  registerBackend(unlisted);
  try {
    const by = Object.fromEntries(backendInfos().map((i) => [i.id, i.caps]));
    for (const k of ["hooks", "promptBoxes", "transcript", "contextSeries"]) {
      assert.equal(by.bare[k], false, `bare.${k}: no reader and no source means the fact does not exist`);
      assert.equal(by.fed[k], true, `fed.${k}: a source alone makes it exist`);
      assert.equal(by.unlisted[k], false, `unlisted.${k}: a source the facts do not list is not asked`);
    }
    assert.equal(by.fed.fork, false, "a source is not a file this app may copy");
    assert.equal(by.claude.hooks, true, "the screen-reader half is unchanged");
  } finally { unregisterBackend("bare"); unregisterBackend("fed"); unregisterBackend("unlisted"); }
});

test("one source is enough for just its own fact", () => {
  const onlyTurns = plugin("onlyturns", { ...BARE, turns: [{ source: true }], dialogs: [{ source: true }], transcript: [{ source: true }] }, { sources: { ...SRC, turns: {} } });
  registerBackend(onlyTurns);
  try {
    const c = backendInfos().find((i) => i.id === "onlyturns").caps;
    assert.deepEqual([c.hooks, c.promptBoxes, c.transcript, c.contextSeries], [true, false, false, false]);
  } finally { unregisterBackend("onlyturns"); }
});

test("contributed readers: registered by name, named by a backend, gone when unregistered", () => {
  const offNav = registerScreenReader("fake-nav", NAV);
  const offStore = registerStoreReader("fake-db", STORE);
  try {
    assert.throws(() => registerScreenReader("fake-nav", NAV), /already exists; this host has: claude-numbered, fake-nav/);
    assert.throws(() => registerStoreReader("claude-jsonl", STORE), /`claude-jsonl` already exists/, "core's names cannot be taken");
    assert.throws(() => registerScreenReader("Bad Name", NAV), /short lowercase word/);
    assert.throws(() => registerStoreReader("half", { ...STORE, discover: undefined }), /has no discover\(\)/);
    registerBackend(plugin("navcli", { dialogs: [{ screen: "fake-nav" }], transcript: [{ store: "fake-db" }] }));
    try {
      const b = resolveBackend("navcli");
      assert.equal(screenReaderFor(b), NAV);
      assert.equal(storeReaderFor(b), STORE);
      assert.equal(namesStoreReader(b), true);
      assert.equal(storeReaderFor(claudeBackend), null, "claude's jsonl is core's, never a contributed reader");
      assert.equal(namesStoreReader(claudeBackend), false);
    } finally { unregisterBackend("navcli"); }
  } finally { offNav(); offStore(); }
  assert.equal(screenReaderFor({ facts: { dialogs: [{ screen: "fake-nav" }] } }), null, "a reader that left answers nothing");
  assert.equal(namesStoreReader({ facts: { transcript: [{ store: "fake-db" }] } }), true, "…and the name still says a store was meant");
  assert.match(factProblems({ dialogs: [{ screen: "fake-nav" }] }, contributedReaders())[0], /no screen reader called `fake-nav`/);
});

test("forkVia 'server' opts in; everything else answers as before", () => {
  const off = registerStoreReader("srv-db", STORE);
  const srv = plugin("srvfork", { transcript: [{ store: "srv-db" }] }, { forkVia: "server" });
  registerBackend(srv);
  try {
    assert.equal(forkAtTurnRefusal("srvfork"), null);
    assert.equal(backendInfos().find((i) => i.id === "srvfork").caps.fork, true);
  } finally { unregisterBackend("srvfork"); }
  // `fork`/`resumePick` ride the `conversations` slot now: this plugin inherits claude's facts, so
  // it must say it lists none (a real plugin states its own facts).
  const local = plugin("dbonly", { transcript: [{ store: "srv-db" }], conversations: [] });
  registerBackend(local);
  try {
    assert.match(forkAtTurnRefusal("dbonly"), /live database/, "a store this host only reads cannot be cut at a turn");
    assert.equal(backendInfos().find((i) => i.id === "dbonly").caps.fork, false);
  } finally { unregisterBackend("dbonly"); off(); }
  assert.equal(forkAtTurnRefusal("claude"), null);
});

test("R6: `measured` rides the wire; a running version none of them is a sentence, never a refusal", async () => {
  const { measuredDriftText, primeNewBackendModels } = idx;
  assert.equal(measuredDriftText("Acme", ["1.0.91"], "1.0.91"), null, "measured on what runs: nothing to say");
  assert.equal(measuredDriftText("Acme", [], "1.0.95"), null, "nothing claimed, nothing compared");
  assert.equal(measuredDriftText("Acme", ["1.0.91"], null), null, "a binary that cannot tell is no drift");
  assert.match(measuredDriftText("Acme", ["1.0.91"], "1.0.95"), /^Acme was measured on 1\.0\.91, and this desktop is running 1\.0\.95 .* It still starts\.$/);
  assert.match(measuredDriftText("Acme", ["1.0.90", "1.0.91"], "2.0.0"), /measured on 1\.0\.90 or 1\.0\.91/);
  let running = "1.0.95";
  registerBackend(plugin("measuredcli", {}, { measured: { versions: ["1.0.91"], version: async () => running } }));
  try {
    await primeNewBackendModels();
    const info = backendInfos().find((i) => i.id === "measuredcli");
    assert.deepEqual(info.measured.versions, ["1.0.91"]);
    assert.equal(info.measured.running, "1.0.95");
    assert.match(info.measured.drift, /measured on 1\.0\.91, and this desktop is running 1\.0\.95/);
    assert.equal(knownBackend("measuredcli"), true, "the backend is still listed and launchable");
  } finally { unregisterBackend("measuredcli"); }
  running = null;
  registerBackend(plugin("mutecli", {}, { measured: { versions: ["1.0.91"], version: async () => running } }));
  try {
    await primeNewBackendModels();
    assert.deepEqual(backendInfos().find((i) => i.id === "mutecli").measured, { versions: ["1.0.91"] }, "running and drift ABSENT, not guessed");
  } finally { unregisterBackend("mutecli"); }
  for (const i of backendInfos()) assert.equal(i.measured, undefined, `${i.id}: a core backend carries no measured`);
});

test("R6: the desktop's checklist has ONE warn row per drifted plugin backend, the host's sentence verbatim", async () => {
  const { hostChecks, backendDriftRows } = await import("../dist/plugins/setupcontrib.js");
  const driftIds = () => hostChecks("/nonexistent-root").filter((c) => c.id.startsWith("backend-drift-"));
  assert.deepEqual(driftIds(), [], "core backends only (claude, claude-local, claude-endpoint, shell): no row");
  registerBackend(plugin("driftcli", {}, { measured: { versions: ["1.0.91"], version: async () => "1.0.95" } }));
  registerBackend(plugin("steadycli", {}, { measured: { versions: ["1.0.91"], version: async () => "1.0.91" } }));
  registerBackend(plugin("mutecli2", {}, { measured: { versions: ["1.0.91"], version: async () => null } }));
  try {
    await idx.primeNewBackendModels();
    const drift = backendInfos().find((i) => i.id === "driftcli").measured.drift;
    assert.ok(drift, "the host computed a sentence");
    assert.deepEqual(driftIds(), [{ id: "backend-drift-driftcli", label: "driftcli runs a version it was not measured on",
      status: "warn", scope: "host", fix: null, detail: drift }], "one warn, no fix, the sentence as the host said it");
  } finally { for (const id of ["driftcli", "steadycli", "mutecli2"]) unregisterBackend(id); }
  assert.deepEqual(driftIds(), [], "an unregistered backend's row goes with it");
  // The pure half: only `measured.drift` makes a row — a shell, or claude with no `measured`, never does.
  assert.deepEqual(backendDriftRows([
    { id: "claude", label: "Claude Code", caps: {}, models: { aliases: [], ids: [] } },
    { id: "shell", label: "Shell", kind: "shell", caps: {}, models: { aliases: [], ids: [] } },
    { id: "p", label: "P", caps: {}, models: { aliases: [], ids: [] }, measured: { versions: ["1"], running: "1" } },
  ]), []);
});
