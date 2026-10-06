/**
 * Serve the built web bundle as a *downloadable* thing, not just as pages.
 *
 * Why this exists: the Android shell (`packages/app`) carries the UI inside the
 * APK, which is the entire point — a dead tunnel can no longer take the app
 * away. The cost is that the UI is then frozen at APK build time, so every web
 * change would need a new APK pushed to the phone. That is the wrong trade: the
 * shell is what must be local, not the *version* of it.
 *
 * So the daemon publishes what it is serving — a build id plus a per-file
 * manifest — and the shell downloads the difference into its own storage and
 * points its WebView at it (Capacitor's `WebView.setServerBasePath`, which the
 * bridge restores on boot and resets by itself when a new APK is installed). The
 * APK's built-in copy stays as the floor that always works offline.
 *
 * Three properties this file is responsible for:
 *
 *  - **The id is content-derived** (`dist/build-id.txt`, written by the web
 *    build's `buildStamp` plugin). `npm run restart` rebuilds constantly, and an
 *    id that changed per build would have the phone re-downloading ~900 KB over
 *    a roaming link to arrive at a byte-identical bundle.
 *  - **Per-file `sha256`**, so the client can verify each piece before it
 *    replaces a working app. This guards against a truncated transfer on a bad
 *    link — it is NOT a defence against a hostile host, which is already able to
 *    run arbitrary code on your machine (see SECURITY.md); the bundle is only
 *    ever fetched from the host the user paired with.
 *  - **Degrade, never break.** No `dist`, no `build-id.txt`, or a bundle past the
 *    caps ⇒ `ok: false` with a reason, and the shell simply says updating is
 *    unavailable and keeps running what it has.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { BRAND } from "@waterplane/shared";

/** Why a dist with no `build-id.txt` is refused, and what to do in either kind
 *  of install: a checkout builds it; a release tarball ships it, so one without
 *  it is a damaged install. */
export const NO_BUILD_ID_REASON =
  "web build has no build-id.txt — in a git checkout, rebuild with `npm run build`; " +
  `in a release install it ships with the release, so reinstall it (or \`${BRAND.slug} update\`)`;

/**
 * Where the built PWA lives. Exported because `main.ts` serves static files from
 * the same directory — one definition, so the manifest can never describe a
 * different tree than the one being served.
 */
export const WEB_DIST = resolve(import.meta.dirname, "../../web/dist");

/** Bundle files are the app itself: a few hundred KB across a handful of files. */
const MAX_FILES = 500;
const MAX_TOTAL = 64 * 1024 * 1024;

export interface BundleFile {
  /** Posix-style path relative to the bundle root, e.g. `assets/index-abc.js`. */
  path: string;
  size: number;
  sha256: string;
}

export interface BundleManifest {
  ok: boolean;
  /** Content hash of the build, or null when it could not be determined. */
  buildId: string | null;
  files: BundleFile[];
  /** Sum of `size`, so the client can show "12.3 MB to download" before starting. */
  total: number;
  /** Present when `ok` is false — safe to show to the user. */
  reason?: string;
}

/** Cheap fingerprint of the tree (paths + sizes + mtimes), to skip re-hashing. */
let cacheKey = "";
let cached: BundleManifest | null = null;

/**
 * The manifest for the bundle currently on disk.
 *
 * Hashes are cached against a paths+sizes+mtimes fingerprint: the phone polls
 * this, and re-reading ~1 MB per poll to produce a value that changes a few
 * times a day is waste. A rebuild moves an mtime, so the cache cannot go stale.
 */
export function webBundleManifest(): BundleManifest {
  let files: string[];
  try {
    files = walk(WEB_DIST).sort();
  } catch {
    return { ok: false, buildId: null, files: [], total: 0, reason: "no web build on the host" };
  }
  if (!files.length) {
    return { ok: false, buildId: null, files: [], total: 0, reason: "no web build on the host" };
  }
  if (files.length > MAX_FILES) {
    return { ok: false, buildId: null, files: [], total: 0, reason: `bundle has ${files.length} files (max ${MAX_FILES})` };
  }

  const stats = files.map((f) => {
    const s = statSync(f);
    return { abs: f, rel: rel(f), size: s.size, mtimeMs: s.mtimeMs };
  });
  const total = stats.reduce((n, s) => n + s.size, 0);
  if (total > MAX_TOTAL) {
    return { ok: false, buildId: null, files: [], total, reason: `bundle is ${Math.round(total / 1e6)} MB (max ${Math.round(MAX_TOTAL / 1e6)} MB)` };
  }

  const key = stats.map((s) => `${s.rel}:${s.size}:${Math.floor(s.mtimeMs)}`).join("|");
  if (key === cacheKey && cached) return cached;

  let buildId: string | null = null;
  try {
    buildId = readFileSync(join(WEB_DIST, "build-id.txt"), "utf8").trim() || null;
  } catch {
    buildId = null;
  }
  if (!buildId) {
    // An old or hand-made dist. Refusing is better than inventing an id: the
    // client keys "do I already have this?" on it, and a made-up one would
    // either re-download forever or, worse, look unchanged when it wasn't.
    const out: BundleManifest = { ok: false, buildId: null, files: [], total, reason: NO_BUILD_ID_REASON };
    cacheKey = key;
    cached = out;
    return out;
  }

  const out: BundleManifest = {
    ok: true,
    buildId,
    total,
    files: stats.map((s) => ({
      path: s.rel,
      size: s.size,
      sha256: createHash("sha256").update(readFileSync(s.abs)).digest("hex"),
    })),
  };
  cacheKey = key;
  cached = out;
  return out;
}

/**
 * Resolve one bundle-relative path to a real file, or null.
 *
 * The path comes from the phone, so it is contained the same way every other
 * file route in this daemon is: resolved, then required to still be inside the
 * bundle root. A `..` that climbs out lands outside `WEB_DIST` and is refused
 * even though it would resolve to a perfectly real file.
 */
export function webBundleFile(relPath: string): { abs: string; size: number; mtimeMs: number } | null {
  const raw = (relPath || "").trim();
  if (!raw || raw.startsWith("/") || raw.includes("\0")) return null;
  const abs = resolve(WEB_DIST, raw);
  if (abs !== WEB_DIST && !abs.startsWith(WEB_DIST + sep)) return null;
  try {
    const s = statSync(abs);
    if (!s.isFile()) return null;
    return { abs, size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

function rel(abs: string): string {
  return relative(WEB_DIST, abs).split(sep).join("/");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    // Never follow a symlink out of the bundle: `isDirectory()`/`isFile()` on a
    // Dirent describe the link itself, so a symlink is simply skipped.
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
