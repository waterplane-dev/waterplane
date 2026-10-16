/**
 * "Flag for follow up when done" (R-sessions-043): the session a row opened
 * gets the launch flag once the row is DONE — ok, nothing running under the
 * session — and never for a row that failed or stopped on a limit.
 *
 * ONCE per row: the ids already applied are remembered on disk, so a person
 * clearing the flag does not see it return next tick and a restart does not
 * re-flag. It runs before `lingerSweep` (the facade calls it first), so a
 * session that wants a flag is flagged before anything can close it.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { clipFollowUpText } from "@waterplane/shared";
import { hostStateDir } from "../branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "../jsonstore.js";
import type { BacklogCore } from "./backlogcore.js";
import { openerRow, slotBusy } from "./backlogsessions.js";

/** How many applied row ids are kept — a row older than this is long archived. */
export const FOLLOWUP_APPLIED_CAP = 500;

const cache = new Map<string, string[]>();

/** Drop the in-memory copy so the next sweep re-reads the file — what a restart does. Tests only. */
export function forgetAppliedCache(): void { cache.clear(); }

function appliedPath(c: BacklogCore): string { return join(hostStateDir(c.root), "followup-launched.json"); }

function applied(c: BacklogCore): string[] {
  const p = appliedPath(c);
  let list = cache.get(p);
  if (!list) {
    list = [];
    try { if (existsSync(p)) list = readJsonGuarded<string[]>(p, [], Array.isArray).filter((x) => typeof x === "string"); } catch { /* fresh */ }
    cache.set(p, list);
  }
  return list;
}

/** Session ids flagged this pass. Never throws: a sweep must not take the loop down. */
export function followUpSweep(c: BacklogCore): string[] {
  const flagged: string[] = [];
  try {
    const done = applied(c);
    for (const r of c.intents.list()) {
      if (r.flagWhenDone !== true || r.state !== "done" || r.result?.ok !== true || !r.sessionId) continue;
      if (done.includes(r.id)) continue;
      if (!c.sessions.get(r.sessionId)?.running) continue;
      // The row that OPENED the session decides, not a later row typed into it.
      if (openerRow(c, r.sessionId)?.id !== r.id) continue;
      if (slotBusy(c, r.sessionId)) continue;
      const item = clipFollowUpText(r.label || (r.payload.kind === "prompt" ? r.payload.steps[0] : "") || r.title);
      c.sessions.setFollowUp(r.sessionId, { by: "launch", at: Date.now(), ...(item ? { item } : {}) });
      done.push(r.id);
      flagged.push(r.sessionId);
    }
    if (flagged.length) {
      if (done.length > FOLLOWUP_APPLIED_CAP) done.splice(0, done.length - FOLLOWUP_APPLIED_CAP);
      try { writeJsonAtomic(appliedPath(c), done, { space: 2 }); } catch { /* non-fatal: worst case a re-flag after restart */ }
    }
  } catch { /* a read that throws flags nothing */ }
  return flagged;
}
