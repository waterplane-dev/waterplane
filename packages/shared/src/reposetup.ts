/**
 * **One repo's set-up page** — the rows, the ticks it opens with and what Go
 * will do, all off `optInCut`, so a count and the list under it are one cut.
 * Pure words and keys: nothing here runs, sends or stores anything.
 */
import { CONFIRM_GATED_FIXES } from "./autocompact.js";
import { isWatchCheck } from "./exposure.js";
import {
  OPT_IN_GROUPS, OPT_INS, optInCut, optInDef, optInKind,
  type OptInAction, type OptInGroup, type OptInKind, type OptInPick, type OptInReport, type OptInRow, type OptInSent,
} from "./optins.js";
import { isSetupFinding, type ComplianceCheck } from "./wire/repo.js";

/** The one row that is not a catalog offer: the one-tap setup-checklist fixes. */
export const SETUP_BASICS = "basics";

export interface SetupRow {
  /** The opt-in id, or `SETUP_BASICS`. */
  key: string;
  kind: OptInKind;
  title: string;
  /** One plain line: what the person gets. All the row draws until a tap opens the rest. */
  short: string;
  pitch: string;
  cost: string;
  /** What the desktop saw; for the basics, what is missing by name. */
  detail: string;
  /** The catalog's own verb and action — a door's button, a tick's work. Absent on the basics. */
  verb?: string;
  action?: OptInAction;
  /** Basics only: the fix ids, each once. */
  fixes?: string[];
  preset?: true;
  /** Already begun here (`optInCut`'s `started`): never ticked in advance. */
  started?: true;
  /** The desktop could not tell whether this is on: never ticked in advance. */
  unknown?: true;
  /** The last send of this offer's words, for the row to say before a tick sends them again. */
  sent?: OptInSent;
  /** What an agent suggested. It ticks nothing by itself; a door has no tick, so it carries none. */
  pick?: Pick<OptInPick, "want" | "why">;
}

export interface SetupRowGroup {
  group: typeof SETUP_BASICS | OptInGroup;
  title: string;
  rows: SetupRow[];
}

export interface SetupRows {
  groups: SetupRowGroup[];
  /** The already-on list: its length is the count, its rows are what the count opens. */
  active: OptInRow[];
}

/** The row for the checklist's one-tap fixes — what `Fix all` covers there (never a watch row, a
 *  confirm-gated fix or a fix that is a catalog offer's own), or `null` when nothing is fixable. */
function basicsRow(checks: readonly ComplianceCheck[]): SetupRow | null {
  const offers = new Set(OPT_INS.map((d) => (d.action.kind === "fix" ? d.action.fix : "")));
  const open = checks.filter((c) => isSetupFinding(c) && !isWatchCheck(c)
    && !!c.fix && !CONFIRM_GATED_FIXES.includes(c.fix) && !offers.has(c.fix));
  if (!open.length) return null;
  return {
    key: SETUP_BASICS,
    kind: "free",
    title: "Fix the basics",
    short: "Small changes a phone-driven repo needs.",
    pitch: "What a repo driven from a phone needs, each put right by one small change on the desktop.",
    cost: "Spends no tokens.",
    detail: open.map((c) => c.label).join(", "),
    fixes: [...new Set(open.map((c) => c.fix as string))],
  };
}

/** Every row the page draws, grouped in order (an empty group is absent), and what is already on. */
export function setupRows(report: Pick<OptInReport, "rows" | "picks">, checks: readonly ComplianceCheck[]): SetupRows {
  const cut = optInCut(report.rows);
  const started = new Set(cut.started.map((r) => r.id));
  const byId = new Map([...cut.offered, ...cut.started].map((r) => [r.id, r]));
  const picks = new Map((report.picks ?? []).map((p) => [p.id, p]));
  const rowOf = (r: OptInRow): SetupRow => {
    const d = optInDef(r.id)!;
    // Downloads already on with a rule that leaves the file out: the patterns are the person's, so it is a door.
    const ownRule = d.action.kind === "download" && !!r.partial;
    const kind = ownRule ? "door" : optInKind(d);
    const p = kind === "door" ? undefined : picks.get(r.id);
    return {
      key: d.id, kind, title: d.title, short: d.short, pitch: d.pitch, cost: d.cost, detail: r.detail, verb: ownRule ? "open downloads" : d.verb, action: d.action,
      ...(d.preset ? { preset: true as const } : {}),
      ...(started.has(r.id) ? { started: true as const } : {}),
      ...(r.state === "unknown" ? { unknown: true as const } : {}),
      ...(r.sent ? { sent: r.sent } : {}),
      ...(p ? { pick: { want: p.want, why: p.why } } : {}),
    };
  };
  const basics = basicsRow(checks);
  const groups: SetupRowGroup[] = basics ? [{ group: SETUP_BASICS, title: "Basics", rows: [basics] }] : [];
  for (const g of OPT_IN_GROUPS) {
    const rows = OPT_INS.filter((d) => d.group === g.id && byId.has(d.id)).map((d) => rowOf(byId.get(d.id)!));
    if (rows.length) groups.push({ group: g.id, title: g.title, rows });
  }
  return { groups: tickGroupsFirst(groups), active: cut.active };
}

/** The page's order: a group that holds a tick row (free or paid, by KIND, so nothing jumps after a tick or
 *  Go) comes before one holding only doors, and inside a group the doors come after the tick rows. Stable
 *  otherwise: the catalog's own order decides between equals. */
export function tickGroupsFirst(groups: readonly SetupRowGroup[]): SetupRowGroup[] {
  const isDoor = (r: SetupRow) => r.kind === "door";
  const placed = groups.map((g) => ({ ...g, rows: [...g.rows.filter((r) => !isDoor(r)), ...g.rows.filter(isDoor)] }));
  return [...placed.filter((g) => g.rows.some((r) => !isDoor(r))), ...placed.filter((g) => !g.rows.some((r) => !isDoor(r)))];
}

/** The keys ticked when the page opens: the basics and the presets, free, never begun here and read as off. */
export function setupDefaultTicks(rows: readonly SetupRow[]): string[] {
  return rows.filter((r) => r.kind === "free" && !r.started && !r.unknown && (r.key === SETUP_BASICS || !!r.preset)).map((r) => r.key);
}

export interface SetupPlan {
  /** Run right away on Go. */
  free: SetupRow[];
  /** Each becomes its own work item on Go. */
  paid: SetupRow[];
  /** Exactly `free` plus `paid`. */
  n: number;
}

/** What Go does with these ticks. A key with no drawn row, and a door, is not a tick. */
export function setupPlan(rows: readonly SetupRow[], ticks: Iterable<string>): SetupPlan {
  const on = new Set(ticks);
  const free = rows.filter((r) => r.kind === "free" && on.has(r.key));
  const paid = rows.filter((r) => r.kind === "paid" && on.has(r.key));
  return { free, paid, n: free.length + paid.length };
}
