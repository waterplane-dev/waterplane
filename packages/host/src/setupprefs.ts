/**
 * What this person decided about the setup checklist, as opposed to what the
 * checklist measures: which advisory rows they chose to ignore in which repo,
 * and which auto-compact window the checklist offers to write.
 *
 * Same shape and same reasons as `contextlimits.ts`:
 *
 *  - **A host store, never a file written into the repo.** `setupwatch.ts`
 *    sweeps repos nobody opened and never writes into one, and "ignore this
 *    here" is this desktop's opinion about a directory, not a fact about its
 *    source. `<STATE_DIR>/setupprefs.json`.
 *  - **Keyed by REALPATH**, so the ignore saved from the sheet is the one the
 *    sweep reads.
 *  - **Only `ADVISORY_CHECKS` can be ignored.** A committed secret or an
 *    un-ignored outbox is a finding; letting it be hidden would make the badge
 *    a switch rather than a reading.
 *  - **Host-side, not a synced setting**, because `settings.ts` stores opaque
 *    strings the daemon never parses, and the sweep needs the chosen window
 *    with no client attached (it decides where the row passes).
 *  - **Unset is a silent no-op**: `inspectRepo()` called from a test with no
 *    store installed gets no ignores and the shipped default.
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ContextLimitsStore, setContextLimitsStore } from "./contextlimits.js";
import { ADVISORY_CHECKS, AUTO_COMPACT_SUGGESTED, OPT_INS, cleanAutoCompactDefault, type ComplianceAcceptRequest, type OptInChoice } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { setExposureAccept } from "./exposure.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

interface Doc {
  autoCompactDefault?: string;
  ignored: Record<string, string[]>;
  /** What the person said about each opt-in offer, per repo (`optins.ts`). Not a check: nothing here is counted. */
  optIns: Record<string, Record<string, OptInChoice>>;
  /** When this desktop last saw each offer's words sent, per repo (`optins.ts`'s
   *  `noteOptInSends`). Remembered because the session that carried them, and
   *  its history, are gone once it closes. */
  optInSent: Record<string, Record<string, number>>;
}

function key(worktree: string): string {
  try { return realpathSync(worktree); } catch { return worktree; }
}

export class SetupPrefsStore {
  private path: string;
  private doc: Doc = { ignored: {}, optIns: {}, optInSent: {} };

  constructor(root: string) {
    this.path = join(hostStateDir(root), "setupprefs.json");
    try {
      if (existsSync(this.path)) {
        const raw = readJsonGuarded<any>(this.path, null) as { autoCompactDefault?: unknown; ignored?: unknown; optIns?: unknown; optInSent?: unknown };
        // Cleaned on the way IN too: a hand-edit must not put an unreadable
        // window or a non-advisory id where the checklist reads it.
        if (raw?.autoCompactDefault != null) {
          const c = cleanAutoCompactDefault(raw.autoCompactDefault);
          if (c.ok) this.doc.autoCompactDefault = c.value;
        }
        if (raw?.ignored && typeof raw.ignored === "object" && !Array.isArray(raw.ignored)) {
          for (const [k, v] of Object.entries(raw.ignored as Record<string, unknown>)) {
            const ids = Array.isArray(v) ? v.map(String).filter((id) => ADVISORY_CHECKS.includes(id)) : [];
            if (ids.length) this.doc.ignored[k] = [...new Set(ids)];
          }
        }
        if (raw?.optIns && typeof raw.optIns === "object" && !Array.isArray(raw.optIns)) {
          for (const [k, v] of Object.entries(raw.optIns as Record<string, unknown>)) {
            if (!v || typeof v !== "object" || Array.isArray(v)) continue;
            const m: Record<string, OptInChoice> = {};
            for (const [id, c] of Object.entries(v as Record<string, unknown>)) {
              if (OPT_INS.some((d) => d.id === id) && (c === "declined" || c === "done")) m[id] = c;
            }
            if (Object.keys(m).length) this.doc.optIns[k] = m;
          }
        }
        if (raw?.optInSent && typeof raw.optInSent === "object" && !Array.isArray(raw.optInSent)) {
          for (const [k, v] of Object.entries(raw.optInSent as Record<string, unknown>)) {
            if (!v || typeof v !== "object" || Array.isArray(v)) continue;
            const m: Record<string, number> = {};
            for (const [id, at] of Object.entries(v as Record<string, unknown>)) {
              if (OPT_INS.some((d) => d.id === id) && typeof at === "number" && Number.isFinite(at) && at > 0) m[id] = at;
            }
            if (Object.keys(m).length) this.doc.optInSent[k] = m;
          }
        }
      }
    } catch { /* corrupt or unreadable → nothing ignored, the shipped default */ }
  }

  /** The window the `auto-compact` fix writes, and whether somebody chose it. */
  autoCompactDefault(): { value: string; chosen: boolean } {
    return this.doc.autoCompactDefault
      ? { value: this.doc.autoCompactDefault, chosen: true }
      : { value: AUTO_COMPACT_SUGGESTED, chosen: false };
  }

  /** Store a chosen window, or `null` to go back to the shipped one. Refuses
   *  in words and stores nothing for a value outside the range. */
  setAutoCompactDefault(raw: unknown): { ok: true } | { ok: false; error: string } {
    if (raw == null || raw === "") {
      delete this.doc.autoCompactDefault;
      this.save();
      return { ok: true };
    }
    const c = cleanAutoCompactDefault(raw);
    if (!c.ok) return c;
    this.doc.autoCompactDefault = c.value;
    this.save();
    return { ok: true };
  }

  ignored(worktree: string): string[] {
    return [...(this.doc.ignored[key(worktree)] ?? [])];
  }

  setIgnored(worktree: string, id: string, ignore: boolean): { ok: true } | { ok: false; error: string } {
    if (!ADVISORY_CHECKS.includes(id)) {
      return { ok: false, error: `"${id}" is not a check that can be ignored — only ${ADVISORY_CHECKS.join(", ")}` };
    }
    const k = key(worktree);
    const cur = new Set(this.doc.ignored[k] ?? []);
    if (ignore) cur.add(id); else cur.delete(id);
    if (cur.size) this.doc.ignored[k] = [...cur]; else delete this.doc.ignored[k];
    this.save();
    return { ok: true };
  }

  optInChoices(worktree: string): Record<string, OptInChoice> {
    return { ...(this.doc.optIns[key(worktree)] ?? {}) };
  }

  /** Store the person's word on one offer, or `null` to take it back. */
  setOptInChoice(worktree: string, id: string, choice: OptInChoice | null): { ok: true } | { ok: false; error: string } {
    if (!OPT_INS.some((d) => d.id === id)) return { ok: false, error: `"${id}" is not an opt-in this desktop knows` };
    if (choice !== null && choice !== "declined" && choice !== "done") {
      return { ok: false, error: `"${String(choice)}" is not a choice — only "declined", "done", or null to clear` };
    }
    const k = key(worktree);
    const cur = { ...(this.doc.optIns[k] ?? {}) };
    if (choice) cur[id] = choice; else delete cur[id];
    if (Object.keys(cur).length) this.doc.optIns[k] = cur; else delete this.doc.optIns[k];
    this.save();
    return { ok: true };
  }

  optInSentTimes(worktree: string): Record<string, number> {
    return { ...(this.doc.optInSent[key(worktree)] ?? {}) };
  }

  /** Remember that an offer's words were sent at `at`. Only ever moves forward;
   *  writes only when it did, so a history event per captured output is free. */
  noteOptInSent(worktree: string, id: string, at: number): void {
    if (!OPT_INS.some((d) => d.id === id) || !Number.isFinite(at) || at <= 0) return;
    const k = key(worktree);
    const cur = this.doc.optInSent[k] ?? {};
    if ((cur[id] ?? 0) >= at) return;
    this.doc.optInSent[k] = { ...cur, [id]: at };
    this.save();
  }

  private save(): void {
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      writeJsonAtomic(this.path, this.doc, { space: 2 });
    } catch { /* a preference that could not be persisted is not worth a crash */ }
  }
}

// The settable singleton, for the reason `contextlimits.ts` gives.
let current: SetupPrefsStore | null = null;

export function setSetupPrefsStore(store: SetupPrefsStore | null): void {
  current = store;
}

/** Boot: the two stores the setup checklist reads (`contextlimits.ts`'s
 *  thresholds and this file's choices), installed in one call from `main.ts`. */
export function installChecklistStores(root: string): void {
  setContextLimitsStore(new ContextLimitsStore(root));
  setSetupPrefsStore(new SetupPrefsStore(root));
}

export function setupPrefsStore(): SetupPrefsStore | null {
  return current;
}

/** The window the checklist writes and passes at — the chosen one, else the shipped one. */
export function autoCompactDefault(): string {
  return current?.autoCompactDefault().value ?? AUTO_COMPACT_SUGGESTED;
}

export function ignoredChecks(worktree: string): string[] {
  return current?.ignored(worktree) ?? [];
}

/**
 * Accept (or stop accepting) an exposure finding: the `{reason, until}` extension
 * of "a person said leave this", but it lives in the watch's own accepts file
 * (`exposure.ts`) because the release gate reads that file, not this store.
 */
export function acceptCheck(worktree: string, req: ComplianceAcceptRequest): { ok: true } | { ok: false; error: string } {
  return setExposureAccept(worktree, req);
}

/** What the person said about each opt-in offer in this repo — empty without a store. */
export function optInChoices(worktree: string): Record<string, OptInChoice> {
  return current?.optInChoices(worktree) ?? {};
}

export function setOptInChoice(worktree: string, id: string, choice: OptInChoice | null): { ok: true } | { ok: false; error: string } {
  if (!current) return { ok: false, error: "no preference store is installed on this host" };
  return current.setOptInChoice(worktree, id, choice);
}

/** When this desktop last saw each offer's words sent in this repo — empty without a store. */
export function optInSentTimes(worktree: string): Record<string, number> {
  return current?.optInSentTimes(worktree) ?? {};
}

export function noteOptInSent(worktree: string, id: string, at: number): void {
  current?.noteOptInSent(worktree, id, at);
}
