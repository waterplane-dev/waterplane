import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InstallLogStore } from "../dist/installlog.js";

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
