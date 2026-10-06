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
  unregisterBackend, onBackendsChanged, BACKENDS, readerProblems, registerScreenReader, registerStoreReader,
  screenReaderFor, storeReaderFor, namesStoreReader } = idx;
// No extension is registered here: core's three are the whole list, whatever `packages/extensions/`
// holds (opencode's own registry assertions are `packages/extensions/opencode/test/`).

/** A contributed screen reader and store reader, the shape `api.screenReader` / `api.storeReader` take. */
const NAV = { candidate: () => false, read: () => null, prompt: () => null, stillUp: () => false, navTo: () => null };
const STORE = {
  source: "backend", updatedAt: () => null, pollUnchanged: () => false, transcript: () => null,
  toolDetails: () => null, contextSeries: () => null, discover: () => ({ id: null, carry: null }),
};

/** A plugin-shaped descriptor: claude's, renamed, with the knobs the test turns —
 *  minus claude's own `sources` (its hook pipe, design §10): a plugin brings its own. */
function plugin(id, caps = {}, extra = {}) {
  return { ...claudeBackend, id, label: id, caps: { ...claudeBackend.caps, ...caps }, sources: undefined, ...extra };
}
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
    () => registerBackend(plugin("cp", { promptBoxes: "copilot-numbered" })),
    /no screen reader called `copilot-numbered`; this host has: claude-numbered$/,
  );
  assert.throws(
    () => registerBackend(plugin("cp", { transcript: "copilot-events" })),
    /no transcript reader called `copilot-events`; this host has: claude-jsonl$/,
  );
  assert.equal(knownBackend("cp"), false, "nothing half-registered");
  assert.deepEqual(readerProblems({ promptBoxes: false, transcript: "none" }), []);
});

test("backendInfos derives each wire boolean from caps OR a source", () => {
  const bare = plugin("bare", { hooks: "none", promptBoxes: false, transcript: "none", contextMeter: false });
  const fed = plugin("fed", { hooks: "none", promptBoxes: false, transcript: "none", contextMeter: false }, {
    sources: { ...SRC, turns: {}, dialogs: {}, transcript: {}, context: {} },
  });
  registerBackend(bare);
  registerBackend(fed);
  try {
    const by = Object.fromEntries(backendInfos().map((i) => [i.id, i.caps]));
    for (const k of ["hooks", "promptBoxes", "transcript", "contextSeries"]) {
      assert.equal(by.bare[k], false, `bare.${k}: no reader and no source means the fact does not exist`);
      assert.equal(by.fed[k], true, `fed.${k}: a source alone makes it exist`);
    }
    assert.equal(by.fed.fork, false, "a source is not a file this app may copy");
    assert.equal(by.claude.hooks, true, "the screen-reader half is unchanged");
  } finally { unregisterBackend("bare"); unregisterBackend("fed"); }
});

test("one source is enough for just its own fact", () => {
  const onlyTurns = plugin("onlyturns", { hooks: "none", promptBoxes: false, transcript: "none", contextMeter: false }, { sources: { ...SRC, turns: {} } });
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
    registerBackend(plugin("navcli", { promptBoxes: "fake-nav", transcript: "fake-db" }));
    try {
      const b = resolveBackend("navcli");
      assert.equal(screenReaderFor(b.caps), NAV);
      assert.equal(storeReaderFor(b.caps), STORE);
      assert.equal(namesStoreReader(b.caps), true);
      assert.equal(storeReaderFor(claudeBackend.caps), null, "claude's jsonl is core's, never a contributed reader");
      assert.equal(namesStoreReader(claudeBackend.caps), false);
    } finally { unregisterBackend("navcli"); }
  } finally { offNav(); offStore(); }
  assert.equal(screenReaderFor({ promptBoxes: "fake-nav" }), null, "a reader that left answers nothing");
  assert.equal(namesStoreReader({ transcript: "fake-db" }), true, "…and the name still says a store was meant");
  assert.match(readerProblems({ promptBoxes: "fake-nav", transcript: "none" })[0], /no screen reader called `fake-nav`/);
});

test("forkVia 'server' opts in; everything else answers as before", () => {
  const off = registerStoreReader("srv-db", STORE);
  const srv = plugin("srvfork", { transcript: "srv-db", forkVia: "server" });
  registerBackend(srv);
  try {
    assert.equal(forkAtTurnRefusal("srvfork"), null);
    assert.equal(backendInfos().find((i) => i.id === "srvfork").caps.fork, true);
  } finally { unregisterBackend("srvfork"); }
  const local = plugin("dbonly", { transcript: "srv-db" });
  registerBackend(local);
  try {
    assert.match(forkAtTurnRefusal("dbonly"), /live database/, "a store this host only reads cannot be cut at a turn");
    assert.equal(backendInfos().find((i) => i.id === "dbonly").caps.fork, false);
  } finally { unregisterBackend("dbonly"); off(); }
  assert.equal(forkAtTurnRefusal("claude"), null);
});
