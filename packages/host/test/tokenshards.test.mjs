/**
 * The token ledger on disk: one shard per project slug under `<state>/tokenstats/`
 * (`jsonstore.ts`'s `JsonShards`), the way `agentreadings` is kept. A flush writes
 * only the slugs a sweep changed — the whole store stringified on the PTY loop was 4.7 MB.
 *
 *     node --test packages/host/test/tokenshards.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFixture } from "./fixtures/tokenscan.mjs";
import { TOKEN_LEGACY_FILE, TOKEN_SHARD_DIR, TokenStatsStore } from "../dist/tokenstats.js";
import { hostStateDir } from "../dist/branddirs.js";

process.env.TZ = "UTC";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "wp-tokenshard-"));
  const projects = writeFixture(home);
  const root = join(home, "root");
  return { home, projects, root, state: hostStateDir(root) };
}
async function withHome(home, fn) {
  const prev = process.env.WATERPLANE_CLAUDE_HOME;
  process.env.WATERPLANE_CLAUDE_HOME = home;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.WATERPLANE_CLAUDE_HOME; else process.env.WATERPLANE_CLAUDE_HOME = prev;
  }
}
const shardInodes = (state) => Object.fromEntries(readdirSync(join(state, TOKEN_SHARD_DIR)).map((n) => [n, ((st) => `${st.ino}:${st.mtimeNs}:${st.size}`)(statSync(join(state, TOKEN_SHARD_DIR, n), { bigint: true }))]));
const strip = (doc) => {
  const d = JSON.parse(JSON.stringify(doc));
  for (const k of ["scannedAt", "pricesAsOf", "pricesFrom", "pricesKey", "hours", "hoursFrom", "reread", "logs"]) delete d[k];
  return d;
};
/** The legacy single file as the pre-shard host wrote it, rebuilt from a source store's shards. */
function legacyOf(state) {
  const old = { v: 0, store: {} };
  const dir = join(state, TOKEN_SHARD_DIR);
  for (const n of readdirSync(dir)) {
    const { k, b } = JSON.parse(readFileSync(join(dir, n), "utf8"));
    old.v = b.v;
    old.store[k] = b.files;
  }
  return old;
}

test("a change to one slug writes exactly that slug's shard; the others are not rewritten", async () => {
  const { home, projects, root, state } = setup();
  await withHome(home, async () => {
    const store = new TokenStatsStore(root);
    await store.read(0);
    store.flush();
    const before = shardInodes(state);
    assert.deepEqual(Object.keys(before).sort(), ["-fx-repo-one.json", "-fx-repo-two.json"]);
    assert.equal(existsSync(join(state, TOKEN_LEGACY_FILE)), false, "the single file is never written any more");

    // A sweep that finds nothing new writes nothing.
    await store.read(0);
    store.flush();
    assert.deepEqual(shardInodes(state), before);

    appendFileSync(join(projects, "-fx-repo-two", "conv-b.jsonl"), JSON.stringify({
      type: "assistant", cwd: "/fx/repo-two", timestamp: new Date().toISOString(),
      message: { id: "late", model: "claude-test-a", content: [], usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }) + "\n");
    await store.read(0);
    store.flush();
    const after = shardInodes(state);
    assert.deepEqual(Object.keys(after).filter((n) => after[n] !== before[n]), ["-fx-repo-two.json"]);
  });
});

test("migration: the legacy file seeds every slug, every key reads back equal, and the file is set aside as .migrated only after the shards are written", async () => {
  const { home, root, state } = setup();
  await withHome(home, async () => {
    const src = new TokenStatsStore(join(home, "src-root"));
    const want = strip(await src.read(0));
    src.flush();
    const old = legacyOf(hostStateDir(join(home, "src-root")));
    assert.equal(Object.keys(old.store).length, 2);
    mkdirSync(state, { recursive: true });
    const legacy = join(state, TOKEN_LEGACY_FILE);
    writeFileSync(legacy, JSON.stringify(old));

    // A scan over empty logs would answer empty by design, so read the migrated store back from its shards: every key equal.
    const store = new TokenStatsStore(root);
    const back = legacyOf(state);
    assert.deepEqual(back.store, old.store);
    assert.equal(back.v, old.v);
    // And the migrated store, once the logs are scanned, answers what the source store did.
    assert.deepEqual(strip(await store.read(0)), want);
    assert.deepEqual(Object.keys(shardInodes(state)).sort(), ["-fx-repo-one.json", "-fx-repo-two.json"]);
    assert.equal(existsSync(legacy), false);
    assert.deepEqual(JSON.parse(readFileSync(`${legacy}.migrated`, "utf8")), old, "the old bytes are kept whole");

    // Once: a second boot reads the shards and rewrites nothing.
    const before = shardInodes(state);
    new TokenStatsStore(root);
    assert.deepEqual(shardInodes(state), before);
  });
});

test("a legacy file of another VERSION is not migrated", async () => {
  const { home, root, state } = setup();
  await withHome(home, async () => {
    const src = new TokenStatsStore(join(home, "src-root"));
    await src.read(0);
    src.flush();
    const old = legacyOf(hostStateDir(join(home, "src-root")));
    old.v -= 1;
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, TOKEN_LEGACY_FILE), JSON.stringify(old));
    new TokenStatsStore(root);
    assert.equal(existsSync(join(state, TOKEN_SHARD_DIR)) && readdirSync(join(state, TOKEN_SHARD_DIR)).length, false, "no shard seeded from it");
  });
});

test("a shard written under another VERSION is ignored: that slug is re-read from the logs", async () => {
  const { home, root, state } = setup();
  await withHome(home, async () => {
    const a = new TokenStatsStore(root);
    const want = strip(await a.read(0));
    a.flush();
    const p = join(state, TOKEN_SHARD_DIR, "-fx-repo-one.json");
    const shard = JSON.parse(readFileSync(p, "utf8"));
    shard.b.v -= 1;
    shard.b.files = {};
    writeFileSync(p, JSON.stringify(shard));
    assert.deepEqual(strip(await new TokenStatsStore(root).read(0)), want);
  });
});

test("a failed shard write leaves the legacy file in place", async () => {
  const { home, root, state } = setup();
  await withHome(home, async () => {
    const src = new TokenStatsStore(join(home, "src-root"));
    await src.read(0);
    src.flush();
    const old = legacyOf(hostStateDir(join(home, "src-root")));
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, TOKEN_SHARD_DIR), "not a directory"); // every shard write fails
    const legacy = join(state, TOKEN_LEGACY_FILE);
    writeFileSync(legacy, JSON.stringify(old));
    new TokenStatsStore(root);
    assert.deepEqual(JSON.parse(readFileSync(legacy, "utf8")), old);
    assert.equal(existsSync(`${legacy}.migrated`), false);
  });
});
