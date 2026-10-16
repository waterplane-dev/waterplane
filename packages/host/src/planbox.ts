/**
 * The plan a plan-approval box is asking you to approve, read from the plan
 * FILE rather than off the screen.
 *
 * `askbox.ts` can enrich an `AskUserQuestion` box from the conversation log
 * because that call is written to the log before anyone answers. The plan
 * approval is the exception: measured on claude 2.1.x, the `ExitPlanMode` call
 * is NOT in the log while its box is up — the assistant record lands only once
 * the box is answered. So the phone's card said "Claude has written up a plan
 * and is ready to execute. Would you like to proceed?" over three buttons, with
 * the plan itself nowhere on the device except as terminal rows scrolled far
 * above the box.
 *
 * What IS on disk is the plan file the CLI draws that box from
 * (`<config>/plans/<slug>.md` — the path the box's own footer names after
 * "ctrl+g to edit"). Its location comes from the log: the newest `plan_mode`
 * attachment's `planFilePath` when the tail still holds one, else the `slug`
 * every record carries. Both are the CLI's own words; nothing is guessed from
 * the screen.
 *
 * Read-only, best-effort, and heuristic in exactly `askbox.ts`'s way: the record
 * shape is the CLI's internal format, not a contract. Every failure is null and
 * the box is published unchanged — absent, never a wrong plan.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDir } from "./claudeconfig.js";
import { transcriptPath } from "./transcript.js";

/** Tail bytes scanned for the path. `slug` is on every record, so a few
 *  records are enough; the `plan_mode` attachment is a bonus when it is near. */
const TAIL_BYTES = 256 * 1024;
/**
 * The most plan text that rides on the box. The box is part of `SessionInfo`,
 * which goes out on every `session.updated` while it is up — a plan is a few KB
 * of markdown (12.6 KB measured on a long one), and this keeps a pathological
 * file from turning every broadcast into a megabyte.
 */
export const PLAN_CAP = 48 * 1024;

export interface PendingPlan { text: string; path: string; cut?: boolean }

/**
 * Is this box the plan approval? Asked of the QUESTION, the one row of that box
 * the CLI words about a plan ("Claude has written up a plan and is ready to
 * execute"). Not of `kind`: that question also says "proceed", which the
 * detector's older rule files under `tool`.
 */
export function isPlanBox(question: string | undefined): boolean {
  return !!question && /\b(a|the|this) plan\b/i.test(question);
}

/** Where the CLI keeps this conversation's plan, per its own log — or null. */
export function planPathFor(cwd: string, claudeSessionId: string | undefined): string | null {
  if (!claudeSessionId) return null;
  let raw: string;
  try {
    const path = transcriptPath(cwd, claudeSessionId);
    const st = statSync(path);
    const start = Math.max(0, st.size - TAIL_BYTES);
    const len = st.size - start;
    if (len <= 0) return null;
    const buf = Buffer.allocUnsafe(len);
    const fd = openSync(path, "r");
    try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
    raw = buf.toString("utf8");
    if (start > 0) raw = raw.slice(raw.indexOf("\n") + 1);
  } catch { return null; }
  let filePath: string | null = null;
  let slug: string | null = null;
  // Newest first: the last record is the one describing the box on screen.
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0 && !filePath; i--) {
    const line = lines[i];
    if (!line) continue;
    const wantsPath = line.includes("planFilePath");
    if (!wantsPath && slug) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    const p = rec?.attachment?.planFilePath;
    if (typeof p === "string" && p.endsWith(".md")) filePath = p;
    if (!slug && typeof rec?.slug === "string" && /^[\w-]+$/.test(rec.slug)) slug = rec.slug;
  }
  // The attachment names the slug's own file in every log measured; when the
  // two disagree the attachment wins — it is the path the CLI was told to use.
  if (filePath) return filePath;
  return slug ? join(claudeConfigDir(), "plans", `${slug}.md`) : null;
}

/** The plan file's text, capped — or null when there is none to read. */
export function readPlan(path: string): PendingPlan | null {
  try {
    if (!path.endsWith(".md")) return null;
    const st = statSync(path);
    if (!st.isFile() || st.size === 0) return null;
    const text = readFileSync(path, "utf8");
    if (!text.trim()) return null;
    const cut = text.length > PLAN_CAP;
    return { text: cut ? text.slice(0, PLAN_CAP) : text, path, ...(cut ? { cut: true } : {}) };
  } catch { return null; }
}
