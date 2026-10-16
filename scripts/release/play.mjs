#!/usr/bin/env node
// Publish the Android `play` flavor to Google Play without opening Play Console. DRY RUN unless
// --yes: the dry run signs in, opens an edit, reads the tracks, prints what the real run would
// do, and deletes the edit — so it also proves the credentials work.
//
//   npm run release:play -- [upload] [--yes] [--track internal|alpha|beta|production]
//                           [--rollout 0.1|10%] [--draft] [--notes "…"] [--listing]
//                           [--aab <file>] [--no-build] [--version-code N] [--no-send-for-review]
//                           [--allow-dirty]
//   npm run release:play -- build [--version-code N]          the AAB only (the first, manual upload)
//   npm run release:play -- status                            every track's releases
//   npm run release:play -- promote --to production [--from internal] [--rollout 10%] [--yes]
//   npm run release:play -- rollout --track production --rollout 50% [--yes]   (100% completes it)
//   npm run release:play -- listing [--yes]                   store text + images only
//   npm run release:play -- keygen                            make the Play UPLOAD key, once
//
// upload: builds the play AAB (web → cap sync → gradle bundlePlayRelease) with versionCode = one
// past the highest Play has seen and versionName = the root package.json version, uploads it,
// puts it on --track (default internal) with packages/app/play/release-notes/<locale>.txt, and
// with --listing also the store listing from packages/app/play/listings/<locale>/.
//
// Credentials: a service-account JSON key at <ENV_PREFIX>PLAY_SA, else
// ~/.config/<slug>-release/play-service-account.json. Never in the repo. Setup: packages/app/play/README.md.
// Pure parts: play-lib.mjs.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND } from "../../packages/shared/dist/brand.js";
import { E, SLUG } from "../lib-brand.mjs";
import {
  AAB_PATH, API, PLAY_DIR, UPLOAD_API, defaultServiceAccountPath, explainApiError, latestRelease, nextVersionCode,
  parseArgs, parseServiceAccount, readListings, readReleaseNotes, releaseFor, serviceAccountAssertion,
} from "./play-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const APP = join(ROOT, "packages/app");
const PKG = BRAND.appId;
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

function die(msg, code = 1) { console.error(`release:play: ${msg}`); process.exit(code); }
const log = (s = "") => console.log(s);

let opts;
try { opts = parseArgs(process.argv.slice(2)); } catch (e) { die(e.message, 2); }

// ── Play API ───────────────────────────────────────────────────────────────
class PlayError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function accessToken() {
  const saPath = process.env[E.PLAY_SA] || defaultServiceAccountPath(SLUG);
  if (!existsSync(saPath)) die(`no service-account key at ${saPath} (or set ${E.PLAY_SA}). Setup: ${PLAY_DIR}/README.md`);
  let sa;
  try { sa = parseServiceAccount(readFileSync(saPath, "utf8")); } catch (e) { die(`${saPath}: ${e.message}`); }
  const res = await fetch(sa.tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountAssertion(sa) }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) die(`signing in as ${sa.email} failed: ${j.error_description || j.error || res.status}`);
  return { token: j.access_token, email: sa.email };
}

function client(token) {
  const call = async (method, url, { json, body, headers = {}, raw = false } = {}) => {
    const h = { authorization: `Bearer ${token}`, ...headers };
    if (json !== undefined) h["content-type"] = "application/json";
    const res = await fetch(url, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body });
    if (raw) return res;
    const text = await res.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return { text }; } })() : {};
    if (!res.ok) throw new PlayError(res.status, data.error?.message || text || `HTTP ${res.status}`);
    return data;
  };
  const app = `${API}/applications/${PKG}`;
  const up = `${UPLOAD_API}/applications/${PKG}`;
  return {
    insertEdit: () => call("POST", `${app}/edits`, { json: {} }),
    deleteEdit: (e) => call("DELETE", `${app}/edits/${e}`),
    commit: (e, sendForReview) => call("POST", `${app}/edits/${e}:commit${sendForReview ? "" : "?changesNotSentForReview=true"}`),
    tracks: async (e) => (await call("GET", `${app}/edits/${e}/tracks`)).tracks ?? [],
    track: (e, t) => call("GET", `${app}/edits/${e}/tracks/${t}`),
    setTrack: (e, t, releases) => call("PUT", `${app}/edits/${e}/tracks/${t}`, { json: { track: t, releases } }),
    setListing: (e, lang, text) => call("PUT", `${app}/edits/${e}/listings/${lang}`, { json: { language: lang, ...text } }),
    clearImages: (e, lang, type) => call("DELETE", `${app}/edits/${e}/listings/${lang}/${type}`),
    uploadImage: (e, lang, type, file) => call("POST", `${up}/edits/${e}/listings/${lang}/${type}?uploadType=media`, {
      body: readFileSync(file), headers: { "content-type": /\.png$/i.test(file) ? "image/png" : "image/jpeg" },
    }),
    // Resumable: the bundle can be tens of MB, past what a one-shot media upload reliably takes.
    uploadBundle: async (e, file) => {
      const bytes = readFileSync(file);
      const start = await call("POST", `${up}/edits/${e}/bundles?uploadType=resumable`, {
        raw: true, headers: { "x-upload-content-type": "application/octet-stream", "x-upload-content-length": String(bytes.length) },
      });
      const loc = start.headers.get("location");
      if (!start.ok || !loc) throw new PlayError(start.status, (await start.text()) || "no upload session");
      return call("PUT", loc, { body: bytes, headers: { "content-type": "application/octet-stream" } });
    },
  };
}

/** Run `fn` inside one edit; commit with --yes, else delete it (the dry run leaves nothing behind). */
async function withEdit(fn) {
  const { token, email } = await accessToken();
  const play = client(token);
  let edit;
  try { edit = (await play.insertEdit()).id; } catch (e) { fail(e, email); }
  try {
    await fn(play, edit);
    if (opts.yes) {
      await play.commit(edit, opts.sendForReview);
      log(`committed${opts.sendForReview ? "" : " (not sent for review — send it in Play Console)"}`);
    } else {
      await play.deleteEdit(edit).catch(() => {});
      log("\nDRY RUN — nothing was changed on Play. Re-run with --yes to do it.");
    }
  } catch (e) {
    await play.deleteEdit(edit).catch(() => {});
    fail(e, email);
  }
}

function fail(e, email) {
  if (!(e instanceof PlayError)) throw e;
  const hint = explainApiError(e.status, e.message);
  die(`Play said (${e.status}): ${e.message}${hint ? `\n  → ${hint}` : ""}${e.status === 403 ? `\n  (service account: ${email})` : ""}`);
}

const describe = (r) => {
  const pct = r.userFraction != null ? ` ${Math.round(r.userFraction * 1000) / 10}%` : "";
  return `${r.name ?? "(unnamed)"} · versionCode ${(r.versionCodes ?? []).join(",")} · ${r.status}${pct}`;
};

// ── local build ───────────────────────────────────────────────────────────
function run(cmd, args, cwd) {
  log(`$ ${cmd} ${args.join(" ")}   (in ${relative(ROOT, cwd) || "."})`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) die(`${cmd} ${args[0]} failed (exit ${r.status})`);
}

function buildAab(versionCode) {
  run("npm", ["run", "sync"], APP);
  run("./gradlew", ["bundlePlayRelease", `-PversionCode=${versionCode}`, `-PversionName=${VERSION}`], join(APP, "android"));
  const aab = join(ROOT, AAB_PATH);
  if (!existsSync(aab)) die(`gradle finished but ${AAB_PATH} is not there`);
  return aab;
}

/** The AAB carries the web UI from this working tree, and `npm run sync` rebuilds packages/web/dist,
 *  which the running host also serves over the air: refuse to ship someone's half-edit either way. */
function assertCleanTree() {
  const dirty = execFileSync("git", ["status", "--porcelain", "--", "packages/web", "packages/shared", "packages/app", "packages/extensions"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (dirty && !opts.allowDirty) {
    die(`the tree the AAB is built from has uncommitted changes:\n${dirty}\nCommit them (or --allow-dirty to ship them anyway).`);
  }
}

/** build.gradle's default versionCode: the floor for the first API upload after the manual one. */
const gradleDefaultCode = () => {
  const m = readFileSync(join(APP, "android/app/build.gradle"), "utf8").match(/findProperty\('versionCode'\) \?: '(\d+)'/);
  if (!m) die("cannot find the default versionCode in packages/app/android/app/build.gradle");
  return Number(m[1]);
};

// ── commands ──────────────────────────────────────────────────────────────
const commands = {
  async build() {
    assertCleanTree();
    const code = opts.versionCode ?? gradleDefaultCode();
    const aab = buildAab(code);
    log(`\n${relative(ROOT, aab)} — versionCode ${code}, versionName ${VERSION}, signed with the Play upload key.`);
    log("First upload only: Play Console → your app → Test and release → Internal testing → Create release → drop this file in.");
  },

  async status() {
    opts.yes = false;
    await withEdit(async (play, edit) => {
      const tracks = await play.tracks(edit);
      for (const t of tracks) {
        log(`${t.track}`);
        for (const r of t.releases ?? []) log(`  ${describe(r)}`);
      }
      if (!tracks.length) log("no tracks yet");
      log(`next versionCode: ${nextVersionCode(tracks, gradleDefaultCode())}`);
    });
  },

  async upload() {
    const { notes, problems: np } = readReleaseNotes(join(ROOT, PLAY_DIR), { notes: opts.notes });
    const { listings, problems: lp } = opts.listing ? readListings(join(ROOT, PLAY_DIR)) : { listings: [], problems: [] };
    const problems = [...np, ...lp];
    if (problems.length) die(`fix these first:\n  ${problems.join("\n  ")}`);
    if (opts.yes && opts.build) assertCleanTree();

    await withEdit(async (play, edit) => {
      const tracks = await play.tracks(edit);
      const code = opts.versionCode ?? nextVersionCode(tracks, gradleDefaultCode());
      const name = `${VERSION} (${code})`;
      log(`app ${PKG} → track ${opts.track}: ${name}${opts.draft ? " as a DRAFT" : opts.fraction != null ? ` to ${opts.fraction * 100}%` : " to everyone on it"}`);
      log(`release notes: ${notes.length ? notes.map((n) => n.language).join(", ") : "none"}`);
      if (opts.listing) log(`listing: ${listings.map((l) => l.locale).join(", ") || "nothing under " + PLAY_DIR + "/listings"}`);
      if (!opts.yes) {
        log(opts.aab ? `would upload ${opts.aab}` : opts.build ? `would build the AAB with versionCode ${code}, versionName ${VERSION}` : `would upload ${AAB_PATH}`);
        return;
      }
      const aab = opts.aab ? resolve(opts.aab) : opts.build ? buildAab(code) : join(ROOT, AAB_PATH);
      if (!existsSync(aab)) die(`no AAB at ${aab}`);
      log(`uploading ${relative(ROOT, aab)} …`);
      const up = await play.uploadBundle(edit, aab);
      log(`uploaded versionCode ${up.versionCode} (sha256 ${up.sha256})`);
      const release = releaseFor({ versionCodes: [up.versionCode], name: `${VERSION} (${up.versionCode})`, notes, fraction: opts.fraction, draft: opts.draft });
      await play.setTrack(edit, opts.track, [release]);
      log(`${opts.track}: ${describe(release)}`);
      if (opts.listing) await pushListings(play, edit, listings);
    });
  },

  async promote() {
    await withEdit(async (play, edit) => {
      const src = latestRelease(await play.track(edit, opts.from));
      if (!src) die(`${opts.from} has no release to promote`);
      const release = releaseFor({
        versionCodes: src.versionCodes, name: src.name, notes: src.releaseNotes ?? [], fraction: opts.fraction, draft: opts.draft,
      });
      log(`${opts.from} → ${opts.to}: ${describe(release)}`);
      if (opts.yes) await play.setTrack(edit, opts.to, [release]);
    });
  },

  async rollout() {
    await withEdit(async (play, edit) => {
      const t = await play.track(edit, opts.track);
      const cur = (t.releases ?? []).find((r) => r.status === "inProgress" || r.status === "halted");
      if (!cur) die(`${opts.track} has no staged rollout to change (only ${(t.releases ?? []).map(describe).join("; ") || "nothing"})`);
      const next = releaseFor({ versionCodes: cur.versionCodes, name: cur.name, notes: cur.releaseNotes ?? [], fraction: opts.fraction });
      log(`${opts.track}: ${describe(cur)}  →  ${describe(next)}`);
      if (opts.yes) await play.setTrack(edit, opts.track, [next]);
    });
  },

  async listing() {
    const { listings, problems } = readListings(join(ROOT, PLAY_DIR));
    if (problems.length) die(`fix these first:\n  ${problems.join("\n  ")}`);
    if (!listings.length) die(`nothing under ${PLAY_DIR}/listings`);
    await withEdit(async (play, edit) => {
      if (!opts.yes) {
        for (const l of listings) log(`${l.locale}: ${l.text ? "text" : "no text"}; ${Object.entries(l.images).map(([k, v]) => `${k} ×${v.length}`).join(", ") || "no images"}`);
        return;
      }
      await pushListings(play, edit, listings);
    });
  },

  async keygen() {
    const props = join(APP, "android/keystore-play.properties");
    const store = join(dirname(defaultServiceAccountPath(SLUG)), "play-upload.jks");
    if (existsSync(props)) die(`${relative(ROOT, props)} already exists; refusing to replace an upload key.`);
    if (existsSync(store)) die(`${store} already exists; point keystore-play.properties at it instead of making another.`);
    const pass = randomBytes(24).toString("base64url");
    mkdirSync(dirname(store), { recursive: true, mode: 0o700 });
    run("keytool", ["-genkeypair", "-v", "-keystore", store, "-storetype", "PKCS12", "-alias", "upload", "-keyalg", "RSA",
      "-keysize", "4096", "-validity", "10000", "-storepass", pass, "-keypass", pass, "-dname", `CN=${BRAND.name} upload`], ROOT);
    chmodSync(store, 0o600);
    writeFileSync(props, `storeFile=${store}\nstorePassword=${pass}\nkeyAlias=upload\nkeyPassword=${pass}\n`, { mode: 0o600, flag: "wx" });
    log(`\nupload key -> ${store} (0600); password in ${relative(ROOT, props)} (gitignored, 0600).`);
    log("Back BOTH up offline (password manager). Lost upload key = a reset request to Play support, not the end of the app:");
    log("Play App Signing holds the real signing key; this one only proves uploads are yours.");
  },
};

async function pushListings(play, edit, listings) {
  for (const l of listings) {
    if (l.text) { await play.setListing(edit, l.locale, l.text); log(`${l.locale}: listing text`); }
    for (const [type, files] of Object.entries(l.images)) {
      await play.clearImages(edit, l.locale, type);
      for (const f of files) await play.uploadImage(edit, l.locale, type, f);
      log(`${l.locale}: ${type} ×${files.length}`);
    }
  }
}

await commands[opts.cmd]();
