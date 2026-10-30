/**
 * A host read a screen stops wanting is ABORTED, not merely ignored.
 *
 * A component that drops a late answer with `let live = false` still leaves
 * its request running to the 20 s fuse, and the APK reaches the host over
 * plain HTTP/1.1: six such orphans are every socket the WebView opens to it,
 * and every other read queues behind them (edae4484, "loading files +6 ·
 * 18s"). So each client call a screen makes on a key change or close takes the
 * caller's `AbortSignal` — pinned here by calling it through the real `api` /
 * `ledgers` objects against a `fetch` that hangs until its signal fires:
 * aborting the caller's controller must abort the request on the wire.
 *
 * The other half, that the SCREENS hand a signal at all, is the
 * hand-rolled-reads ratchet in `webshape.test.mjs`.
 *
 * Bundled with esbuild (the webapi slices import extensionless, which node's
 * type stripping cannot resolve), so it needs @waterplane/shared's dist.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "packages", "web", "src");

/** Each case calls one client member with `signal` the way its screen does. */
const CASES = {
  "api.inbox": (api, _l, signal) => api.inbox("r1", signal),
  "api.artifacts": (api, _l, signal) => api.artifacts("r1", "outbox", undefined, { signal }),
  "api.gitText": (api, _l, signal) => api.gitText("r1", "a.txt", "new", false, signal),
  "api.gitExplainState": (api, _l, signal) => api.gitExplainState("r1", signal),
  "api.gitPushState": (api, _l, signal) => api.gitPushState("r1", signal),
  "api.gitBlob": (api, _l, signal) => api.gitBlob("r1", "a.png", "new", false, undefined, signal),
  "api.scrollback": (api, _l, signal) => api.scrollback("s1", signal),
  "api.worktreeLeftover": (api, _l, signal) => api.worktreeLeftover("r1", signal),
  "api.tailnet.peers": (api, _l, signal) => api.tailnet.peers(signal),
  "api.setupPrefs": (api, _l, signal) => api.setupPrefs(signal),
  "ledgers.sourceHistory": (_a, ledgers, signal) => ledgers.sourceHistory("claude", signal),
};

let loaded;
async function load() {
  if (loaded) return loaded;
  const { build } = createRequire(join(ROOT, "package.json"))("esbuild");
  const dir = join(ROOT, "node_modules", ".ssr");
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "hostreadabort-entry.ts");
  writeFileSync(entry, `
export { api } from ${JSON.stringify(join(SRC, "api.ts"))};
export { ledgers } from ${JSON.stringify(join(SRC, "sdk", "ledgers.ts"))};
`);
  const out = join(dir, "hostreadabort.mjs");
  await build({
    entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: out, jsx: "automatic", logLevel: "error",
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl" },
    external: ["react", "react-dom", "lucide-react"], nodePaths: [join(ROOT, "node_modules")],
    define: { "import.meta.env": "{}", __BUILD_ID__: '"TEST"' },
  });
  loaded = await import(`${pathToFileURL(out).href}?t=${Date.now()}`);
  return loaded;
}

/** A `fetch` that never answers on its own: it settles only when its signal aborts. */
function hangingFetch() {
  const seen = [];
  const fetch = (url, init) => {
    const signal = init?.signal;
    seen.push({ url: String(url), signal });
    return new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };
  return { fetch, seen };
}

for (const [name, call] of Object.entries(CASES)) {
  test(`${name}: aborting the caller's signal aborts the request`, async () => {
    const { api, ledgers } = await load();
    const real = globalThis.fetch;
    const { fetch, seen } = hangingFetch();
    globalThis.fetch = fetch;
    try {
      const ac = new AbortController();
      const p = Promise.resolve().then(() => call(api, ledgers, ac.signal));
      p.catch(() => undefined);
      // Let the call reach fetch (it may await a cache or a header first).
      for (let i = 0; i < 20 && !seen.length; i++) await new Promise((r) => setTimeout(r, 5));
      assert.equal(seen.length, 1, `${name} made ${seen.length} requests`);
      ac.abort();
      assert.ok(seen[0].signal?.aborted, `${name}: ${seen[0].url} kept running after its caller aborted — the signal never reached fetch`);
    } finally {
      globalThis.fetch = real;
    }
  });
}
