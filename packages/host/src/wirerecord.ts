/**
 * Record mode: `WATERPLANE_WIRE_RECORD=<file>` appends one JSON line per WebSocket
 * frame (both directions) and per `/api` JSON response. It is the SOURCE of the
 * demo scenarios (docs/analysis/demo-mode-plan.md §3): `tools/demo-scenario.mjs`
 * turns a recording of the stub-driven host into a scenario skeleton.
 *
 * Zero-cost when unset: `WIRE` is a constant `false`, every call site is
 * `if (WIRE) recordWire…`, and nothing here runs. A recording is RAW — real
 * roots, prompts, numbers — and is never to be shipped; only the tool's
 * fail-closed scrub makes it fit to.
 *
 * Because it is raw, how the file is WRITTEN is a security property, not a
 * detail (adversarial review, 2026-10):
 * - owner-only: created 0600 and an existing file tightened to 0600 before the
 *   first append; opened `O_NOFOLLOW` and refused unless it is a regular file
 *   this user owns — a path in a shared `/tmp` must not become a way to append
 *   to someone's file through a planted symlink, or into a file another user
 *   created to read;
 * - secrets never reach disk even raw: a value under a secret-named key (an
 *   `auth.set` password, a token in a response body) and a secret-named query
 *   parameter are replaced with `[redacted]` here, at the source;
 * - capped: recording stops at `CAP_BYTES` with one line on stderr — a knob
 *   left on in a `.env` must not fill the disk;
 * - loud: turning it on prints a line on stderr at start, because the knob can
 *   come from any of the `.env` files `env.ts` reads, not only the shell.
 */
import { closeSync, constants, fchmodSync, fstatSync, openSync, writeSync } from "node:fs";
import { envName, logTag } from "@waterplane/shared";
import { env } from "./env.js";

const FILE = env("WIRE_RECORD") ?? "";
export const WIRE = FILE !== "";

/** Recording stops here; a stub demo session is a few hundred KB. */
const CAP_BYTES = 256 * 1024 * 1024;
const SECRET_KEY = /^(token|password|passwd|passphrase|secret|clientSecret|cookie|authorization|apikey|api_key|accessToken|refreshToken|idToken|privateKey|credentials?)$/i;
const SECRET_PARAM = /^(token|access_token|auth|key|apikey|api_key|sig|signature|password|pw|secret|code)$/i;
const REDACTED = "[redacted]";

if (WIRE) console.warn(`${logTag} ${envName("WIRE_RECORD")} is ON: every frame and /api response is appended, raw, to ${FILE} — unset it unless you are recording a demo`);

type Line = { at: number } & (
  | { dir: "out" | "in"; msg: unknown }
  | { dir: "http"; method: string; path: string; status: number; body: unknown }
);

let fd: number | null | undefined; // undefined = not opened yet, null = refused or stopped
let size = 0;

function stop(why: string): null {
  console.warn(`${logTag} wire recording stopped: ${why}`);
  if (typeof fd === "number") { try { closeSync(fd); } catch { /* already */ } }
  fd = null;
  return null;
}

function open(): number | null {
  try {
    const f = openSync(FILE, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    fd = f;
    const st = fstatSync(f);
    if (!st.isFile()) return stop(`${FILE} is not a regular file`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return stop(`${FILE} belongs to another user`);
    fchmodSync(f, 0o600);
    size = st.size;
    return f;
  } catch (e) {
    return stop(`cannot open ${FILE} (${(e as NodeJS.ErrnoException).code ?? String(e)}; a symlink is refused)`);
  }
}

/** A copy with every secret-named key's value replaced. */
function redact(v: unknown, depth = 0): unknown {
  if (depth > 64 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    o[k] = SECRET_KEY.test(k) && x !== null && x !== "" && x !== undefined && x !== false ? REDACTED : redact(x, depth + 1);
  }
  return o;
}

function redactPath(path: string): string {
  const q = path.indexOf("?");
  if (q < 0) return path;
  const params = path.slice(q + 1).split("&").map((kv) => {
    const eq = kv.indexOf("=");
    if (eq < 0) return kv;
    let name = kv.slice(0, eq);
    try { name = decodeURIComponent(name); } catch { /* keep raw */ }
    return SECRET_PARAM.test(name) ? `${kv.slice(0, eq)}=${REDACTED}` : kv;
  });
  return path.slice(0, q + 1) + params.join("&");
}

function write(line: Line): void {
  try {
    const f = fd === undefined ? open() : fd;
    if (f === null) return;
    const buf = Buffer.from(JSON.stringify(line) + "\n", "utf8");
    if (size + buf.length > CAP_BYTES) { stop(`the ${CAP_BYTES / 1024 / 1024} MB cap on ${FILE} is reached`); return; }
    writeSync(f, buf);
    size += buf.length;
  } catch { /* a recording must never break the host */ }
}

/** A frame as the host sent (`out`) or received (`in`) it. */
export function recordWireFrame(dir: "out" | "in", msg: unknown): void {
  write({ at: Date.now(), dir, msg: redact(msg) });
}

/** One `/api` JSON response (body parsed back so the file stays line-per-record). */
export function recordWireHttp(method: string, path: string, status: number, body: Buffer): void {
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString("utf8")); } catch { parsed = null; }
  write({ at: Date.now(), dir: "http", method, path: redactPath(path), status, body: redact(parsed) });
}
