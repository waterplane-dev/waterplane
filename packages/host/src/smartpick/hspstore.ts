/** A slice of smartpick.ts — moved whole from smartpick.ts, see docs/notes/smartpick-architecture.md (host). */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BudgetWaiver, IntentTrigger, SmartPickCandidate, SmartPickSummary } from "@waterplane/shared";
import { fingerprint } from "@waterplane/shared";
import { hostStateDir } from "../branddirs.js";
import { MAX_MERGES, MAX_PASSES, MAX_REFUSED } from "./hspknobs.js";
import { readJsonGuarded, writeJsonAtomic } from "../jsonstore.js";

// ── What is on disk ─────────────────────────────────────────────────────────

/**
 * One pass, as it is kept.
 *
 * `fp` is the fingerprint the pass was recorded AGAINST and never leaves the
 * host: for an applied pass it is the state the apply LEFT BEHIND (so the
 * confirming tick reads "nothing changed" and spends nothing), and for every
 * failure it is the state the pass STARTED on (so the next tick does not retry
 * the same doomed pass and the item fires as it was). `summary` is the wire
 * object verbatim, which is what keeps the strip's sentence and the record from
 * ever being two different accounts of one pass.
 */
interface SmartPickRecord {
  fp: string;
  summary: SmartPickSummary;
}

/**
 * One merge, as it is kept — and this is the object `undo` is made of.
 *
 * `prevArchived` is per member and is not always `false`: a member may have been
 * set aside by hand BEFORE the merge folded it, and an undo that could only ever
 * un-archive would hand a row back in a state its owner never chose.
 *
 * `state` is what makes the apply crash-safe. It is written `applying` BEFORE
 * anything is mutated, so a daemon that dies mid-apply comes back to a record
 * that says what it was in the middle of, and `finishApplying()` completes it.
 * Every step of an apply is idempotent by construction (`post` returns the
 * existing row for an id it already has, `edit({archived:true})` on an archived
 * row writes the same value), so completing it twice is completing it once.
 */
export interface MergeRecord {
  mergedId: string;
  passId: string;
  cwd: string;
  at: number;
  /**
   * `refused` is a merge that never happened: the store would not take the
   * merged row (`post` refused it — the host is already holding its maximum
   * number of intents), so nothing was archived and nothing was rewired. It is
   * kept, and kept SEPARATE from `undone`, because the two are opposite facts
   * about the same record — one is a person saying no, the other is this host
   * saying it had no room — and because leaving it `applying` is what made
   * `store.applying()` a to-do list that could never be finished: boot retried
   * the same refused post for ever, and `reindex()` went on telling both
   * originals they had been merged into a row that does not exist.
   */
  state: "applying" | "applied" | "undone" | "refused";
  ids: string[];
  text: string;
  why: string;
  order: number;
  resume?: boolean;
  handOrdered?: boolean;
  /**
   * The CLOCK the members all waited on, when they had one — kept whole, as the
   * trigger, because this record is what a boot replay rebuilds the merged row
   * from and a replay that posted an untimed row would have rescheduled
   * somebody's work to "as soon as the repo is free".
   *
   * `atKey` is kept too, as the equality the merge was ALLOWED on — a record
   * that says which clock it folded, in the form the rule was decided in.
   *
   * `holdForHost` is recorded BESIDE all three and independently of them. It
   * was once inside this spread, so a merge of two rows that held and had no
   * clock — which is precisely what *drop the clock* leaves behind, the hold
   * being kept on purpose — wrote a row with no hold, and it fired while
   * another repo's item was mid-turn. It is the other half of *wait until it's
   * free*, nothing else on the row carries it, and a boot replay reads this
   * record and no rows.
   */
  trigger?: IntentTrigger;
  holdForHost?: boolean;
  /**
   * The members' close-when-done answer (`Intent.closeWhenDone`), folded so
   * KEEPING OPEN wins: any member that said `false` makes it `false`, every
   * member saying `true` makes it `true`, anything else is absent (follow the
   * global). A merged row must never close a session one of its members asked
   * to keep. On the record for the boot replay, like the hold.
   */
  closeWhenDone?: boolean;
  /**
   * The budget waiver (`Intent.pastBudget`) every live member had in force,
   * with the EARLIEST `until` among them — a merge never stretches a waiver
   * past the window any of its members was let past in. A MIXED group (some
   * waived, some not) is refused whole and said out loud, like the hold: the
   * merged row would either spend past the budget on words nobody let past it
   * or silently wait on a budget a person had already answered. On the record
   * so a boot replay posts the identical row; a legacy `true` here is dropped
   * by `cleanIntentRow` on the post, which only makes the row wait.
   */
  pastBudget?: BudgetWaiver;
  atKey?: string;
  /** The merged row's own one-line name, for the notification and the chain
   *  trigger's `title` snapshot. */
  title: string;
  prevOrders: Record<string, number>;
  prevArchived: Record<string, boolean>;
  /** Rows chained behind a member, re-pointed at the merged row. `from` is what
   *  they were chained to, so the undo can put the edge back exactly. */
  rewired: { id: string; from: string; fromTitle?: string }[];
  undoneAt?: number;
  /** Anything an undo could NOT put back, in words. A chain that has already
   *  settled cannot be re-pointed, and a silence about that would be this
   *  feature's one unaccounted-for edit. */
  undoNotes?: string[];
}

/** A merge a person undid. The hash is over the MEMBERS' texts, so editing one
 *  of them makes the group a genuinely new proposal and it is offered again. */
interface RefusedMerge {
  ids: string[];
  textHash: string;
}

interface SmartPickFile {
  version: 1;
  passes: Record<string, SmartPickRecord[]>;
  merges: Record<string, MergeRecord>;
  refused: Record<string, RefusedMerge[]>;
}

const emptyFile = (): SmartPickFile => ({ version: 1, passes: {}, merges: {}, refused: {} });

/**
 * `<STATE_DIR>/smartpick.json` — the passes, the merges and the refusals.
 *
 * A HOST store keyed by worktree realpath, never a file written into a repo:
 * `contextlimits.ts`'s arrangement and its reason. A preference and a record of
 * what machinery did on this desktop are not source, and `setupwatch.ts`'s rule
 * is that nothing here writes into somebody's checkout.
 *
 * tmp+rename on every write, which in this repo is not a nicety: the per-repo
 * backlog file it replaces was a bare `writeFileSync`, and half a JSON document
 * where a backlog used to be is the recorded failure that rule came from.
 */
export class SmartPickStore {
  private data: SmartPickFile = emptyFile();
  private path: string;
  /** id → the merge it belongs to, both ways. Rebuilt on every write rather
   *  than walked per row: `backlog.list()` asks this once per item. */
  private index = new Map<string, { mergedFrom?: string[]; mergedInto?: string }>();

  constructor(private root: string) {
    this.path = join(hostStateDir(root), "smartpick.json");
    try {
      const raw: unknown = readJsonGuarded<any>(this.path, null);
      if (raw && typeof raw === "object") {
        const f = raw as Partial<SmartPickFile>;
        this.data = {
          version: 1,
          passes: f.passes && typeof f.passes === "object" ? f.passes : {},
          merges: f.merges && typeof f.merges === "object" ? f.merges : {},
          refused: f.refused && typeof f.refused === "object" ? f.refused : {},
        };
      }
    } catch { /* fresh host — an unreadable record is no record, never a crash */ }
    this.reindex();
  }

  lastPass(cwd: string): SmartPickRecord | undefined { return this.data.passes[cwd]?.[0]; }

  summaries(): Record<string, SmartPickSummary> {
    const out: Record<string, SmartPickSummary> = {};
    for (const [cwd, rows] of Object.entries(this.data.passes)) if (rows[0]) out[cwd] = rows[0].summary;
    return out;
  }

  recordPass(cwd: string, rec: SmartPickRecord): void {
    const rows = this.data.passes[cwd] ?? [];
    this.data.passes[cwd] = [rec, ...rows].slice(0, MAX_PASSES);
    this.persist();
  }

  merge(id: string): MergeRecord | undefined { return this.data.merges[id]; }
  /** Every merge this store is still in the middle of applying — boot's list. */
  applying(): MergeRecord[] { return Object.values(this.data.merges).filter((m) => m.state === "applying"); }

  putMerge(rec: MergeRecord): void {
    this.data.merges[rec.mergedId] = rec;
    this.trimMerges();
    this.persist();
  }

  /** Oldest-first eviction down to `MAX_MERGES`, skipping anything still
   *  `applying`. See the constant for what an eviction costs. */
  private trimMerges(): void {
    const rows = Object.values(this.data.merges);
    if (rows.length <= MAX_MERGES) return;
    const evictable = rows.filter((m) => m.state !== "applying").sort((a, b) => a.at - b.at);
    for (const m of evictable.slice(0, rows.length - MAX_MERGES)) delete this.data.merges[m.mergedId];
  }

  /** The id-sets a person has undone, as `cleanSmartPick` wants them — but only
   *  the ones whose members still say what they said. A member edited since is
   *  a new proposal and the sanitiser is not told to refuse it. */
  refusedFor(cwd: string, cands: readonly SmartPickCandidate[]): string[][] {
    const by = new Map(cands.map((c) => [c.id, c.text]));
    const out: string[][] = [];
    for (const r of this.data.refused[cwd] ?? []) {
      if (!r.ids.every((id) => by.has(id))) continue;
      if (memberTextHash(r.ids.map((id) => [id, by.get(id)!])) !== r.textHash) continue;
      out.push([...r.ids]);
    }
    return out;
  }

  addRefused(cwd: string, ids: string[], pairs: [string, string][]): void {
    const rows = this.data.refused[cwd] ?? [];
    const key = [...ids].sort().join(",");
    const rec: RefusedMerge = { ids: [...ids].sort(), textHash: memberTextHash(pairs) };
    this.data.refused[cwd] = [rec, ...rows.filter((r) => r.ids.join(",") !== key)].slice(0, MAX_REFUSED);
    this.persist();
  }

  /** What a row says about itself in the backlog list — the two chips. */
  rowFacts(id: string): { mergedFrom?: string[]; mergedInto?: string } | undefined {
    return this.index.get(id);
  }

  private reindex(): void {
    this.index = new Map();
    for (const m of Object.values(this.data.merges)) {
      // An undone merge is not a fact about any row any more: the originals are
      // back with their own words and the merged row is gone. Nor is a REFUSED
      // one, which never touched a row in the first place — indexing it made
      // both originals say "merged into mg…" about a row the store had just
      // declined to write.
      if (m.state === "undone" || m.state === "refused") continue;
      this.index.set(m.mergedId, { mergedFrom: [...m.ids] });
      for (const id of m.ids) this.index.set(id, { mergedInto: m.mergedId });
    }
  }

  private persist(): void {
    this.reindex();
    try {
      mkdirSync(hostStateDir(this.root), { recursive: true });
      writeJsonAtomic(this.path, this.data, { space: 2 });
    } catch { /* best-effort — the in-memory copy still serves this boot */ }
  }
}

/** A stable hash over a merge's members AND their words. Both halves matter:
 *  the same ids with one text edited is a different proposal. */
function memberTextHash(pairs: readonly (readonly [string, string])[]): string {
  return fingerprint(JSON.stringify([...pairs].sort((a, b) => (a[0] < b[0] ? -1 : 1))));
}