/**
 * **"Runs on its own, no clock"** — the Automation sheet's foot, derived.
 *
 * The sheet's cards are clocks. What else this desktop starts by itself is
 * managed somewhere else, and nothing listed it together: backlog auto, a
 * repo's auto-download rule, the week-end burn, a peer desktop's jobs. Each
 * line here is ONE sentence and ONE door to where that thing is managed —
 * nothing is edited from this sheet and nothing applies itself.
 *
 * Rules every line keeps:
 * - **A count is a filter.** "2 rows will start when free" opens exactly those
 *   two (`ids` on the door), and the two are `nextFireIdsOf`'s answer — the
 *   backlog's own `▶ next` predicate, never a copy of the edge. Zero is a
 *   sentence with no number.
 * - **A source the phone has not read is ABSENT**, never a guessed line: an
 *   auto-download rule not yet answered, a week-end burn read that failed or
 *   that the host says is unavailable.
 * - Per repo when the sheet is cut to one repo (`repoDir`), else across repos.
 *
 * The health watch has no line: the phone receives no fact saying it runs
 * (only the series it writes), so a sentence about it would be a guess.
 */
import type { AutoPullConfig, BacklogItem, SessionInfo, WeekBurnStatus } from "@waterplane/shared";
import { isPeerPosted, peerOfOrigin } from "@waterplane/shared";
import { nextFireIdsOf } from "./backlogFilter/nextFire.ts";
import { hiddenByArchive } from "./backlogFilter/rowFilter.ts";

export type AutomationDoor =
  /** The backlog, on one repo (`null` = the sheet's own choice), cut to `ids`. */
  | { kind: "backlog"; repoDir: string | null; ids?: string[]; label?: string }
  | { kind: "pull"; repoDir: string }
  | { kind: "weekburn" };

export interface AutomationLine {
  key: string;
  icon: "backlog" | "pull" | "weekburn" | "peer";
  text: string;
  /** The door's words, a lower-case verb. */
  verb: string;
  door: AutomationDoor;
}

export interface AutomationInput {
  /** The repo the sheet is cut to, or null for every repo. */
  repoDir: string | null;
  items: readonly BacklogItem[];
  auto: boolean;
  sessions: readonly SessionInfo[];
  now: number;
  repoName: (dir: string) => string;
  /** The repo's auto-download rule as read; undefined = not read (no line). */
  pull?: AutoPullConfig;
  /** `GET /api/weekburn`; null = not read (no line). */
  weekburn?: WeekBurnStatus | null;
  /** How an instant is written (`fmtWhen` on the phone). */
  when: (t: number) => string;
}

const rows = (n: number) => `${n} row${n === 1 ? "" : "s"}`;

/** Every repo the backlog holds a row for, in first-seen order. */
function dirsOf(items: readonly BacklogItem[]): string[] {
  return [...new Set(items.map((it) => it.repoDir))];
}

/** One repo's non-archived rows, in the order the host runs them. */
function repoRows(items: readonly BacklogItem[], dir: string): BacklogItem[] {
  return items.filter((it) => it.repoDir === dir && !hiddenByArchive(it));
}

/** The ids backlog auto starts next in one repo — the `▶ next` set. */
export function autoNextIds(o: Pick<AutomationInput, "items" | "auto" | "sessions" | "now">, dir: string): string[] {
  const live = new Set(o.sessions.filter((s) => s.running && s.cwd === dir).map((s) => s.id));
  return [...nextFireIdsOf(repoRows(o.items, dir), live, o.auto, o.now)];
}

export function backlogLines(o: AutomationInput): AutomationLine[] {
  const open = (repoDir: string | null): AutomationDoor => ({ kind: "backlog", repoDir });
  if (!o.auto) {
    return [{
      key: "backlog", icon: "backlog", verb: "open the backlog", door: open(o.repoDir),
      text: "Backlog auto is off: no backlog row starts by itself.",
    }];
  }
  const dirs = o.repoDir ? [o.repoDir] : dirsOf(o.items);
  const per = dirs.map((dir) => ({ dir, ids: autoNextIds(o, dir) })).filter((x) => x.ids.length > 0);
  if (!per.length) {
    return [{
      key: "backlog", icon: "backlog", verb: "open the backlog", door: open(o.repoDir),
      text: o.repoDir
        ? `Backlog auto is on; nothing in ${o.repoName(o.repoDir)} is waiting to start.`
        : "Backlog auto is on; no backlog row is waiting to start.",
    }];
  }
  return per.map(({ dir, ids }, i) => {
    const n = ids.length;
    const name = o.repoName(dir);
    const what = `${rows(n)} in ${name} will start when free`;
    return {
      key: `backlog:${dir}`, icon: "backlog" as const,
      verb: n === 1 ? "see it" : `see those ${n}`,
      door: { kind: "backlog" as const, repoDir: dir, ids, label: `the ${rows(n)} auto starts next in ${name}` },
      text: i === 0 ? `Backlog auto is on: ${what}.` : `${what[0].toUpperCase()}${what.slice(1)}.`,
    };
  });
}

/** The repo's auto-download rule; absent until the host has answered. */
export function pullLine(o: Pick<AutomationInput, "repoDir" | "pull" | "repoName">): AutomationLine | null {
  if (!o.repoDir || !o.pull) return null;
  const name = o.repoName(o.repoDir);
  const where = o.pull.scope === "repo" ? "anywhere in the repo" : "in its outbox";
  return {
    key: "pull", icon: "pull", verb: "download rules", door: { kind: "pull", repoDir: o.repoDir },
    text: o.pull.enabled
      ? `Auto-download is on for ${name}: new files ${where}${o.pull.builds ? " and build artifacts" : ""} come to this phone by themselves.`
      : `Auto-download is off for ${name}.`,
  };
}

/** The week-end burn; absent when unread or when the host says it cannot run. */
export function weekBurnLine(o: Pick<AutomationInput, "repoDir" | "weekburn" | "repoName" | "when">): AutomationLine | null {
  const w = o.weekburn;
  if (!w || !w.available) return null;
  const line = (text: string): AutomationLine => ({ key: "weekburn", icon: "weekburn", verb: "open the burn", door: { kind: "weekburn" }, text });
  const picked = w.pickedThisWeek ? w.prefs.repos : [];
  const start = w.plan ? `, from ${o.when(w.plan.startAt)}` : "";
  if (o.repoDir) {
    const name = o.repoName(o.repoDir);
    if (w.running.some((r) => r.repoDir === o.repoDir)) return line(`The week-end burn is posting small one-commit items in ${name} now.`);
    if (!picked.includes(o.repoDir)) return null;
    return line(`The week-end burn picked ${name} this week: small one-commit items post there by themselves${start}.`);
  }
  if (w.running.length) return line(`The week-end burn is posting small one-commit items in ${w.running.length === 1 ? o.repoName(w.running[0].repoDir) : `${w.running.length} repos`} now.`);
  if (!picked.length) return line("No repo is picked for this week's week-end burn.");
  return line(`The week-end burn picked ${picked.length === 1 ? o.repoName(picked[0]) : `${picked.length} repos`} this week${start}.`);
}

/** Jobs a peer desktop posted here that have not started, one line per repo. */
export function peerLines(o: Pick<AutomationInput, "repoDir" | "items" | "repoName">): AutomationLine[] {
  const waiting = o.items.filter((it) => isPeerPosted(it) && it.status === "queued" && !hiddenByArchive(it)
    && (!o.repoDir || it.repoDir === o.repoDir));
  return dirsOf(waiting).map((dir) => {
    const ids = waiting.filter((it) => it.repoDir === dir).map((it) => it.id);
    const peers = [...new Set(waiting.filter((it) => it.repoDir === dir).map((it) => peerOfOrigin(it.origin)!))];
    const n = ids.length;
    const name = o.repoName(dir);
    const from = peers.length === 1 ? `peer ${peers[0]}` : `${peers.length} peer desktops`;
    return {
      key: `peer:${dir}`, icon: "peer" as const,
      verb: n === 1 ? "see it" : `see those ${n}`,
      door: { kind: "backlog" as const, repoDir: dir, ids, label: `the ${n} from a peer desktop in ${name}` },
      text: `${n === 1 ? "1 job" : `${n} jobs`} from ${from} ${n === 1 ? "waits" : "wait"} in ${name}'s backlog.`,
    };
  });
}

/** The whole foot, in the order the sheet draws it. */
export function automationLines(o: AutomationInput): AutomationLine[] {
  const out = backlogLines(o);
  const p = pullLine(o);
  if (p) out.push(p);
  const w = weekBurnLine(o);
  if (w) out.push(w);
  out.push(...peerLines(o));
  return out;
}
