/**
 * When each setup-check finding was first seen open on this desktop, so a card can say "first seen
 * 22 Nov 09:12" and a new finding is told apart from one that has sat for weeks.
 *
 * Keyed by finding id, plus the repo key for repo-scope findings (machine and account findings are
 * the same fact in every repo). A finding that was already open at the first check that could have
 * seen it — the ledger's first run for that repo — is marked `atLeast`: it may be older, and the card
 * says so rather than calling that the day it appeared. An entry not produced for 30 days is
 * dropped, so a finding that comes back later is new again. Persisted in `<STATE_DIR>/finding-seen.json`.
 */
import { join } from "node:path";
import type { Finding } from "@waterplane/shared";
import { hostStateDir } from "../branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "../jsonstore.js";

const FORGET_MS = 30 * 24 * 60 * 60_000;

interface Entry { first: number; last: number; atLeast?: true }
interface Doc { v: 1; scopes: Record<string, number>; seen: Record<string, Entry> }

const keyOf = (f: Finding): string => (f.scope === "repo" ? `${f.repo ?? ""}|${f.id}` : `${f.scope}|${f.id}`);
const scopeOf = (f: Finding): string => (f.scope === "repo" ? `repo:${f.repo ?? ""}` : f.scope);

export class FindingSeenLedger {
  private doc: Doc;
  constructor(private path: string | null) {
    const raw = path ? readJsonGuarded<any>(path, null) : null;
    this.doc = { v: 1, scopes: {}, seen: {} };
    if (raw && raw.v === 1 && raw.seen && typeof raw.seen === "object") {
      for (const [k, v] of Object.entries<any>(raw.scopes ?? {})) if (Number(v) > 0) this.doc.scopes[k] = Number(v);
      for (const [k, v] of Object.entries<any>(raw.seen)) {
        const first = Number(v?.first), last = Number(v?.last);
        if (first > 0 && last >= first) this.doc.seen[k] = { first, last, ...(v.atLeast ? { atLeast: true as const } : {}) };
      }
    }
  }

  /** Stamp `seen` on every finding (the earlier of the source's own date and this ledger's), and remember them. */
  stamp(findings: Finding[], now: number): Finding[] {
    let changed = false;
    for (const [k, e] of Object.entries(this.doc.seen)) if (now - e.last > FORGET_MS) { delete this.doc.seen[k]; changed = true; }
    const firstRun = new Set<string>();
    for (const f of findings) {
      const s = scopeOf(f);
      if (!this.doc.scopes[s]) { this.doc.scopes[s] = now; firstRun.add(s); changed = true; }
    }
    const out = findings.map((f) => {
      const k = keyOf(f);
      let e = this.doc.seen[k];
      if (!e) {
        e = { first: now, last: now, ...(firstRun.has(scopeOf(f)) ? { atLeast: true as const } : {}) };
        this.doc.seen[k] = e;
        changed = true;
      } else if (now - e.last > 60 * 60_000) { e.last = now; changed = true; }
      const own = f.seen && f.seen.at > 0 && f.seen.at <= e.first ? f.seen : null;
      return { ...f, seen: own ?? { at: e.first, from: "desktop" as const, ...(e.atLeast ? { atLeast: true as const } : {}) } };
    });
    if (changed && this.path) {
      try { writeJsonAtomic(this.path, this.doc); } catch { /* the dates fall back to this run's; nothing else depends on them */ }
    }
    return out;
  }
}

let shared: FindingSeenLedger | null = null;
export function findingSeenLedger(root: string): FindingSeenLedger {
  return (shared ??= new FindingSeenLedger(join(hostStateDir(root), "finding-seen.json")));
}
