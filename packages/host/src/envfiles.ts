/**
 * How the daemon's `.env` files combine — pure, so a test can hand it files and
 * an env object without booting anything (`env.ts` is the one caller, at import).
 *
 * The files are given LOWEST precedence first: a later file overrides an earlier
 * one, and nothing the process was started with is ever overridden. That is the
 * convention dotenv-flow, Vite and Next.js share (shell > more specific file >
 * more general file), and it is the one `.env.example` promised from the start.
 *
 * `process.loadEnvFile` cannot express it: it never overwrites a key already in
 * `process.env`, so with several files the FIRST one to set a key won — until
 * 2026-09-28 the per-user config file, the one set-secret writes and hot-reloads
 * into `process.env`, lost every restart to a stale copy of the key in the repo
 * `.env`: a secret set from the phone worked until the daemon restarted.
 */
import { readFileSync } from "node:fs";
// A namespace import, not `{ parseEnv }`: a named import of an export this Node
// lacks (parseEnv is 20.12+) fails the WHOLE module graph at link time, before
// env.ts's one-sentence refusal of a too-old Node could run.
import * as util from "node:util";

/** Load `paths` (lowest precedence first) into `env`. A missing or unreadable
 *  file is skipped. A key present in `env` before the call is never touched.
 *  `origins`, when given, records which file each loaded key came from — so a
 *  legacy knob's warning can name the file to edit. */
export function loadEnvFiles(
  paths: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  origins?: Map<string, string>,
): void {
  const inherited = new Set(Object.keys(env));
  for (const p of paths) {
    let vars: NodeJS.Dict<string>;
    try { vars = util.parseEnv(readFileSync(p, "utf8")); } catch { continue; }
    for (const [k, v] of Object.entries(vars)) {
      if (!inherited.has(k) && v !== undefined) { env[k] = v; origins?.set(k, p); }
    }
  }
}
