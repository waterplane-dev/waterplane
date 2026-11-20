// The install-log store's behaviour, moved from packages/host/test/installlog.test.mjs when P5 deleted core's
// host/installlog.ts: the same cases, now against the android-apps extension's store (the file's one writer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { InstallLogStore: Store } = await import("../../../host/dist/extensions/android-apps/host/installlog.mjs");
const { installLogSummary } = await import("../../../host/dist/extensions/android-apps/shared/wire.mjs");

/** The extension's store over `<root>/.waterplane/installs.json`, writing — what core's store did before P5. */
class InstallLogStore extends Store {
  constructor(dir) { super(join(dir, ".waterplane", "installs.json"), { write: true }); }
}

const root = () => mkdtempSync(join(tmpdir(), "waterplane-installs-"));
const PHONE = { id: "aa11bb22", name: "kitchen phone", model: "Pixel 8" };
const row = (over = {}) => ({
  pullId: "l_1",
  pkg: "de.hoh.tiptoi",
  label: "Tiptoi",
  version: "0.1.98",
  outcome: "installed",
  auto: true,
  at: 1_700_000_000_000,
  ...over,
});

test("a report lands, and says so", () => {
  const store = new InstallLogStore(root());
  assert.deepEqual(store.report(PHONE, [row()]), { added: 1, updated: 0 });
  const doc = store.doc();
  assert.equal(doc.total, 1);
  assert.equal(doc.entries[0].deviceName, "kitchen phone");
  assert.equal(doc.devices.length, 1);
  assert.equal(doc.devices[0].installs, 1);
});

test("a reconnect re-stating the same history changes nothing", () => {
  const store = new InstallLogStore(root());
  store.report(PHONE, [row()]);
  // This is what every `hello` does, for ever.
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(store.report(PHONE, [row()]), { added: 0, updated: 0 });
  }
  assert.equal(store.doc().total, 1);
});

test("rows that are not installs never reach the store", () => {
  const store = new InstallLogStore(root());
  const got = store.report(PHONE, [
    row({ outcome: "asked" }),
    row({ pullId: "l_2", pkg: "" }),
    null,
    "nonsense",
    row({ pullId: "l_3" }),
  ]);
  assert.equal(got.added, 1);
  assert.equal(store.doc().total, 1);
});

test("a report nobody can attribute is refused whole", () => {
  const store = new InstallLogStore(root());
  assert.deepEqual(store.report({ id: "" }, [row()]), { added: 0, updated: 0 });
  assert.equal(store.doc().total, 0);
});

test("the log survives a restart, which is routine here", () => {
  const dir = root();
  const store = new InstallLogStore(dir);
  store.report(PHONE, [row()]);
  store.report({ id: "cc33dd44" }, [row({ pullId: "l_9", outcome: "failed", error: "no space" })]);
  store.flush();
  const back = new InstallLogStore(dir);
  const doc = back.doc();
  assert.equal(doc.total, 2);
  assert.equal(doc.devices.length, 2);
  assert.match(readFileSync(join(dir, ".waterplane", "installs.json"), "utf8"), /de\.hoh\.tiptoi/);
  // …and re-reporting against the restored store still adds nothing.
  assert.deepEqual(back.report(PHONE, [row()]), { added: 0, updated: 0 });
});

test("a hand-edited file is cleaned on the way in, never trusted", () => {
  const dir = root();
  mkdirSync(join(dir, ".waterplane"), { recursive: true });
  writeFileSync(join(dir, ".waterplane", "installs.json"), JSON.stringify({
    entries: [
      { key: "x", deviceId: "aa11bb22", pullId: "l_1", pkg: "de.hoh.tiptoi", outcome: "installed", auto: true, reportedAt: 5 },
      { key: "y", deviceId: "aa11bb22", pullId: "l_2", outcome: "who knows", reportedAt: 5 },
      { nonsense: true },
    ],
  }));
  const doc = new InstallLogStore(dir).doc();
  assert.equal(doc.total, 1);
  assert.equal(doc.entries[0].pkg, "de.hoh.tiptoi");
});

test("an unreadable file is an empty log, never a throw", () => {
  const dir = root();
  mkdirSync(join(dir, ".waterplane"), { recursive: true });
  writeFileSync(join(dir, ".waterplane", "installs.json"), "{ not json");
  assert.equal(new InstallLogStore(dir).doc().total, 0);
});

test("a row with no record of when the host was told is dropped, never stamped now", () => {
  const dir = root();
  mkdirSync(join(dir, ".waterplane"), { recursive: true });
  writeFileSync(join(dir, ".waterplane", "installs.json"), JSON.stringify({
    entries: [
      { deviceId: "aa11bb22", pullId: "l_1", pkg: "de.hoh.tiptoi", outcome: "installed", reportedAt: 5 },
      { deviceId: "aa11bb22", pullId: "l_2", pkg: "de.hoh.tiptoi", outcome: "installed" },
      { deviceId: "aa11bb22", pullId: "l_3", pkg: "de.hoh.tiptoi", outcome: "installed", reportedAt: 0 },
    ],
  }));
  const doc = new InstallLogStore(dir).doc();
  assert.equal(doc.total, 1);
  assert.equal(doc.entries[0].pullId, "l_1");
});

test("a report past the per-report cap keeps the NEWEST, not the first listed", () => {
  const store = new InstallLogStore(root());
  // Oldest-first, which is the order that used to lose the newest install.
  const many = [];
  for (let i = 0; i < 320; i++) many.push(row({ pullId: `l_${i}`, at: Date.now() - 400_000 + i }));
  store.report(PHONE, many);
  const entries = store.doc().entries;
  // The oldest 20 never reached the store at all — the report carries 300 and
  // they are the 300 NEWEST, not the 300 the phone happened to list first.
  assert.equal(entries.length, 300);
  const ats = entries.map((e) => e.at).sort((a, b) => a - b);
  assert.equal(ats.length, 300);
  assert.ok(ats[0] > many[19].at, "the twenty oldest are the ones that were dropped");
});

test("a log that cannot be read (EMFILE) is left alone, never renamed aside or saved over", async () => {
  const fsMod = await import("node:fs");
  const dir = root();
  const good = new InstallLogStore(dir);
  good.report(PHONE, [row()]);
  good.flush();
  const file = join(dir, ".waterplane", "installs.json");
  const before = readFileSync(file, "utf8");
  let failing = true;
  const flaky = {
    ...fsMod,
    readFileSync: (p, enc) => {
      if (failing) throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
      return fsMod.readFileSync(p, enc);
    },
  };
  const store = new Store(file, { write: true, fs: flaky });
  store.report({ id: "cc33dd44" }, [row({ pullId: "l_9" })]);
  store.flush();
  assert.equal(readFileSync(file, "utf8"), before, "the good file is untouched");
  assert.deepEqual(fsMod.readdirSync(join(dir, ".waterplane")), ["installs.json"], "nothing renamed aside");
  failing = false;
  store.report({ id: "cc33dd44" }, [row({ pullId: "l_10" })]);
  store.flush();
  assert.equal(new InstallLogStore(dir).doc().total, 3, "what was held merges with what was on disk");
});

test("a transient read error at start does not leave an empty log for the daemon's life", async () => {
  const fsMod = await import("node:fs");
  const dir = root();
  const good = new InstallLogStore(dir);
  good.report(PHONE, [row(), row({ pullId: "l_2" })]);
  good.flush();
  const file = join(dir, ".waterplane", "installs.json");
  let failing = true;
  const flaky = { ...fsMod, readFileSync: (p, enc) => {
    if (failing) { failing = false; throw Object.assign(new Error("too many open files"), { code: "EMFILE" }); }
    return fsMod.readFileSync(p, enc);
  } };
  const warn = console.warn; const warned = []; console.warn = (...a) => warned.push(a.join(" "));
  let store;
  try { store = new Store(file, { write: true, fs: flaky }); } finally { console.warn = warn; }
  assert.equal(warned.length, 1, "the unreadable start is said once");
  assert.equal(store.doc().total, 2, "the next read finds the file again");
});

test("a row reported while the file was unreadable is merged and saved once it reads, even if the phone re-states nothing new", async () => {
  const fsMod = await import("node:fs");
  const dir = root();
  const good = new InstallLogStore(dir);
  good.report(PHONE, [row()]);
  good.flush();
  const file = join(dir, ".waterplane", "installs.json");
  let failing = 2;
  const flaky = { ...fsMod, readFileSync: (p, enc) => {
    if (failing-- > 0) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return fsMod.readFileSync(p, enc);
  } };
  const warn = console.warn; console.warn = () => {};
  try {
    const store = new Store(file, { write: true, fs: flaky }); // read 1 fails
    store.report({ id: "cc33dd44" }, [row({ pullId: "l_7" })]); // recover read 2 fails: row held
    store.report(PHONE, [row()]); // read ok: merges, saves although this report adds nothing
    store.flush();
  } finally { console.warn = warn; }
  assert.equal(new InstallLogStore(dir).doc().total, 2, "the held row reached the disk");
});

test("an install log that stays unreadable says so in the reply, warns once, and report is not kept", async () => {
  const fsMod = await import("node:fs");
  const dir = root();
  const good = new InstallLogStore(dir);
  good.report(PHONE, [row()]);
  good.flush();
  const file = join(dir, ".waterplane", "installs.json");
  const denied = { ...fsMod, readFileSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
  const warn = console.warn; const warned = []; console.warn = (...a) => warned.push(a.join(" "));
  try {
    const store = new Store(file, { write: true, fs: denied });
    store.report(PHONE, [row({ pullId: "l_9" })]);
    assert.equal(store.saves, false, "nothing can be saved while the file is unread");
    assert.match(store.doc().unreadable ?? "", /denied|EACCES/);
    store.doc(); store.doc();
  } finally { console.warn = warn; }
  assert.equal(warned.length, 1, "one warning for the outage, not one per call");
  assert.equal(new InstallLogStore(dir).doc().unreadable, undefined, "a readable log carries no field");
});

test("a log that did not parse is moved aside, and the reply keeps saying so after the re-read finds nothing", () => {
  const dir = root();
  mkdirSync(join(dir, ".waterplane"), { recursive: true });
  writeFileSync(join(dir, ".waterplane", "installs.json"), '{"entries": [');
  const warn = console.warn; const warned = []; console.warn = (...a) => warned.push(a.join(" "));
  let doc;
  try { const store = new InstallLogStore(dir); store.doc(); doc = store.doc(); } finally { console.warn = warn; }
  assert.match(doc.movedAside ?? "", /installs\.json\.corrupt-/, "the set-aside file is named in the reply");
  assert.equal(doc.unreadable, undefined, "saving works again");
  assert.match(installLogSummary(doc), /set aside/);
  assert.equal(warned.length, 1);
});

test("a file moved aside later in an outage still gets its own warning line", async () => {
  const fsMod = await import("node:fs");
  const dir = root();
  mkdirSync(join(dir, ".waterplane"), { recursive: true });
  const file = join(dir, ".waterplane", "installs.json");
  writeFileSync(file, '{"entries": [');
  let phase = 0;
  const flaky = { ...fsMod, readFileSync: (p, enc) => {
    if (phase++ === 0) throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
    return fsMod.readFileSync(p, enc);
  } };
  const warn = console.warn; const warned = []; console.warn = (...a) => warned.push(a.join(" "));
  try { const store = new Store(file, { write: true, fs: flaky }); store.doc(); } finally { console.warn = warn; }
  assert.equal(warned.length, 2, "the read error and the later move are two lines");
  assert.match(warned[1], /moved aside to .*corrupt-/);
});

test("a corrupt log that cannot be moved aside warns once, not on every read", async () => {
  const fsMod = await import("node:fs");
  const dir = root();
  mkdirSync(join(dir, ".waterplane"), { recursive: true });
  const file = join(dir, ".waterplane", "installs.json");
  writeFileSync(file, "{bad");
  const stuck = { ...fsMod, renameSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
  const warn = console.warn; const warned = []; console.warn = (...a) => warned.push(a.join(" "));
  try { const store = new Store(file, { write: true, fs: stuck }); for (let i = 0; i < 5; i++) store.doc(); } finally { console.warn = warn; }
  assert.equal(warned.length, 1, "an outage with nothing moved is one line");
});
