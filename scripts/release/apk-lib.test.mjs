import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { BRAND, devApplicationId, releaseApkName } from "../../packages/shared/dist/brand.js";
import { releaseApkName as viaIndex } from "../../packages/shared/dist/index.js";
import { assertDevApplicationId, axmlPackage, readApplicationId, verifyDevApk, zipEntry } from "./apk-lib.mjs";

// A minimal binary AndroidManifest: strings ["manifest","package",<id>], one <manifest package=id>.
function axml(id, { utf8 = false } = {}) {
  const strs = ["manifest", "package", id];
  const enc = strs.map((s) => {
    if (utf8) { const b = Buffer.from(s); return Buffer.concat([Buffer.from([s.length, b.length]), b, Buffer.from([0])]); }
    const b = Buffer.from(s, "utf16le"); const l = Buffer.alloc(2); l.writeUInt16LE(s.length);
    return Buffer.concat([l, b, Buffer.alloc(2)]);
  });
  const offs = []; let o = 0; for (const e of enc) { offs.push(o); o += e.length; }
  const body = Buffer.concat(enc); const pad = (4 - (body.length % 4)) % 4;
  const pool = Buffer.alloc(28 + 4 * strs.length); const poolSize = pool.length + body.length + pad;
  pool.writeUInt16LE(1, 0); pool.writeUInt16LE(28, 2); pool.writeUInt32LE(poolSize, 4);
  pool.writeUInt32LE(strs.length, 8); pool.writeUInt32LE(utf8 ? 0x100 : 0, 16); pool.writeUInt32LE(28 + 4 * strs.length, 20);
  offs.forEach((v, i) => pool.writeUInt32LE(v, 28 + 4 * i));
  const el = Buffer.alloc(36 + 20);
  el.writeUInt16LE(0x102, 0); el.writeUInt16LE(16, 2); el.writeUInt32LE(el.length, 4);
  el.writeInt32LE(-1, 16); el.writeUInt32LE(0, 20); el.writeUInt16LE(20, 24); el.writeUInt16LE(20, 26); el.writeUInt16LE(1, 28);
  el.writeInt32LE(-1, 36); el.writeUInt32LE(1, 40); el.writeInt32LE(2, 44); // ns, name="package", raw=id
  const head = Buffer.alloc(8); head.writeUInt16LE(3, 0); head.writeUInt16LE(8, 2);
  const all = Buffer.concat([head, pool, body, Buffer.alloc(pad), el]); all.writeUInt32LE(all.length, 4); return all;
}

// A tiny zip with one entry (local header + central directory + EOCD).
function zip(name, data, deflate) {
  const raw = deflate ? deflateRawSync(data) : data, nb = Buffer.from(name);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(raw.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(deflate ? 8 : 0, 10); cd.writeUInt32LE(raw.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nb.length, 28); cd.writeUInt32LE(0, 42);
  const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(1, 8); eo.writeUInt16LE(1, 10); eo.writeUInt32LE(46 + nb.length, 12); eo.writeUInt32LE(30 + nb.length + raw.length, 16);
  return Buffer.concat([lh, nb, raw, cd, nb, eo]);
}
const apk = (id, o) => zip("AndroidManifest.xml", axml(id, o), true);
const noTools = () => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); };
const DEV = devApplicationId(BRAND.appId);

test("naming: one shared rule, exported through the package index", () => {
  assert.equal(releaseApkName("waterplane", "1.2.3"), "waterplane-1.2.3.apk");
  assert.equal(viaIndex, releaseApkName);
  assert.equal(DEV, `${BRAND.appId}.dev`);
});

test("zip + axml: the package comes out of a real-shaped binary manifest (utf16 and utf8 pools)", () => {
  for (const utf8 of [false, true]) {
    assert.equal(axmlPackage(zipEntry(apk("dev.x.app.dev", { utf8 }), "AndroidManifest.xml")), "dev.x.app.dev");
  }
  assert.equal(zipEntry(zip("a.txt", Buffer.from("hi"), false), "AndroidManifest.xml"), null);
  assert.throws(() => zipEntry(Buffer.from("nope"), "x"), /not a zip/);
});

test("appId check: dev passes, play and foreign ids are refused in words", () => {
  const read = (id) => ({ run: noTools, readFile: () => apk(id) });
  assert.equal(verifyDevApk("x.apk", DEV, BRAND.appId, read(DEV)).via, "zip");
  assert.throws(() => verifyDevApk("x.apk", DEV, BRAND.appId, read(BRAND.appId)), /PLAY flavor/);
  assert.throws(() => verifyDevApk("x.apk", DEV, BRAND.appId, read("com.other.app")), /expected the dev flavor/);
  assert.doesNotThrow(() => assertDevApplicationId(DEV, DEV, BRAND.appId));
});

test("appId check: tools win when present; an unreadable APK fails loudly, never skips", () => {
  const aapt = (cmd) => { if (cmd !== "aapt") throw new Error("missing"); return `package: name='${DEV}' versionCode='1'\n`; };
  assert.deepEqual(readApplicationId("x.apk", { run: aapt }), { id: DEV, via: "aapt" });
  const ana = (cmd) => { if (cmd === "apkanalyzer") return `${DEV}\n`; throw new Error("missing"); };
  assert.equal(readApplicationId("x.apk", { run: ana }).via, "apkanalyzer");
  assert.throws(() => verifyDevApk("x.apk", DEV, BRAND.appId, { run: noTools, readFile: () => Buffer.from("garbage") }), /Refusing to attach an unverified APK/);
});
