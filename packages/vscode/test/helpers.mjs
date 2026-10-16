// Shared by the data-layer tests: the built bundle, the fixture paths, and a
// line builder for the logs a test writes into its own temp dir.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DIST = join(here, "..", "dist");
export const SRC = join(here, "..", "src");
export const data = await import(join(DIST, "data.mjs"));
export const FIXTURES = join(here, "fixtures");
export const CONV_ID = "11111111-2222-4333-8444-555555555555";
export const PROJECT = join(FIXTURES, "projects", "-Users-x-repo");
export const LOG = join(PROJECT, `${CONV_ID}.jsonl`);
export const SONNET = "claude-sonnet-4-5";

export const tmp = (tag) => mkdtempSync(join(tmpdir(), `wp-vscode-${tag}-`));

const ts = (sec) => new Date(Date.UTC(2026, 9, 2, 9, 0, sec)).toISOString();
/** A typed prompt at second `sec`. */
export const prompt = (sec, text) => JSON.stringify({ type: "user", timestamp: ts(sec), cwd: "/Users/x/t", message: { role: "user", content: text } });
/** A local slash command (`/model`) at second `sec`. */
export const slash = (sec, name) => JSON.stringify({ type: "user", timestamp: ts(sec), cwd: "/Users/x/t", message: { role: "user", content: `<command-name>${name}</command-name><command-args></command-args>` } });
/** One assistant request at second `sec`; `stop` is the message's `stop_reason` (omitted = the field is absent). */
export const req = (sec, id, { input = 0, cw = 0, cr = 0, output = 0, model = SONNET, stop } = {}) => JSON.stringify({
  type: "assistant", timestamp: ts(sec), cwd: "/Users/x/t",
  message: { id, model, role: "assistant", ...(stop !== undefined ? { stop_reason: stop } : {}), usage: { input_tokens: input, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: output } },
});

/** The five priced kinds plus the request count — the fields a split is compared on. */
export const KINDS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "turns"];
export const sumKinds = (rows) => Object.fromEntries(KINDS.map((k) => [k, rows.reduce((n, r) => n + r[k], 0)]));
export const pick = (t) => Object.fromEntries(KINDS.map((k) => [k, t[k]]));
