// Minimal service worker — just enough to make the app installable as a PWA.
// We intentionally do NOT cache API/WS or terminal data (always live); only
// the app shell is served cache-first (stale-while-revalidate) so first paint
// is instant instead of blocked on a network round-trip to the desktop (which,
// over Tailscale to a possibly-asleep host, could take seconds).
//
// Freshness comes from the build, NOT from network-first: SHELL is versioned per
// build (__SW_BUILD__ is replaced at build time, see vite.config.ts). A new build
// → a new cache name → old caches purged on activate → a new SW that, on taking
// control, reloads the page (see main.tsx). So within one build generation the
// cached index.html and the hashed assets it references are always a consistent
// set — serving them from cache can't point at purged assets. The phone updates
// with no manual cache-clear.
//
// The product's names are stamped too (vite.config.ts `stampBrand`, from
// shared/brand.ts): this file cannot import, and a name spelled here is a name
// the next rename misses. Unstamped (a dev server serving public/ raw) they
// are still valid strings.
const BRAND_SLUG = "__BRAND_SLUG__";
const BRAND_NAME = "__BRAND_NAME__";
/** Every older brand's slug, newest first — only so its pulls cache survives
 *  the purge until the page has copied it (web/src/boot/brandMigrate.ts). */
const LEGACY_SLUGS = "__BRAND_LEGACY_SLUGS__".split(",").filter(Boolean);
const SHELL = `${BRAND_SLUG}-shell-__SW_BUILD__`;

// Image thumbnails, cached across builds. The name is deliberately NOT
// build-hashed: a deploy changes the app bundle, not the pictures, and wiping
// hundreds of already-downloaded thumbnails every time the UI ships would undo
// the entire point of the thumbnail scheme (host thumbs.ts) on a roaming link.
// A versioned URL — `&v=<mtime>` (media.ts `sized()`) — is safe to serve
// cache-first: a regenerated file at the same path is a DIFFERENT URL. The
// un-versioned ones (a path mentioned in a transcript, whose mtime nothing
// knows) live in here too, but are only ever served when the network could not
// answer at all — see `thumbNetworkFirst`.
const THUMBS = `${BRAND_SLUG}-thumbs-v1`;

/**
 * Where a finished Background Fetch is parked for the app to collect.
 *
 * Auto-download's whole point is that the transfer outlives the page, so the
 * bytes have to land somewhere the page isn't needed for. Cache Storage rather
 * than IndexedDB deliberately: a worker opening the app's DB *by version* can
 * collide with a page still holding the previous one, and opening it
 * *versionless* would find no `pulls` store on a client that hasn't upgraded —
 * either way the download would be lost at the last step. A cache needs no
 * schema. The app moves each entry into IndexedDB and deletes it (web/pull.ts
 * `importFromCache`); anything it hasn't collected yet simply waits.
 *
 * Never purged in `activate` (see below): these are megabytes someone waited for.
 */
const PULLS = `${BRAND_SLUG}-pulls-v1`;
/** The same cache under an older name: kept by the purge for the page to copy. */
const LEGACY_PULLS = LEGACY_SLUGS.map((s) => `${s}-pulls-v1`);

// An extension's downloaded assets (the OCR engine and its language data: megabytes,
// fetched once from the person's own host when the extension was switched ON).
// One Cache per extension, `wp-ext-<id>`, filled by the EXTENSION with authenticated
// fetches of `/api/plugin/<id>/asset/<file>` stored under `/ext-asset/<id>/<file>`
// (sdk/extAssets.ts names both; its test reads this file). Not build-scoped, so the
// activate purge spares the prefix: a UI deploy must not re-download 7 MB. Served
// CACHE-ONLY below — never the network, which has no such route.
const EXT_CACHE_PREFIX = "wp-ext-";
const EXT_ROUTE = /^\/ext-asset\/([a-z0-9][a-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;
/** Cap on cached thumbnails, evicted oldest-insertion-first (cache.keys() is
 *  insertion-ordered). ~400 × ~30 KB ≈ 12 MB, well inside a phone's quota. */
const THUMB_MAX = 400;
/** A "thumb" that comes back this big is the host serving the ORIGINAL: thumbs.ts
 *  returns null (⇒ original) whenever it has no converter, the type is
 *  unsupported, or the source is already tiny. Caching a multi-MB original under
 *  a thumbnail URL is exactly the bytes this cache exists to avoid. */
const THUMB_MAX_BYTES = 512 * 1024;
/** The two GET routes that serve repo files (api.ts artifactUrl / inboxUrl). */
const THUMB_ROUTE = /^\/api\/repos\/[^/]+\/(artifact$|inbox\/)/;

self.addEventListener("install", (e) => {
  self.skipWaiting();
  // Warm the shell so the very first cold start (and any offline load) paints
  // from cache with zero network wait. Best-effort — a miss just means the first
  // navigation falls through to the network like before.
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => c.add(new Request("/", { cache: "no-store" })).then(() => precacheDemo(c)))
      .catch(() => {}),
  );
});

// The demo's bundled media (`public/demo/**`), listed into this worker by the
// build (vite.config.ts `demoPrecache`). The demo makes no request off the
// device, so what its gallery shows must already be here. One failed file
// costs that picture, never the install.
const DEMO_PRECACHE = "__DEMO_PRECACHE__";
function precacheDemo(c) {
  const urls = Array.isArray(DEMO_PRECACHE) ? DEMO_PRECACHE : [];
  return Promise.all(urls.map((u) => c.add(u).catch(() => {})));
}

/** `/ext-asset/<id>/<file>` from Cache `wp-ext-<id>`, or 404. `caches.has` first:
 *  `caches.open` would CREATE an empty cache for an extension that never downloaded. */
async function extAsset(id, path) {
  const name = EXT_CACHE_PREFIX + id;
  const hit = (await caches.has(name)) ? await (await caches.open(name)).match(path, { ignoreSearch: true }) : undefined;
  return hit ?? new Response(`${id}: ${path.split("/").pop()} is not downloaded on this phone`, { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      // Drop every cache that isn't this build's — frees stale shells. THUMBS is
      // exempt BY NAME: it is not build-scoped, and a plain `n !== SHELL` filter
      // would silently wipe it on every single deploy.
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== SHELL && n !== THUMBS && n !== PULLS && !LEGACY_PULLS.includes(n) && !n.startsWith(EXT_CACHE_PREFIX)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

// Push: show the notification the host sent.
self.addEventListener("push", (event) => {
  let data = { title: BRAND_NAME, body: "", sessionId: undefined, plugin: undefined, tag: undefined, image: undefined, file: undefined, pull: undefined };
  try { data = { ...data, ...event.data.json() }; } catch { /* plain text */ }
  // Auto-download: a `pull` id means the host queued this file for the phone to
  // fetch on its own. Start it HERE, in the push handler, because that is the
  // one place that runs with the app closed — which is the normal state when an
  // agent finishes a build. Best-effort: no Background Fetch support (iOS, or a
  // non-secure context) just leaves the item queued for the in-page fallback.
  if (data.pull && data.file) event.waitUntil(startPull(data.pull, data.file).catch(() => {}));
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      // Same tag replaces the earlier one in place and stays quiet (no second buzz): one notification per scope.
      renotify: false,
      icon: "/assets/icon-192.png",
      badge: "/assets/icon-192.png",
      data: { sessionId: data.sessionId, plugin: data.plugin, image: data.image, file: data.file, item: notifItem(data) },
      requireInteraction: true,
    }),
  );
});

// The feed item a push stands for, for a tap with no session, file, image or
// plugin to open: the page's `openNotif` lands it (a health move opens its repo's
// chart; a failed push the git view ON that failure; anything else its own row in
// the feed). The host's payload IS the item plus `pull` (`server/clients.ts`), so it
// is forwarded WHOLE, as the APK does — a field picked by hand here once dropped
// `key` and `branch` (review A3c M2). Null on an older host's push.
function notifItem(d) {
  if (typeof d.id !== "string" || typeof d.kind !== "string") return null;
  const { pull: _pull, ...item } = d;
  return item;
}

// Tapping a notification focuses the app and asks it to open that session.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data?.sessionId;
  const image = event.notification.data?.image;
  const file = event.notification.data?.file;
  const plugin = event.notification.data?.plugin;
  const item = event.notification.data?.item;
  // An artifact notification used to navigate straight to `…&download=1`, which
  // is the browser's own download: no resume, no row in the app, and nothing at
  // all in the Android shell. It goes through the app's ONE download path now
  // (`web/download.ts`) like every other download button, which means it needs a
  // window — open one.
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        w.focus();
        if (file) w.postMessage({ type: "download-file", file });
        else if (image) w.postMessage({ type: "open-image", sessionId, image });
        else if (sessionId) w.postMessage({ type: "open-session", sessionId });
        else if (plugin) w.postMessage({ type: "open-plugin", plugin });
        else if (item) w.postMessage({ type: "open-notif", item });
        return;
      }
      // Cold start (no open window): encode the target in the hash so the app
      // restores it on boot — same scheme App.tsx parses for reload routing.
      const p = new URLSearchParams();
      if (sessionId) p.set("a", sessionId);
      if (plugin && !sessionId) p.set("plugin", plugin);
      if (item && !sessionId && !plugin && !image && !file) p.set("notif", JSON.stringify(item));
      if (image) { p.set("imgRepo", image.repoId); p.set("imgPath", image.relPath); }
      if (file) {
        p.set("dlRepo", file.repoId);
        p.set("dlPath", file.relPath);
        if (file.name) p.set("dlName", file.name);
        if (file.mtime) p.set("dlMtime", String(file.mtime));
      }
      const q = p.toString();
      return self.clients.openWindow(q ? `/#${q}` : "/");
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;

  // Image thumbnails are the ONE thing under /api worth caching, so this sits
  // before the /api bypass below. Every condition is load-bearing:
  //  - `thumb`: a thumbnail, not the original file.
  //  - no `download`: `download=1` must always reach the network — it is the
  //    "give me the real file" escape hatch and the host answers it with a
  //    Content-Disposition attachment, which has no business in an image cache.
  //  - `v` decides HOW, not WHETHER: the mtime-versioned variant is immutable
  //    (a changed file is a different URL) so it is served cache-first, while an
  //    un-versioned one can change under the same address and is therefore
  //    network-first — the stored copy answers only when the network can't.
  if (THUMB_ROUTE.test(url.pathname) && url.searchParams.has("thumb") && !url.searchParams.has("download")) {
    event.respondWith(url.searchParams.has("v") ? thumbFirst(event.request) : thumbNetworkFirst(event.request));
    return;
  }
  // An extension's own asset: cache-only (see EXT_CACHE_PREFIX). Absent ⇒ a plain 404,
  // never a fall-through to the shell (which would answer index.html as "the wasm").
  const ext = EXT_ROUTE.exec(url.pathname);
  if (ext) {
    event.respondWith(extAsset(ext[1], url.pathname));
    return;
  }
  // Never intercept the rest of the API, or the websocket upgrade.
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/ws")) return;

  // Stale-while-revalidate: serve from cache instantly (no network wait), then
  // refresh the cache in the background for next time. Navigations all key to "/"
  // (index.html) so query/hash variants share one entry. Freshness across builds
  // is handled by the SHELL cache name + the controllerchange reload (see the
  // header), so there's no need to pay a network RTT on every load here.
  const isNav = event.request.mode === "navigate";
  const key = isNav ? "/" : event.request;

  event.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const cached = await cache.match(key);
      const network = fetch(event.request)
        .then((res) => {
          if (res && res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => null);
      // Cached copy wins the race (instant); if there's none, wait on the network;
      // if that fails too (offline, cold), fall back to the cached shell — but
      // ONLY for a navigation. Answering a hashed /assets/*.js request with
      // index.html hands the browser HTML under a `text/html` type for a module
      // script: it never parses, nothing mounts, and the page is a black
      // rectangle for as long as the network stays down. A failed request is the
      // honest answer there.
      const res = cached || (await network);
      if (res) return res;
      if (!isNav) return Response.error();
      return (await cache.match("/")) || Response.error();
    }),
  );
});

/**
 * Network-first for an UN-versioned thumbnail — the picture that has no mtime
 * behind it.
 *
 * Not every screen that shows a repo file knows one: a path mentioned in a
 * transcript, or referenced by a backlog item, is just a path (the client learns
 * the mtime where it can — web/fileMtime.ts — but a first sight of a file, or a
 * device whose map has been evicted, has none). Those requests used to be
 * cached by nobody, which made them network-only, which made them BROKEN
 * offline while the identical picture painted in the gallery from its versioned
 * URL. Regularly and confusingly: the browser's own HTTP cache (max-age=86400)
 * covered it until the entry aged out or was evicted.
 *
 * Network-first is what keeps this honest. Online, the host's answer always
 * wins, so a file replaced at the same path can't be served from yesterday. The
 * stored copy is a fallback for exactly one situation — the network could not
 * answer at all — where a possibly-stale thumbnail is strictly better than a
 * broken image, and where the app is already labelling everything on screen as
 * last-known (Gallery's cached-listing note, the reader's offline status).
 */
async function thumbNetworkFirst(request) {
  const cache = await caches.open(THUMBS);
  try {
    const res = await fetch(request);
    if (res && res.ok) await putThumb(cache, request, res);
    if (res && res.ok) return res;
    // A 404 is an answer (the file is gone) — don't paper over it with a
    // stale copy, and don't cache it either.
    if (res) return res;
  } catch { /* offline / host asleep — fall through to whatever we hold */ }
  return (await cache.match(request)) || Response.error();
}

/** Store a thumbnail response, enforcing the two rules that keep this cache a
 *  thumbnail cache: it must BE an image, and it must be small (see
 *  THUMB_MAX_BYTES). Eviction is oldest-insertion-first — `cache.keys()` is
 *  insertion-ordered — which is cheap and bounded; a re-fetch of something
 *  evicted is one normal request. */
async function putThumb(cache, request, res) {
  const type = res.headers.get("content-type") || "";
  const len = Number(res.headers.get("content-length") || 0);
  if (!type.startsWith("image/") || !(len > 0) || len >= THUMB_MAX_BYTES) return;
  try {
    await cache.put(request, res.clone());
    const keys = await cache.keys();
    if (keys.length > THUMB_MAX) {
      await Promise.all(keys.slice(0, keys.length - THUMB_MAX).map((k) => cache.delete(k)));
    }
  } catch { /* quota / storage disabled — serving the response still works */ }
}

/** Cache-first for a versioned thumbnail: a re-opened gallery costs zero bytes,
 *  not even a revalidation round-trip, and an offline gallery still paints.
 *  A miss is stored only when the response is genuinely a small image — see
 *  THUMB_MAX_BYTES for why "it came back from a thumb URL" isn't good enough. */
async function thumbFirst(request) {
  const cache = await caches.open(THUMBS);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) await putThumb(cache, request, res);
  return res;
}

// ── Auto-download (Background Fetch) ──────────────────────────────────
//
// The browser owns these transfers: they continue with the app closed, show an
// OS progress notification, and survive connectivity changes without us writing
// a single retry. That is the capability that makes "start downloading the APK
// the moment it exists" work on a phone, and the reason no native wrapper is
// needed on Android. Where it doesn't exist (iOS/Safari), web/pull.ts falls back
// to a resumable Range loop that runs while the page is alive.

/** Artifact URL for a pull item. `download=1` makes the host send the real file
 *  (never a thumbnail) with a Content-Disposition attachment. */
function pullUrl(file) {
  return `/api/repos/${file.repoId}/artifact?path=${encodeURIComponent(file.relPath)}&download=1`;
}

/** Register one Background Fetch, unless it is already running. Registering the
 *  same id twice throws, and a duplicate would double the bytes. */
async function startPull(id, file) {
  if (!self.registration.backgroundFetch) return false;
  const existing = await self.registration.backgroundFetch.get(id);
  if (existing) return true;
  // Already collected? Don't re-fetch what is sitting in the handoff cache.
  const cache = await caches.open(PULLS);
  if (await cache.match(pullUrl(file))) return true;
  await self.registration.backgroundFetch.fetch(id, [pullUrl(file)], {
    title: file.name,
    downloadTotal: file.size || undefined,
    icons: [{ src: "/assets/icon-192.png", sizes: "192x192", type: "image/png" }],
  });
  return true;
}

/** Where a verdict is parked for a page that isn't running. Read and deleted by
 *  `drainBackgroundResults()` in web/src/pull.ts — the two halves agree by URL
 *  the same way the bytes agree by cache name. */
const PULL_RESULT_PREFIX = "/__pull-result/";

/**
 * Tell the app how a Background Fetch ended — and make that survive the app
 * being closed, which is the case this engine EXISTS for.
 *
 * postMessage reaches open windows only, so a failure while the phone was in a
 * pocket was reported to nobody: the record came back plain `queued` with no
 * attempt counted and no error to show, the item re-registered the same doomed
 * fetch on the next tick, and the sheet said "waiting to start" for ever with a
 * 403 in the host log as the only evidence anywhere. Cache Storage needs no
 * schema and is already where the bytes land, so the verdict goes there too.
 */
async function persistPullResult(id, ok, received, reason) {
  try {
    const cache = await caches.open(PULLS);
    await cache.put(
      new Request(PULL_RESULT_PREFIX + encodeURIComponent(id)),
      new Response(JSON.stringify({ id, ok: !!ok, received: received || 0, reason: reason || "" }),
        { headers: { "content-type": "application/json" } }),
    );
  } catch { /* best effort — a live page still gets the message below */ }
}

async function reportPull(id, ok, received, reason) {
  await persistPullResult(id, ok, received, reason);
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const w of wins) w.postMessage({ type: "pull-result", id, ok, received, reason });
}

self.addEventListener("backgroundfetchsuccess", (event) => {
  const bgf = event.registration;
  event.waitUntil((async () => {
    let received = 0;
    let name = "";
    try {
      const cache = await caches.open(PULLS);
      const records = await bgf.matchAll();
      for (const record of records) {
        // The artifact URL carries the repo-relative path; its basename is the
        // file name, which is what the finished notification should say (the
        // fetch id is a hash and means nothing to a human).
        const rel = new URL(record.request.url).searchParams.get("path") || "";
        name = rel.split("/").pop() || name;
        const res = await record.responseReady;
        // `responseReady` resolves even for a non-2xx, and caching an error page
        // under an artifact URL would land a 12-byte "not found" as the APK.
        if (!res || !res.ok) throw new Error(`http ${res ? res.status : "?"}`);
        await cache.put(record.request, res.clone());
        received = Number(res.headers.get("content-length") || 0) || bgf.downloaded || 0;
      }
      // Rewrite the OS notification from "Downloading …" to a finished state.
      // Best-effort: updateUI throws if it was already called for this fetch.
      try { await event.updateUI({ title: name ? `Downloaded ${name}` : "Download complete" }); } catch { /* already updated */ }
      await reportPull(bgf.id, true, received);
    } catch (e) {
      await reportPull(bgf.id, false, 0, String((e && e.message) || e));
    }
  })());
});

self.addEventListener("backgroundfetchfail", (event) => {
  event.waitUntil(reportPull(event.registration.id, false, event.registration.downloaded || 0, event.registration.failureReason || "fetch failed"));
});

self.addEventListener("backgroundfetchabort", (event) => {
  event.waitUntil(reportPull(event.registration.id, false, event.registration.downloaded || 0, "cancelled"));
});

// Tapping the OS download notification opens the app on its downloads list.
self.addEventListener("backgroundfetchclick", (event) => {
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (wins.length) { wins[0].focus(); wins[0].postMessage({ type: "open-pulls" }); return; }
    // `o=pull` is the app's OWN route (routing.ts's PERSISTED_OVERLAYS), so a
    // cold tap lands on the Downloads sheet. The old `#pulls=1` was read by
    // nothing and opened the launcher.
    await self.clients.openWindow("/#o=pull");
  })());
});
