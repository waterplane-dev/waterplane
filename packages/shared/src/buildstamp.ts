/**
 * Which build is this — one identifier, said the same way in the artifact and on the phone.
 *
 * The failure this exists for: the VS Code "install latest" button reinstalled 0.2.0 for ten days
 * (2026-10-16..26) while the package script built 0.3.0 through 0.7.0, and nothing anywhere said
 * which build was running. A version alone would not have caught a rebuild of the same version
 * either, so the identifier is the version AND the commit AND the time it was built.
 *
 * Two halves, one vocabulary:
 *  - `BuildStamp` is baked into an artifact at build time and shown INSIDE it (a tooltip, an About
 *    line), worded by `buildStampText`.
 *  - `BuildRecord` is one line a build appends to `<repo>/<state dir>/versions.jsonl` — whether a
 *    build button ran it or an agent did — and the build list shows the newest per `name`.
 *    The same `buildStampText` words both, so a person can match them by eye.
 *
 * Every field but `at` is optional and absent means nobody said — never "unknown", never 0.
 */
import { BRAND } from "./brand.js";

/** What a build knows about itself. */
export interface BuildStamp {
  /** The project's own version (`0.7.0`, `1.4.0+344`). */
  version?: string;
  /** The commit it was built from, short form. */
  sha?: string;
  /** Built with uncommitted edits in the sources it bundles: the sha alone does not say which. */
  dirty?: boolean;
  /** When it was built, epoch ms. */
  at: number;
}

/** One line of `<state dir>/versions.jsonl`: a stamp plus WHICH artifact and where it went. */
export interface BuildRecord extends BuildStamp {
  /** The artifact's stable name (`vscode-extension`, `apk-dev`, `web-bundle`). A build entry in
   *  `builds.json` names the one it produces with its `artifact` field. */
  name: string;
  /** Where it went: `dev`, `beta`, `store`, `local install`… free words, one line. */
  channel?: string;
  /** The file it produced, repo-relative, when there is one. */
  file?: string;
}

/** The per-repo file builds append to, relative to the repo root (gitignored desktop state). */
export const BUILD_RECORDS_FILE = `${BRAND.stateDirName}/versions.jsonl`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `27 Oct 08:42` in the reader's local time — a clock read beside other local clocks. */
export function buildTimeText(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `0.7.0 · a1b2c3d · 27 Oct 08:42`, with `+ edits` after the sha when it was built dirty.
 *  A missing part is not said. */
export function buildStampText(s: BuildStamp): string {
  const sha = s.sha ? `${s.sha}${s.dirty ? " + edits" : ""}` : s.dirty ? "uncommitted edits" : "";
  return [s.version ?? "", sha, buildTimeText(s.at)].filter(Boolean).join(" · ");
}

const ONE_LINE = /^[^\r\n]{1,200}$/;
const str = (v: unknown): string | undefined => (typeof v === "string" && ONE_LINE.test(v.trim()) ? v.trim() : undefined);

/** A stamp from untrusted JSON; null when it has no usable time. */
export function cleanBuildStamp(v: unknown): BuildStamp | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.at !== "number" || !Number.isFinite(o.at) || o.at <= 0) return null;
  const out: BuildStamp = { at: o.at };
  const version = str(o.version);
  const sha = str(o.sha);
  if (version) out.version = version;
  if (sha && /^[0-9a-f]{4,40}$/i.test(sha)) out.sha = sha;
  if (o.dirty === true) out.dirty = true;
  return out;
}

/** A record from untrusted JSON; null without a name or a time. */
export function cleanBuildRecord(v: unknown): BuildRecord | null {
  const stamp = cleanBuildStamp(v);
  const o = v as Record<string, unknown> | null;
  const name = o ? str(o.name) : undefined;
  if (!stamp || !name) return null;
  const out: BuildRecord = { ...stamp, name };
  const channel = str(o!.channel);
  const file = str(o!.file);
  if (channel) out.channel = channel;
  if (file) out.file = file;
  return out;
}

/** Every readable line of a `versions.jsonl`, oldest first as written. A line that does not
 *  parse is skipped, never fatal: one bad append must not hide every build after it. */
export function parseBuildRecords(text: string): BuildRecord[] {
  const out: BuildRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = cleanBuildRecord(JSON.parse(line));
      if (r) out.push(r);
    } catch { /* a torn or hand-edited line */ }
  }
  return out;
}

/** The newest record per name, newest first per name's history (capped at `keep` each). */
export function recordsByName(records: BuildRecord[], keep = 10): Record<string, BuildRecord[]> {
  const by: Record<string, BuildRecord[]> = {};
  for (const r of records) (by[r.name] ??= []).push(r);
  for (const k of Object.keys(by)) by[k] = by[k].sort((a, b) => b.at - a.at).slice(0, keep);
  return by;
}
