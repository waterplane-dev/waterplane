import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
// The BUILT shared package (shared builds first — already the rule): the
// product's names come from `shared/src/brand.ts` and nowhere else.
import { BRAND, BRAND_MIGRATED_KEY, LEGACY, legacyEnvText, logTag, resolveEnv } from "@waterplane/shared";

// In dev, proxy API + WS to the host daemon so the phone hits one origin.
const hostTarget = resolveEnv(process.env, "HOST_TARGET");
if (hostTarget.legacy) console.warn(legacyEnvText(hostTarget.name, "HOST_TARGET"));
const HOST_TARGET = hostTarget.value || "http://127.0.0.1:8770";

/**
 * The placeholders the files that cannot import `brand.ts` carry —
 * `public/sw.js`, `public/manifest.webmanifest` and `index.html` — and what
 * each becomes. A name spelled in one of those files is a name the next rename
 * misses; a placeholder is filled from the one table.
 *
 * `__BRAND_LS_PREFIXES__` / `__BRAND_LS_MARK__` are JS expressions for the
 * inline theme script (current prefix first, then every legacy one, and the
 * key that says the legacy ones have been copied).
 */
const BRAND_STAMPS: [string, string][] = [
  ["__BRAND_NAME__", BRAND.displayName],
  ["__BRAND_SLUG__", BRAND.slug],
  ["__BRAND_LEGACY_SLUGS__", LEGACY.map((l) => l.slug).join(",")],
  ["__BRAND_LS_PREFIXES__", JSON.stringify([BRAND.storagePrefix, ...LEGACY.map((l) => l.storagePrefix)])],
  ["__BRAND_LS_MARK__", JSON.stringify(BRAND_MIGRATED_KEY)],
];
function stampBrandText(text: string): string {
  for (const [from, to] of BRAND_STAMPS) text = text.split(from).join(to);
  return text;
}
/** Files under `public/` that carry placeholders. */
const STAMPED_PUBLIC = ["sw.js", "manifest.webmanifest"];

/**
 * Fill the brand placeholders: `index.html` through Vite's own hook (dev and
 * build alike), the `public/` files in `dist` before the build is hashed (so a
 * rename changes the build id), and the same files on the dev server through
 * a tiny middleware, so a dev phone installs a manifest with a real name.
 */
function stampBrand(): Plugin {
  return {
    name: "brand-stamp",
    transformIndexHtml(html) { return stampBrandText(html); },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url || "").split("?")[0].replace(/^\//, "");
        if (!STAMPED_PUBLIC.includes(path)) { next(); return; }
        try {
          const body = stampBrandText(readFileSync(join(import.meta.dirname, "public", path), "utf8"));
          res.setHeader("content-type", path.endsWith(".js") ? "text/javascript" : "application/manifest+json");
          res.end(body);
        } catch { next(); }
      });
    },
  };
}

/**
 * Give the built bundle an identity, and stamp it into the service worker.
 *
 * Two consumers:
 *
 *  - The **PWA service worker** versions its shell cache by it, so a new build
 *    means a new cache name and the old one is purged on activate — the phone
 *    updates with no manual cache-clear.
 *  - The **Android shell** (`packages/app`) compares the id it is running
 *    against the one the daemon is serving, and downloads the difference. That
 *    is what lets a web change reach the phone without building a new APK.
 *
 * The id is a CONTENT HASH, not a timestamp or a random string, and that matters
 * for the second consumer: `npm run restart` rebuilds constantly, and an id that
 * changed on every build would have the phone re-downloading ~900 KB over a
 * roaming link to arrive at a byte-identical bundle. Identical sources now
 * produce an identical id and no download at all.
 *
 * Non-circular by construction: the hash is taken over every emitted file with
 * `sw.js` in its UNSTAMPED form, and only then is `sw.js` stamped with the
 * result and `build-id.txt` written. Hashing the stamped worker would be hashing
 * the hash.
 *
 * `build-id.txt` ships INSIDE the bundle on purpose — it is how a running app
 * learns which build it is, whether that bundle came out of the APK or out of a
 * download, with no bookkeeping to get out of step.
 */
function buildStamp(): Plugin {
  // Read BEFORE `closeBundle` — Vite empties `outDir` at the start of the
  // build, so the previous id has to be captured while it still exists.
  let previousId: string | null = null;
  // The build's real outDir: a scratch `--outDir` check is stamped (and read) there, never in dist/.
  let outDir = join(import.meta.dirname, "dist");
  return {
    name: "build-stamp",
    apply: "build",
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    buildStart() {
      try {
        previousId = readFileSync(join(outDir, "build-id.txt"), "utf8").trim() || null;
      } catch {
        previousId = null;
      }
    },
    closeBundle() {
      const dist = outDir;
      try {
        // Brand first, so the hash covers the stamped names.
        for (const f of STAMPED_PUBLIC) {
          try {
            const p = join(dist, f);
            writeFileSync(p, stampBrandText(readFileSync(p, "utf8")));
          } catch { /* not emitted in this build */ }
        }
        const files = walk(dist).sort();
        const h = createHash("sha256");
        for (const f of files) {
          h.update(f.slice(dist.length + 1));
          h.update(readFileSync(f));
        }
        const build = h.digest("hex").slice(0, 16);
        const swPath = join(dist, "sw.js");
        try {
          writeFileSync(swPath, readFileSync(swPath, "utf8")
            .replace(/__SW_BUILD__/g, build)
            .replace('"__DEMO_PRECACHE__"', JSON.stringify(demoPrecache(dist))));
        } catch {
          // No SW emitted (e.g. a non-default build) — nothing to stamp.
        }
        writeFileSync(join(dist, "build-id.txt"), build);
        // The one line this build's console output can answer "will a phone
        // update?" with, without anyone reading a hex string by hand — the
        // Build sheet's run report is otherwise silent about the id entirely.
        console.log(build === previousId
          ? `${logTag} web bundle ${build} — unchanged, no OTA update to serve`
          : `${logTag} web bundle ${build}${previousId ? ` (was ${previousId})` : ""} — phones will update`);
      } catch {
        // No dist (or an unreadable one) — the app falls back to "unknown build"
        // and the updater simply reports that OTA is unavailable.
      }
    },
  };
}

/**
 * The demo's bundled media as URL paths (`/demo/media/r1/…`), for the service
 * worker to precache at install: the demo runs with the network gone and its
 * gallery images are raw `<img src>`s nothing else would have fetched yet.
 * Sorted, so identical sources stamp an identical worker.
 */
function demoPrecache(dist: string): string[] {
  const root = join(dist, "demo");
  try {
    return walk(root).map((f) => "/demo/" + f.slice(root.length + 1).split(/[\\/]/).map(encodeURIComponent).join("/")).sort();
  } catch {
    return []; // no public/demo in this build
  }
}

/** Every file under `dir`, recursively, as absolute paths. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/**
 * Build stamp surfaced in the UI (Gallery footer) so we can confirm at a glance
 * which bundle a device actually loaded.
 *
 * A hash of the SOURCES rather than a timestamp, and that is load-bearing rather
 * than cosmetic: this value is baked into the emitted JS, so a timestamp would
 * change the bundle's bytes on every build — which would change `build-id.txt`
 * (see `buildStamp`), which would have the Android shell re-download the whole
 * bundle after a `npm run restart` that changed nothing at all. Hashing the
 * inputs instead means identical sources produce an identical output, and the
 * phone downloads only when something actually changed.
 *
 * Non-circular: these are the files that go IN, never the ones that come out.
 */
function sourceHash(): string {
  const h = createHash("sha256");
  const roots = [
    join(import.meta.dirname, "src"),
    join(import.meta.dirname, "public"),
    join(import.meta.dirname, "..", "shared", "dist"),
  ];
  // An extension's web half (and what it shares with its host half) is bundle source too: without
  // it an extension edit would not change BUILD_ID and the APK shell would never re-download.
  try {
    const ext = join(import.meta.dirname, "..", "extensions");
    for (const f of walk(ext).sort()) {
      if (!/[\\/](web|shared)[\\/]/.test(f.slice(ext.length))) continue;
      h.update(f.slice(ext.length));
      try { h.update(readFileSync(f)); } catch { /* vanished mid-build */ }
    }
  } catch { /* no extensions folder */ }
  for (const root of roots) {
    let files: string[] = [];
    try { files = walk(root).sort(); } catch { continue; }
    for (const f of files) {
      h.update(f.slice(root.length + 1));
      try { h.update(readFileSync(f)); } catch { /* vanished mid-build */ }
    }
  }
  for (const f of ["index.html", "package.json"]) {
    try { h.update(readFileSync(join(import.meta.dirname, f))); } catch { /* optional */ }
  }
  return h.digest("hex").slice(0, 8);
}

const BUILD_ID = sourceHash();

/**
 * Split the bundle along its UPDATE boundaries, not just for load time.
 *
 * The daemon publishes a per-file `sha256` manifest and the Android shell
 * downloads only the files that changed (`host/src/webbundle.ts`). With the app
 * emitted as one ~1 MB chunk that mechanism could never fire: a one-line UI
 * change rewrote the single file every manifest entry pointed at, so the phone
 * re-downloaded the whole megabyte over the roaming link this app spends its
 * life apologising for — to arrive at a bundle whose dependencies had not moved
 * in months.
 *
 * The vendor code is the half that does not change: react, xterm and the icon
 * set together are most of the weight and turn over on a `npm update`, not on a
 * commit. Giving each a stable chunk means an ordinary UI edit ships only the
 * app chunk, and the content-hashed vendor files stay valid in the shell's
 * store, the service worker's cache, and the browser's.
 *
 * Split by SOURCE rather than by route: lazy-loading sheets would change when
 * they load (they are opened from a phone on a link that may be gone), and the
 * app's own offline story wants them present. This changes only how they are
 * PACKAGED.
 */
// Every name vendorChunk returns, highest claim first (see `codeSplitting` below).
const CHUNK_ORDER = ["react", "xterm", "icons", "vendor", "shared", "demo", "sheets"];

function vendorChunk(id: string): string | undefined {
  // The demo (demo-mode-plan.md §4): the fake desktop, its transport and the
  // scenarios. Its own chunk, statically imported like everything else — it
  // changes apart from the app and must never be lazy, because the demo has to
  // run with the network gone. `public/demo/**` (its media) is precached by the
  // service worker, see `demoPrecache`.
  if (/[\\/]src[\\/]demo[\\/]/.test(id)) return "demo";
  // `@waterplane/shared` (wire types + pure logic, ~150 KB minified, 48 KB of it the
  // hint catalogue) is imported by the app AND the demo. Unassigned, rollup
  // parked it inside whichever chunk reached it first — the `demo` chunk — so
  // the demo chunk was half shared code, the app imported the demo's file for
  // it, and the build warned "sheets -> demo -> sheets". Its own chunk makes
  // `demo` the demo alone and gives the shared half its own stable hash.
  if (/[\\/]packages[\\/]shared[\\/]/.test(id)) return "shared";
  if (id.includes("node_modules")) {
    if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
    if (id.includes("@xterm")) return "xterm";
    if (id.includes("lucide-react")) return "icons";
    return "vendor";
  }
  // Our own code splits the same way, for the same reason: the sheets are ~26
  // self-contained overlays that change independently of `App.tsx`, which is
  // the most-edited file in the repo. In one chunk every sheet edit re-shipped
  // App and every App edit re-shipped all 26 sheets. They stay statically
  // imported — nothing here defers a load, it only decides which file a module
  // is packaged in.
  if (/[\\/]src[\\/][A-Z][A-Za-z]*(Sheet|View|Menu|Swiper|Annotator|Setup|Update|Bar|Layer)\.tsx$/.test(id)) return "sheets";
  // A feature folder is a sheet and the state behind it, edited apart from App
  // for the same reason (docs/notes/web-architecture.md).
  if (/[\\/]src[\\/]features[\\/]/.test(id)) return "sheets";
  // …and so is an in-repo extension's web half.
  if (/[\\/]extensions[\\/][^\\/]+[\\/](web|shared)[\\/]/.test(id)) return "sheets";
  return undefined;
}

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  resolve: {
    alias: {
      "@waterplane/sdk": join(import.meta.dirname, "src", "sdk", "index.ts"),
      "@waterplane/kit": join(import.meta.dirname, "src", "kit", "index.ts"),
      // The logo master SVGs live at the repo root (brand/), inlined by core/Logo.tsx.
      "@brand": join(import.meta.dirname, "..", "..", "brand"),
    },
    dedupe: ["react", "react-dom"],
  },
  plugins: [react(), stampBrand(), buildStamp()],
  build: {
    // Rolldown (Vite 8) captures a group's dependencies with it: as one `manualChunks`
    // function the demo swallowed most of `shared` again. One group per chunk name, in
    // priority order, lets the libraries and `shared` claim their modules before `demo`
    // and `sheets` reach them.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: CHUNK_ORDER.map((name, i) => ({
            name,
            test: (id: string) => vendorChunk(id) === name,
            priority: CHUNK_ORDER.length - i,
          })),
        },
      },
    },
    // The sheets chunk is one big static chunk on purpose (see vendorChunk); Vite's
    // default 500 kB warning then fires on every build and reads like a fault to
    // someone installing for the first time. The limit sits just above today's size,
    // so real growth still warns.
    chunkSizeWarningLimit: 1600,
  },
  server: {
    host: true, // listen on all interfaces so the phone can reach the dev server
    proxy: {
      "/api": { target: HOST_TARGET, changeOrigin: true },
      "/ws": { target: HOST_TARGET, ws: true, changeOrigin: true },
    },
  },
});
