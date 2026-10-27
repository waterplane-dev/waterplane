// The release's sideload APK: what it must be called and which build it must be.
// Pure of gradle and keystores: it only READS a finished .apk. Naming and the dev appId come from
// packages/shared/src/brand.ts (releaseApkName / devApplicationId), the same source `pair.ts` uses.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

/** Read a zip's entry by name (central directory; stored or deflated). Null if absent. */
export function zipEntry(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    if (buf.toString("utf8", p + 46, p + 46 + nlen) === name) {
      const data = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
      const raw = buf.subarray(data, data + csize);
      if (method === 0) return raw;
      if (method === 8) return inflateRawSync(raw);
      throw new Error(`unsupported zip compression method ${method}`);
    }
    p += 46 + nlen + elen + clen;
  }
  return null;
}

/** The build stamp `build.gradle` packs into the shell (`assets/buildstamp.json`; an AAB keeps it
 *  under `base/`), parsed; null when the file predates the stamp or it does not parse. */
export function packagedStamp(buf) {
  for (const name of ["assets/buildstamp.json", "base/assets/buildstamp.json"]) {
    const raw = zipEntry(buf, name);
    if (!raw) continue;
    try {
      const s = JSON.parse(raw.toString("utf8"));
      return s && typeof s === "object" && typeof s.at === "number" ? s : null;
    } catch { return null; }
  }
  return null;
}

/** The `package` attribute of the root <manifest> in a binary AndroidManifest.xml (AXML). */
export function axmlPackage(buf) {
  if (buf.readUInt16LE(0) !== 0x0003) throw new Error("AndroidManifest.xml is not binary XML");
  const total = Math.min(buf.readUInt32LE(4), buf.length);
  const strings = [];
  for (let p = buf.readUInt16LE(2); p + 8 <= total; ) {
    const type = buf.readUInt16LE(p), size = buf.readUInt32LE(p + 4);
    if (size < 8) break;
    if (type === 0x0001) {
      const n = buf.readUInt32LE(p + 8), flags = buf.readUInt32LE(p + 16), base = p + buf.readUInt32LE(p + 20);
      const utf8 = (flags & 0x100) !== 0;
      for (let i = 0; i < n; i++) {
        let q = base + buf.readUInt32LE(p + 28 + i * 4);
        if (utf8) {
          const len8 = () => { let l = buf[q++]; if (l & 0x80) l = ((l & 0x7f) << 8) | buf[q++]; return l; };
          len8();
          const bl = len8();
          strings.push(buf.toString("utf8", q, q + bl));
        } else {
          const l = buf.readUInt16LE(q);
          strings.push(buf.toString("utf16le", q + 2, q + 2 + l * 2));
        }
      }
    } else if (type === 0x0102) { // first start-element = <manifest>
      const attrStart = p + 16 + buf.readUInt16LE(p + 24), cnt = buf.readUInt16LE(p + 28);
      for (let i = 0; i < cnt; i++) {
        const a = attrStart + i * 20;
        if (strings[buf.readUInt32LE(a + 4)] !== "package") continue;
        const raw = buf.readInt32LE(a + 8);
        return raw >= 0 ? strings[raw] : strings[buf.readUInt32LE(a + 16)];
      }
      throw new Error("<manifest> has no package attribute");
    }
    p += size;
  }
  throw new Error("no <manifest> element found in AndroidManifest.xml");
}

const defaultRun = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** The APK's applicationId, via apkanalyzer / aapt when on PATH, else a direct read of the zip.
 *  `run` is injectable (a stub that throws simulates a missing tool). */
export function readApplicationId(apkPath, { run = defaultRun, readFile = readFileSync } = {}) {
  try {
    const id = run("apkanalyzer", ["manifest", "application-id", apkPath]).trim();
    if (id) return { id, via: "apkanalyzer" };
  } catch { /* not installed or failed: next reader */ }
  for (const tool of ["aapt2", "aapt"]) {
    try {
      const m = /package: name='([^']+)'/.exec(run(tool, ["dump", "badging", apkPath]));
      if (m) return { id: m[1], via: tool };
    } catch { /* next */ }
  }
  const manifest = zipEntry(readFile(apkPath), "AndroidManifest.xml");
  if (!manifest) throw new Error("the APK has no AndroidManifest.xml");
  return { id: axmlPackage(manifest), via: "zip" };
}

/** Throw unless `actual` is the DEV flavor id; the play flavor gets its own sentence. */
export function assertDevApplicationId(actual, devId, appId) {
  if (actual === devId) return;
  if (actual === appId) throw new Error(`this is the PLAY flavor APK (${actual}); the release asset must be the dev flavor (${devId}). Play builds ship through Google Play, never as a sideload asset.`);
  throw new Error(`APK applicationId is "${actual}", expected the dev flavor "${devId}".`);
}

/** The whole gate: read the id, check it, return it. Never silently skips. */
export function verifyDevApk(apkPath, devId, appId, opts) {
  let r;
  try { r = readApplicationId(apkPath, opts); }
  catch (e) { throw new Error(`cannot read the applicationId of ${apkPath} (no apkanalyzer/aapt on PATH, and the manifest could not be parsed directly: ${e.message}). Refusing to attach an unverified APK.`); }
  assertDevApplicationId(r.id, devId, appId);
  return r;
}
