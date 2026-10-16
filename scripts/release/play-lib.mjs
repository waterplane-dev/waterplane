// Google Play publishing, the pure parts: service-account auth, the next versionCode, the store
// listing read from files, the release a track gets, and the request plan. No network and no
// gradle here — play.mjs does the IO. No dependency either: the Android Publisher API is a handful
// of REST calls, and a service-account token is one RS256 JWT, which node:crypto signs.
import { createSign } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";

export const API = "https://androidpublisher.googleapis.com/androidpublisher/v3";
export const UPLOAD_API = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SCOPE = "https://www.googleapis.com/auth/androidpublisher";

export const TRACKS = ["internal", "alpha", "beta", "production"];
/** Play's own limits; a longer text is refused by the API at commit, after the upload. */
export const LIMITS = { title: 30, shortDescription: 80, fullDescription: 4000, releaseNotes: 500 };

/** Where the service-account key lives unless `<ENV_PREFIX>PLAY_SA` names it: next to the release
 *  signing key, never in the repo. */
export const defaultServiceAccountPath = (slug) => join(homedir(), ".config", `${slug}-release`, "play-service-account.json");

/** The store listing and release notes, as files (Play's own field names, one dir per locale). */
export const PLAY_DIR = "packages/app/play";
export const AAB_PATH = "packages/app/android/app/build/outputs/bundle/playRelease/app-play-release.aab";

/** The fields of a Google service-account key file this needs, or a thrown reason. */
export function parseServiceAccount(text) {
  let j;
  try { j = JSON.parse(text); } catch { throw new Error("the service-account key is not JSON"); }
  if (j.type !== "service_account") throw new Error(`the key's type is ${JSON.stringify(j.type)}, not "service_account" — download a JSON key for a service account`);
  for (const k of ["client_email", "private_key"]) if (!j[k]) throw new Error(`the service-account key has no ${k}`);
  return { email: j.client_email, privateKey: j.private_key, tokenUri: j.token_uri || TOKEN_URL };
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** The signed JWT a service account trades for an access token (RFC 7523). `now` in seconds. */
export function serviceAccountAssertion({ email, privateKey, tokenUri }, now = Math.floor(Date.now() / 1000)) {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iss: email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

/** Every versionCode any track's release holds. */
export function versionCodesIn(tracks) {
  const out = [];
  for (const t of tracks ?? []) for (const r of t.releases ?? []) for (const v of r.versionCodes ?? []) out.push(Number(v));
  return out.filter(Number.isFinite);
}

/** The versionCode the next upload gets: one past the highest Play has seen on any track, and never
 *  below `floor` (the code in build.gradle, so the first API upload follows the manual one).
 *  A versionCode is spent by an upload even when its release is later dropped, so a code Play
 *  refuses as used means "pass --version-code", not "guess again". */
export function nextVersionCode(tracks, floor = 1) {
  return Math.max(floor, ...versionCodesIn(tracks).map((v) => v + 1));
}

const readText = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim() : null);

/**
 * The listing per locale from `<dir>/listings/<locale>/{title,short-description,full-description}.txt`,
 * and the images from `<dir>/listings/<locale>/<imageType>/*.png|jpg` (Play's imageType names:
 * icon, featureGraphic, phoneScreenshots, sevenInchScreenshots, tenInchScreenshots). A locale with
 * no text files contributes images only. Problems come back as sentences, never as a truncation.
 */
export function readListings(dir) {
  const root = join(dir, "listings");
  const listings = [], problems = [];
  if (!existsSync(root)) return { listings, problems };
  for (const locale of readdirSync(root).sort()) {
    const ld = join(root, locale);
    if (!statSync(ld).isDirectory()) continue;
    const text = {
      title: readText(join(ld, "title.txt")),
      shortDescription: readText(join(ld, "short-description.txt")),
      fullDescription: readText(join(ld, "full-description.txt")),
    };
    for (const [k, v] of Object.entries(text)) {
      if (v != null && v.length > LIMITS[k]) problems.push(`${locale}: ${k} is ${v.length} characters, Play allows ${LIMITS[k]}`);
    }
    const hasText = Object.values(text).some((v) => v != null);
    if (hasText && Object.values(text).some((v) => v == null)) {
      problems.push(`${locale}: a listing needs all three of title.txt, short-description.txt and full-description.txt`);
    }
    const images = {};
    for (const type of ["icon", "featureGraphic", "phoneScreenshots", "sevenInchScreenshots", "tenInchScreenshots"]) {
      const id = join(ld, type);
      if (!existsSync(id)) continue;
      const files = readdirSync(id).filter((f) => [".png", ".jpg", ".jpeg"].includes(extname(f).toLowerCase())).sort();
      if (files.length) images[type] = files.map((f) => join(id, f));
    }
    listings.push({ locale, text: hasText ? text : null, images });
  }
  return { listings, problems };
}

/** Release notes per locale from `<dir>/release-notes/<locale>.txt`, or the one `--notes` text as
 *  en-US. An over-long note is a problem, never cut. */
export function readReleaseNotes(dir, { notes = null } = {}) {
  const problems = [];
  let out = [];
  if (notes != null) out = [{ language: "en-US", text: notes.trim() }];
  else {
    const nd = join(dir, "release-notes");
    if (existsSync(nd)) {
      for (const f of readdirSync(nd).sort()) {
        if (extname(f) !== ".txt") continue;
        const text = readFileSync(join(nd, f), "utf8").trim();
        if (text) out.push({ language: f.slice(0, -4), text });
      }
    }
  }
  for (const n of out) {
    if (n.text.length > LIMITS.releaseNotes) problems.push(`release notes ${n.language}: ${n.text.length} characters, Play allows ${LIMITS.releaseNotes}`);
  }
  return { notes: out, problems };
}

/**
 * The release a track gets. `fraction` in (0, 1) is a staged rollout ("inProgress"); absent or 1 is
 * everyone ("completed"). `draft` is what Play demands while the app has never been published.
 */
export function releaseFor({ versionCodes, name = null, notes = [], fraction = null, draft = false }) {
  const r = { versionCodes: versionCodes.map(String) };
  if (name) r.name = name;
  if (notes.length) r.releaseNotes = notes;
  if (draft) r.status = "draft";
  else if (fraction != null && fraction < 1) { r.status = "inProgress"; r.userFraction = fraction; }
  else r.status = "completed";
  return r;
}

/** The newest release on a track (highest versionCode), or null. */
export function latestRelease(track) {
  let best = null, bestCode = -1;
  for (const r of track?.releases ?? []) {
    const top = Math.max(-1, ...(r.versionCodes ?? []).map(Number));
    if (top > bestCode) { best = r; bestCode = top; }
  }
  return best;
}

/** A sentence for the error Play answers with, when the cause is a known one-time setup step. */
export function explainApiError(status, message) {
  const m = String(message ?? "");
  if (/Package not found/i.test(m)) {
    return "Play does not know this package yet. Create the app in Play Console and upload the FIRST bundle by hand (internal testing) — `npm run release:play -- build` makes it. Every later upload goes through this script.";
  }
  if (/draft app/i.test(m)) return "The app has never been published, so Play accepts only draft releases. Re-run with --draft, then roll the draft out in Play Console once (or after review).";
  if (/changesNotSentForReview/i.test(m)) return "Play wants this edit committed without sending it for review (managed publishing / rejected update). Re-run with --no-send-for-review, then send it for review in Play Console.";
  if (/version code .* already been used|APK specifies a version code that has already been used/i.test(m)) {
    return "That versionCode is spent (an earlier upload used it, even if its release was dropped). Re-run with --version-code <higher>.";
  }
  if (status === 401 || status === 403) {
    return "The service account is not allowed. In Play Console → Users and permissions, invite its e-mail with 'Release apps to testing tracks' and 'Release to production' for this app, and make sure the Google Play Android Developer API is enabled in its Cloud project.";
  }
  return null;
}

/** Parse `play.mjs` arguments. */
export function parseArgs(argv) {
  const o = {
    cmd: "upload", yes: false, track: "internal", fraction: null, draft: false, build: true, aab: null,
    notes: null, versionCode: null, listing: false, from: null, to: null, sendForReview: true, allowDirty: false,
  };
  const cmds = ["upload", "build", "status", "promote", "rollout", "listing", "keygen"];
  let i = 0;
  if (argv[0] && !argv[0].startsWith("-")) {
    if (!cmds.includes(argv[0])) throw new Error(`unknown command ${argv[0]} (one of ${cmds.join(", ")})`);
    o.cmd = argv[0]; i = 1;
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const val = () => {
      if (inline !== undefined) return inline;
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    const track = (v) => { if (!TRACKS.includes(v)) throw new Error(`${flag}: ${v} is not a track (${TRACKS.join(", ")})`); return v; };
    switch (flag) {
      case "--yes": o.yes = true; break;
      case "--track": o.track = track(val()); break;
      case "--from": o.from = track(val()); break;
      case "--to": o.to = track(val()); break;
      case "--rollout": {
        const raw = val(), f = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
        if (!(f > 0 && f <= 1)) throw new Error(`--rollout ${raw}: a fraction in (0, 1] or a percentage like 10%`);
        o.fraction = f; break;
      }
      case "--draft": o.draft = true; break;
      case "--no-build": o.build = false; break;
      case "--aab": o.aab = val(); o.build = false; break;
      case "--notes": o.notes = val(); break;
      case "--version-code": {
        const n = Number(val());
        if (!Number.isInteger(n) || n < 1) throw new Error("--version-code needs a positive integer");
        o.versionCode = n; break;
      }
      case "--listing": o.listing = true; break;
      case "--no-send-for-review": o.sendForReview = false; break;
      case "--allow-dirty": o.allowDirty = true; break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  if (o.cmd === "promote") {
    o.from ??= "internal";
    if (!o.to) throw new Error("promote needs --to <track>");
    if (o.from === o.to) throw new Error("promote: --from and --to are the same track");
  }
  if (o.cmd === "rollout" && o.fraction == null) throw new Error("rollout needs --rollout <fraction|percent> (1 or 100% completes it)");
  if (o.draft && o.fraction != null) throw new Error("--draft and --rollout do not mix: a draft reaches nobody");
  return o;
}
