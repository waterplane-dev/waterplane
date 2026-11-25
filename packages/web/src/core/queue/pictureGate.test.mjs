/**
 * A picture's submit waits for the words being dictated beside it.
 *
 *     node --test packages/web/src/core/queue/pictureGate.test.mjs
 *
 * The annotator's *Send & run* used to submit the moment the picture was parked: the prompt ran with the
 * picture alone and the transcript landed in an empty box afterwards. `settleUploads` asks the compose
 * bar's dictation gate first, and while that holds it nothing is queued and nothing is cleared.
 */
import "../../../../../scripts/lib-tsload.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
const { uploadFns } = await import("./uploads.ts");
globalThis.window = { setTimeout: () => 0, clearTimeout: () => {} };

const ref = (current) => ({ current });
const PIC = ".claude/inbox/a.png";

function harness({ gate, active = "s1", draft = "look at this" }) {
  const sent = [];
  const boxed = [];
  const c = {
    up: {
      inflightRef: ref(0), parkingRef: ref(0), upBytesRef: ref({}), allBufsRef: ref(new Set()), uploadBufRef: ref(null),
      setUploading() {}, setUpProg() {}, refreshUploadLabel() {},
    },
    uploadsInFlight: ref(new Set()), uploadAborts: ref(new Map()), repos: [],
    sessionsRef: ref([{ id: "s1", cwd: "/repo", running: true }]),
    activeIdRef: ref(active), composeTextRef: ref(draft), dictationGate: ref(gate),
    connRef: ref({ status: "open" }), getActive: () => null, setActiveId() {},
    setCompose: (v) => { boxed.push(v); c.composeTextRef.current = v; },
    pushHistory() {}, removeQueued() {},
    submitInput: (id, _cwd, text) => { sent.push(["now", id, text]); return true; },
    queueBacklog: (o) => { sent.push(["free", o.targetSessionId, o.text]); return false; },
  };
  const buf = (over) => ({
    repoId: "/repo", slots: [PIC], started: 1, done: 1, closed: true, submit: false, queue: false,
    ctrl: new AbortController(), ackIds: [], target: { id: "s1", cwd: "/repo" }, ...over,
  });
  return { c, sent, boxed, buf, fns: uploadFns(c) };
}

for (const [how, over] of [["now", { submit: true }], ["free", { queue: true }]]) {
  test(`${how}: held while the dictation is out, then sent once with the words`, () => {
    const asked = [];
    const h = harness({ gate: (o) => { asked.push(o); return true; } });
    const b = h.buf(over);
    h.fns.settleUploads(b);
    assert.deepEqual(h.sent, [], "nothing goes while the words are out");
    assert.deepEqual(h.boxed, [], "and the box is the gate's to write");
    assert.equal(asked[0].sid, "s1");
    assert.equal(asked[0].box, `look at this ${PIC}`);
    h.fns.settleUploads(b);
    assert.equal(asked.length, 1, "one batch asks once");
    h.c.composeTextRef.current = `look at this ${PIC} and fix the header`;
    asked[0].go();
    assert.deepEqual(h.sent, [[how, "s1", `look at this ${PIC} and fix the header`]]);
    assert.deepEqual(h.boxed, [""]);
  });

  test(`${how}: nothing dictated, sent at once as before`, () => {
    const h = harness({ gate: () => false });
    h.fns.settleUploads(h.buf(over));
    assert.deepEqual(h.sent, [[how, "s1", `look at this ${PIC}`]]);
  });
}

test("a plain attach never asks, nor does a send for a session that is not on screen", () => {
  const never = () => { throw new Error("asked"); };
  const plain = harness({ gate: never });
  plain.fns.settleUploads(plain.buf({}));
  assert.deepEqual(plain.boxed, [`look at this ${PIC}`]);
  const away = harness({ gate: never, active: "s2" });
  away.fns.settleUploads(away.buf({ submit: true }));
  assert.deepEqual(away.sent, [["now", "s1", PIC]]);
});
