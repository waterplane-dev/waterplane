/**
 * The decision log: every automatic thing done or proposed on a session's
 * behalf — a usage-limit auto-continue (`source: "limit"`) or a plugin's
 * suggestion/answer (`source: "plugin"`). Newest-first, ring-buffered to
 * LOG_LIMIT, on disk at `<STATE_DIR>/decision-log.json`.
 *
 * It was the Gemini oracle's log (`.waterplane/oracle-log.json`). On first boot that
 * file is migrated in — oracle rows become `source: "plugin", plugin: "oracle"`,
 * limit rows `source: "limit"` — and renamed `oracle-log.json.migrated`, never
 * deleted: a conversion nobody can check is one nobody can trust.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { DecisionLogEntry } from "@waterplane/shared";
import { logTag } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

const LOG_LIMIT = 500;

/** One row of the retired oracle log, as it may sit on disk. */
function fromOracleRow(r: any): DecisionLogEntry | null {
  if (!r || typeof r !== "object" || typeof r.id !== "string" || typeof r.ts !== "number") return null;
  const limit = r.kind === "limit";
  const e: DecisionLogEntry = {
    id: r.id, ts: r.ts, sessionId: String(r.sessionId ?? ""), sessionTitle: String(r.sessionTitle ?? ""),
    source: limit ? "limit" : "plugin",
    ...(limit ? {} : { plugin: "oracle" }),
    ...(r.phase ? { phase: r.phase } : {}),
    question: String(r.question ?? ""),
    options: Array.isArray(r.options) ? r.options : [],
    outcome: String(r.outcome ?? (limit ? "limit" : "")),
    choice: typeof r.choice === "number" ? r.choice : null,
    rationale: String(r.rationale ?? ""),
  };
  if (r.answer) e.answer = String(r.answer);
  if (!limit) {
    if (typeof r.confidence === "number") e.confidence = r.confidence;
    if (r.model) e.model = String(r.model);
    if (r.contextSent) e.contextSent = String(r.contextSent);
    if (typeof r.images === "number") e.images = r.images;
    if (typeof r.inTok === "number") e.inTok = r.inTok;
    if (typeof r.outTok === "number") e.outTok = r.outTok;
  }
  if (r.error) e.error = String(r.error);
  if (r.archived) e.archived = true;
  return e;
}

/**
 * Fold `.waterplane/oracle-log.json` into `rows` and rename it `.migrated`. Returns
 * the merged rows (newest first, capped) or null when there was nothing to do.
 * An unreadable old file is left where it is and said so, never deleted.
 */
export function migrateOracleLog(stateDir: string, rows: DecisionLogEntry[]): DecisionLogEntry[] | null {
  const old = join(stateDir, "oracle-log.json");
  if (!existsSync(old)) return null;
  let parsed: unknown;
  // The legacy file is left in place, never moved aside: a plain parse, not readJsonGuarded.
  try { parsed = JSON.parse(readFileSync(old, "utf8")); } catch {
    console.warn(`${logTag} ${old} is not readable JSON — left in place, not migrated`);
    return null;
  }
  const have = new Set(rows.map((r) => r.id));
  const add = (Array.isArray(parsed) ? parsed : []).map(fromOracleRow).filter((e): e is DecisionLogEntry => !!e && !have.has(e.id));
  const merged = [...rows, ...add].sort((a, b) => b.ts - a.ts).slice(0, LOG_LIMIT);
  try { renameSync(old, old + ".migrated"); } catch { /* the next boot tries again; ids dedupe */ }
  console.log(`${logTag} decision log: migrated ${add.length} row${add.length === 1 ? "" : "s"} from oracle-log.json`);
  return merged;
}

export class DecisionLog {
  private path: string;
  private entries: DecisionLogEntry[] = [];

  /** `onChange` runs after every add/archive/delete — the host broadcasts `decisions.log`. */
  constructor(root: string, private readonly onChange: () => void = () => {}) {
    const dir = hostStateDir(root);
    this.path = join(dir, "decision-log.json");
    try {
      if (existsSync(this.path)) this.entries = readJsonGuarded<DecisionLogEntry[]>(this.path, this.entries, Array.isArray);
    } catch { /* fresh */ }
    const merged = migrateOracleLog(dir, this.entries);
    if (merged) { this.entries = merged; this.write(); }
  }

  /** Append an entry (newest kept at index 0) and persist. */
  add(e: DecisionLogEntry): void {
    this.entries.unshift(e);
    if (this.entries.length > LOG_LIMIT) this.entries.length = LOG_LIMIT;
    this.persist();
  }

  /**
   * Entries newest-first, filtered to `sessionId` when given. Archived entries
   * are kept on disk but excluded unless `includeArchived`.
   */
  list(sessionId?: string, includeArchived = false): DecisionLogEntry[] {
    return this.entries
      .filter((e) => (sessionId ? e.sessionId === sessionId : true))
      .filter((e) => (includeArchived ? true : !e.archived))
      .slice()
      .sort((a, b) => b.ts - a.ts);
  }

  /** Archive (hide) or un-archive one entry. Returns true if it existed. */
  setArchived(id: string, archived: boolean): boolean {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return false;
    e.archived = archived;
    this.persist();
    return true;
  }

  /** Permanently delete one entry. Returns true if it existed. */
  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length === before) return false;
    this.persist();
    return true;
  }

  /** Archive every currently-visible (non-archived) entry. Returns the count. */
  archiveAll(): number {
    let n = 0;
    for (const e of this.entries) if (!e.archived) { e.archived = true; n++; }
    if (n) this.persist();
    return n;
  }

  private persist(): void {
    this.write();
    try { this.onChange(); } catch { /* a listener never breaks the log */ }
  }

  private write(): void {
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      writeJsonAtomic(this.path, this.entries);
    } catch { /* non-fatal */ }
  }
}
