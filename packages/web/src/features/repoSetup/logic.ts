/**
 * The set-up page's pure half: which rows are ticked, what became of each, the order Go works in and
 * every sentence the page says of its own. The rows, the default ticks and the plan are
 * `shared/reposetup.ts`'s. Pinned by `logic.test.mjs`.
 */
import { optInMarkedIds, setupDefaultTicks, setupPlan } from "@waterplane/shared";
import type {
  ComplianceCheck, ComplianceFixResult, OptInAction, OptInRow, OptInSent, SetupPlan, SetupRow, SetupRowGroup, SetupRows,
} from "@waterplane/shared";
import { optInSentWords } from "../../optInSeed.ts";
import type { OutboxEntry } from "../../outbox";

/** What became of one row. Only `failed` with `retry` may ever run again from here. */
export type Outcome =
  | { s: "waiting" }
  | { s: "running" }
  /** `fixes`: the fix ids a checklist row's "done" covers. `after`: a post's, as in `queued`. */
  | { s: "done"; text: string; fixes?: string[]; after?: number }
  /** Posted under `ackId`, the desktop has not confirmed it. `after`: the desktop's time of the send
   *  before this one (0 = none), so a newer one in the report is known to be this post. */
  | { s: "queued"; ackId: string; after: number; rule?: true }
  /** `ackId`: the refused queue row a retry replaces. */
  | { s: "failed"; text: string; retry: boolean; ackId?: string };

export type Outcomes = Readonly<Record<string, Outcome>>;

export interface RepoRun {
  /** The ticks the person changed, and only those: everything else follows the page's own ticks. */
  ticks: Readonly<Record<string, boolean>>;
  outcomes: Outcomes;
  /** The rows as Go saw them, so a row that landed stays to say so; cleared when the page is left. */
  kept: readonly SetupRowGroup[];
  /** What the desktop said about a fix of several rows at once, which names no row. */
  said: readonly string[];
  busy: boolean;
}

export const NO_RUN: RepoRun = { ticks: {}, outcomes: {}, kept: [], said: [], busy: false };

export const flatRows = (groups: readonly SetupRowGroup[]): SetupRow[] => groups.flatMap((g) => g.rows);

/** A post that came to nothing, by the desktop's own word: its row may be ticked again. */
const CAME_TO_NOTHING: readonly OptInSent["status"][] = ["failed", "canceled", "ended"];

/** Does this row's outcome still speak for it? A "done" of the basics covers the fixes it ran, and no
 *  later one; a post's, until the desktop says that very post failed or was cancelled. */
export function standing(row: SetupRow, outcomes: Outcomes): Outcome | null {
  const o = outcomes[row.key];
  if (!o) return null;
  if (o.s === "done" && o.fixes && row.fixes && row.fixes.some((f) => !o.fixes!.includes(f))) return null;
  if (o.s === "done" && o.after !== undefined && row.sent && row.sent.at > o.after && CAME_TO_NOTHING.includes(row.sent.status)) return null;
  return o;
}

/** The outcomes that speak for the rows on the page: what the footer counts. */
export function shownOutcomes(rows: readonly SetupRow[], outcomes: Outcomes): Outcomes {
  return Object.fromEntries(rows.flatMap((r) => { const o = standing(r, outcomes); return o ? [[r.key, o]] : []; }));
}

/** The opt-ins whose words are in this phone's queue for this repo (a reload forgets outcomes, never the queue). */
export function queuedOptIns(entries: readonly Pick<OutboxEntry, "cwd" | "text" | "op">[], worktreePath: string): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    const op = e.op as { prompt?: unknown; entry?: { action?: { repoDir?: unknown; text?: unknown } } } | undefined;
    const at = op?.entry?.action?.repoDir ?? e.cwd;
    if (at !== worktreePath) continue;
    for (const t of [e.text, op?.prompt, op?.entry?.action?.text]) {
      if (typeof t === "string") for (const id of optInMarkedIds(t)) out.add(id);
    }
  }
  return out;
}

/** May this row carry a tick? A door never; a row with an outcome, or words already in the queue, no more. */
export function tickable(row: SetupRow, outcomes: Outcomes, queued: ReadonlySet<string>): boolean {
  return row.kind !== "door" && !standing(row, outcomes) && !queued.has(row.key);
}

/** The ticked keys: the page's own ticks with the person's changes over them. */
export function tickedKeys(rows: readonly SetupRow[], run: Pick<RepoRun, "ticks" | "outcomes">, queued: ReadonlySet<string>): Set<string> {
  const mine = new Set(setupDefaultTicks(rows));
  return new Set(rows
    .filter((r) => tickable(r, run.outcomes, queued) && (run.ticks[r.key] ?? mine.has(r.key)))
    .map((r) => r.key));
}

/** What Go would do now: one plan for the ticks, the button's count, the sentence and the run. */
export function planNow(rows: readonly SetupRow[], run: Pick<RepoRun, "ticks" | "outcomes">, queued: ReadonlySet<string>): SetupPlan {
  return setupPlan(rows, tickedKeys(rows, run, queued));
}

/** `use these suggestions`: the ticks of exactly the rows a suggestion names. */
export function withPicks(ticks: RepoRun["ticks"], rows: readonly SetupRow[]): RepoRun["ticks"] {
  const out = { ...ticks };
  for (const r of rows) if (r.pick) out[r.key] = r.pick.want;
  return out;
}

/** The live page plus the rows Go ran that it no longer lists (a fix that landed is "on" at once). */
export function pageRows(live: SetupRows, run: Pick<RepoRun, "kept" | "outcomes">): SetupRows {
  if (!run.kept.length) return live;
  const now = new Map(flatRows(live.groups).map((r) => [r.key, r]));
  const groups: SetupRowGroup[] = [];
  const drawn = new Set<string>();
  const order = [...run.kept, ...live.groups.filter((g) => !run.kept.some((k) => k.group === g.group))];
  for (const g of order) {
    const own = live.groups.find((x) => x.group === g.group);
    const rows: SetupRow[] = [];
    for (const r of [...g.rows, ...(own?.rows ?? [])]) {
      const row = now.get(r.key) ?? (run.outcomes[r.key] ? r : null);
      if (row && !drawn.has(r.key)) { drawn.add(r.key); rows.push(row); }
    }
    if (rows.length) groups.push({ ...g, rows });
  }
  return { groups, active: live.active.filter((r: OptInRow) => !drawn.has(r.id)) };
}

// ── Go ────────────────────────────────────────────────────────────────────

export type Step =
  | { kind: "fix"; rows: SetupRow[]; fixes: string[] }
  | { kind: "download"; row: SetupRow }
  | { kind: "post"; row: SetupRow };

/** The order Go works in: every fix in one call, the download rule, then one post per paid row. */
export function goSteps(plan: Pick<SetupPlan, "free" | "paid">): Step[] {
  const fixing = plan.free.filter((r) => fixIds(r).length > 0);
  return [
    ...(fixing.length ? [{ kind: "fix" as const, rows: fixing, fixes: [...new Set(fixing.flatMap(fixIds))] }] : []),
    ...plan.free.filter((r) => r.action?.kind === "download").map((row) => ({ kind: "download" as const, row })),
    ...plan.paid.map((row) => ({ kind: "post" as const, row })),
  ];
}

function fixIds(row: SetupRow): string[] {
  return row.fixes ?? (row.action?.kind === "fix" ? [row.action.fix] : []);
}

/** Per-row outcomes of the one fix call; `lost` = it had no answer, so `error` is not the desktop's. The desktop's notes name no row: with one row they are its
 *  words, with several they are `said` once and each row gets its own verdict. */
export function fixOutcomes(rows: readonly SetupRow[], res: Pick<ComplianceFixResult, "ok" | "applied" | "notes" | "error" | "report">, lost = false):
  { outcomes: Record<string, Outcome>; said: string[] } {
  const notes = res.notes ?? [];
  const applied = new Set(res.applied ?? []);
  const open = new Set((res.report?.checks ?? []).filter((c: ComplianceCheck) => c.status !== "pass" && c.fix).map((c) => c.fix as string));
  const alone = rows.length === 1;
  const outcomes: Record<string, Outcome> = {};
  for (const r of rows) {
    const ids = fixIds(r);
    // Landed: the desktop applied it, or its re-run checklist no longer asks for it. An offer's own fix
    // has no checklist row to read, so only "applied" counts for one.
    const left = ids.filter((f) => !applied.has(f) && !(r.fixes && res.ok && res.report && !open.has(f)));
    if (!left.length) {
      outcomes[r.key] = { s: "done", text: alone && notes.length ? notes.join(" · ") : "done", ...(r.fixes ? { fixes: ids } : {}) };
    } else {
      const some = ids.length > 1 && left.length < ids.length ? `${ids.length - left.length} of ${ids.length} done. ` : "";
      const why = res.error ? (lost ? `no answer from the desktop (${res.error})` : `The desktop said: ${res.error}`) : alone && notes.length ? notes.join(" · ") : "the desktop changed nothing here";
      outcomes[r.key] = { s: "failed", text: `${some}${why}`, retry: true };
    }
  }
  return { outcomes, said: alone ? [] : notes };
}

/** A posted row and what the queue says became of it (`fireFate`); null = nothing new. */
export function settled(o: Outcome, fate: { kind: string; reason?: string } | null): Outcome | null {
  if (o.s !== "queued" || !fate || fate.kind === "pending") return null;
  if (fate.kind === "acked") return { s: "done", text: o.rule ? "weekly schedule saved" : "in the backlog", after: o.after };
  if (fate.kind === "refused") return { s: "failed", text: fate.reason ? `The desktop said: ${fate.reason}` : "the desktop refused it", retry: true, ackId: o.ackId };
  // Nobody recorded whether it arrived: running it again from here could post it twice.
  return { s: "failed", text: `${fate.reason ? `not confirmed: ${fate.reason}` : "taken out of the send queue"}. Activity has the rest.`, retry: false };
}

/** The ticks once Go has taken these rows: nothing paid stays ticked, so a paid row whose outcome is reset
 *  later (its item was cancelled or ended) comes back unticked and waits for a fresh tap. */
export function untickPaid(ticks: RepoRun["ticks"], taken: readonly Pick<SetupRow, "key" | "kind">[]): RepoRun["ticks"] {
  const out = { ...ticks };
  for (const r of taken) if (r.kind === "paid") out[r.key] = false;
  return out;
}

/** Leaving the page: a failure is forgotten, so its row is a plain tick again. Kept: what landed or is
 *  under way, and a refused post, whose queue row a retry has to replace. */
export function afterLeave(run: RepoRun): RepoRun {
  return {
    ...run, kept: [], said: [],
    outcomes: Object.fromEntries(Object.entries(run.outcomes).filter(([, o]) => o.s !== "failed" || o.ackId)),
  };
}

// ── words ─────────────────────────────────────────────────────────────────

/** Beside a paid row's tick. */
export function paidWords(a: OptInAction | undefined): string {
  return a?.kind === "schedule" ? "weekly agent session" : "costs an agent session";
}

export function sentLine(sent: OptInSent): string {
  return `${optInSentWords(sent)} A tick sends it again.`;
}

/** A row whose words wait in this phone's queue, with no outcome of its own. */
export const IN_QUEUE_WORDS = "already in the send queue; Activity has it";

export function outcomeWords(o: Outcome): string {
  switch (o.s) {
    case "waiting": return "waiting its turn";
    case "running": return "working…";
    case "queued": return "queued, the desktop has not confirmed it yet";
    default: return o.text;
  }
}

/** The longest names clause that is still one line at 412 px and 1x (the footer is ~60 characters wide). */
export const NAMES_MAX = 52;

/** What runs now: the names when they fit one line, else the count. */
export function freeWords(free: readonly Pick<SetupRow, "title">[]): string {
  const names = `Runs now, free: ${free.map((r) => r.title).join(", ")}.`;
  if (names.length <= NAMES_MAX) return names;
  return `${free.length} ${free.length === 1 ? "runs" : "run"} now, free.`;
}

/** The line above the button: what runs now, and when the paid ones will. */
export function planWords(plan: SetupPlan, auto: boolean): string {
  const items = plan.paid.filter((r) => r.action?.kind !== "schedule").length;
  const rules = plan.paid.length - items;
  const out: string[] = [];
  if (plan.free.length) out.push(freeWords(plan.free));
  if (items) {
    const go = items === 1
      ? (auto ? "it starts by itself when this repo is free" : "auto is off, so it waits there until you start it")
      : (auto ? "they start by themselves, one at a time" : "auto is off, so they wait there until you start them");
    out.push(`${items} ${items === 1 ? "goes" : "go"} to the backlog: ${go}.`);
  }
  if (rules) out.push(`${rules} ${rules === 1 ? "becomes a weekly schedule" : "become weekly schedules"}.`);
  return out.join(" ");
}

export function goLabel(n: number): string {
  return n === 1 ? "Set up this one" : `Set up these ${n}`;
}

export interface FooterView {
  /** Drawn above the keys. */
  line: string;
  /** The Go button's words, or null when there is nothing to do (the line says why). */
  go: string | null;
  /** The way out. */
  leave: "skip" | "done";
}

export function footerView(plan: SetupPlan, run: Pick<RepoRun, "busy" | "outcomes">, o: { auto: boolean; tickableN: number; unread: boolean }): FooterView {
  const ran = Object.keys(run.outcomes).length > 0;
  if (run.busy) return { line: workingWords(run.outcomes), go: null, leave: "done" };
  if (plan.n > 0) return { line: planWords(plan, o.auto), go: goLabel(plan.n), leave: ran ? "done" : "skip" };
  if (ran) return { line: resultWords(run.outcomes), go: null, leave: "done" };
  if (o.unread) return { line: "Nothing is read yet, so there is nothing to tick.", go: null, leave: "skip" };
  return { line: o.tickableN ? "Nothing ticked, so there is nothing to set up." : "Nothing here to tick.", go: null, leave: "skip" };
}

function workingWords(outcomes: Outcomes): string {
  const all = Object.values(outcomes);
  const left = all.filter((o) => o.s === "waiting" || o.s === "running").length;
  return `Setting up: ${left} to go.`;
}

/** After Go: each kind counted, so a failure is never hidden in a "done". */
export function resultWords(outcomes: Outcomes): string {
  const n = (s: Outcome["s"]) => Object.values(outcomes).filter((o) => o.s === s).length;
  return [
    n("done") ? `${n("done")} done` : "",
    n("queued") ? `${n("queued")} queued` : "",
    n("failed") ? `${n("failed")} did not work` : "",
  ].filter(Boolean).join(", ") + ".";
}

/** The receipt of `use these suggestions`. */
export function picksWords(rows: readonly SetupRow[]): string {
  const on = rows.filter((r) => r.pick?.want).length;
  const off = rows.filter((r) => r.pick && !r.pick.want).length;
  return `suggestions used: ${[on ? `${on} ticked` : "", off ? `${off} unticked` : ""].filter(Boolean).join(", ")}`;
}

export function activeHead(n: number): string {
  return `${n} already on`;
}

export function skipWords(repoName: string): string {
  return `Not now. It stays in ${repoName}'s ⋯ menu › set up this repo.`;
}

/** May the page open by itself: never in the demo, on a passive (child's) device even while it is unlocked,
 *  with no link, or a second time in one page load. */
export function mayOffer(o: { demo: boolean; passive: boolean; online: boolean; opened: boolean }): boolean {
  return o.online && !o.demo && !o.passive && !o.opened;
}
