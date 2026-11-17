/**
 * Readers for the Setup check's facts. Every file read is injected (`ReadText`), and nothing here
 * imports a daemon singleton, so a test hands in a fake disk and a clock. Each degrades to ABSENT
 * (null / undefined), never to a plausible wrong number.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTO_COMPACT_ENV, autoCompactVerdict, fmtUsd, instructionTotals, projectedEnd, readingPct, resolveAutoCompact, usageReadingTitle,
  type PeriodState, type UsageReading,
  type AutoCompactResolution, type ComplianceCheck, type FindingBackends, type FindingFacts, type InstructionFile, type SkillRow, type UsageInfo,
} from "@waterplane/shared";
import { claudeConfigDir } from "../claudeconfig.js";

export type ReadText = (path: string) => string | null;
export const readFromDisk: ReadText = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };

/** The repo file the `auto-compact` fix writes. */
export const PROJECT_SETTINGS_REL = ".claude/settings.json";

export interface AutoCompactEnv { env?: string | undefined; userDir?: string; read?: ReadText }

/**
 * The `autoCompactWindow` a claude session the daemon spawns in this worktree would see, and where it
 * comes from (moved here from `compliance.ts`). The env layer is THIS daemon's environment, because a
 * spawned PTY starts from `ptyEnv()`; the precedence is `@waterplane/shared`'s `autocompact.ts`. The
 * user layer honours `CLAUDE_CONFIG_DIR` like the CLI.
 */
export function autoCompactFor(worktree: string, o: AutoCompactEnv = {}): AutoCompactResolution {
  const read = o.read ?? readFromDisk;
  const userDir = o.userDir ?? claudeConfigDir();
  const layer = (path: string) => ({ path, text: read(path) });
  return resolveAutoCompact({
    env: "env" in o ? o.env : process.env[AUTO_COMPACT_ENV],
    local: layer(join(worktree, ".claude", "settings.local.json")),
    project: layer(join(worktree, PROJECT_SETTINGS_REL)),
    user: layer(join(userDir, "settings.json")),
  });
}

/** The window THIS DESKTOP decides (env, then the user-level file), with no repo layer: what the machine finding judges. */
export function autoCompactMachineFor(o: AutoCompactEnv = {}): AutoCompactResolution {
  const read = o.read ?? readFromDisk;
  const userDir = o.userDir ?? claudeConfigDir();
  const path = join(userDir, "settings.json");
  const none = { path: "", text: null };
  return resolveAutoCompact({ env: "env" in o ? o.env : process.env[AUTO_COMPACT_ENV], local: none, project: none, user: { path, text: read(path) } });
}

/** The auto-compact fact: where it is decided and how the check judged it. Absent without a row. `chosen` is the person's own default window: the machine reading is judged by the same line as the repo check. */
export function autoCompactFact(res: AutoCompactResolution, row: ComplianceCheck | undefined, machine?: AutoCompactResolution, chosen?: string): FindingFacts["autoCompact"] {
  if (!row) return undefined;
  return {
    source: res.source, status: row.status === "pass" ? "pass" : "warn",
    ...(machine ? { machine: { source: machine.source, status: autoCompactVerdict(machine, chosen).status } } : {}),
  };
}

/** This desktop's always-on characters (user instructions, memory, user skill descriptions) for claude. */
export function globalInstructionsOf(rows: readonly InstructionFile[] | null | undefined, warnChars: number): FindingFacts["globalInstructions"] {
  if (!rows) return undefined;
  return { chars: instructionTotals(rows as InstructionFile[], "claude").always, warnChars };
}

/** Skill rows as the rules read them. A skill with no measured listing keeps no `listingChars`. */
export function skillFactsOf(rows: readonly { kind: string }[]): NonNullable<FindingFacts["skills"]> {
  const out: NonNullable<FindingFacts["skills"]> = [];
  for (const r of rows) {
    if (r.kind !== "skill") continue;
    const s = r as SkillRow;
    const level: "user" | "project" | "plugin" = s.source === "plugin" ? "plugin" : s.source === "project" ? "project" : "user";
    out.push({ id: s.id, level, ...(s.listingChars !== undefined ? { listingChars: s.listingChars } : {}), ...(s.usesEverywhere ? { usesEverywhere: { d30: s.usesEverywhere.d30 } } : {}) });
  }
  return out;
}

const DAY = 86_400_000;

/**
 * The week's pace: does a straight line from the start of the window through today's percent cross
 * 100 before the reset? A reading with no reset time, or less than a day into the week, is no
 * reading (a projection from hours is noise). Absent = null.
 */
export function weekPaceFact(u: Pick<UsageInfo, "weeklyPct" | "weeklyResetAt"> & { checkedAt?: number } | null | undefined, now: number): NonNullable<FindingFacts["usage"]>["week"] {
  if (!u || u.weeklyPct == null || u.weeklyResetAt == null) return null;
  // The percent was read at `checkedAt`: measure the elapsed time there, not at `now`, or a stale reading projects too low.
  const at = typeof u.checkedAt === "number" && u.checkedAt > 0 && u.checkedAt <= now ? u.checkedAt : now;
  const elapsed = 7 * DAY - (u.weeklyResetAt - at);
  if (!(elapsed >= DAY) || elapsed > 7 * DAY) return null;
  const projected = Math.round((u.weeklyPct / elapsed) * 7 * DAY);
  return { runsOut: projected >= 100, text: `The week is ${Math.round(u.weeklyPct)}% used with ${((u.weeklyResetAt - at) / DAY).toFixed(1)} days left; at this pace it reaches about ${projected}% before it resets.` };
}

/**
 * The claude CLI row of this desktop's checklist: found on this machine, signed in. `state` null =
 * the probe could not answer, so there is NO row (never a pass) and the caller says "not checked".
 */
export function claudeCliRow(bin: { bin: string; missing?: true }, state: "in" | "out" | null): ComplianceCheck | null {
  const label = "Claude Code CLI";
  if (bin.missing) return { id: "claude-cli", label, status: "warn", scope: "host", fix: null, detail: "The claude command was not found on this desktop, so sessions cannot start." };
  if (state === null) return null;
  if (state === "out") return { id: "claude-cli", label, status: "warn", scope: "host", fix: null, detail: `${bin.bin} is installed but not signed in.` };
  return { id: "claude-cli", label, status: "pass", scope: "host", fix: null, detail: `${bin.bin} is installed and signed in.` };
}

/** Which backends' records this reading understood: claude's logs. Others have their own store and are named. */
export function backendsOf(infos: readonly { id: string; label: string; kind?: string }[]): FindingBackends {
  const unread = infos
    .filter((i) => i.kind !== "shell" && !i.id.startsWith("claude"))
    .map((i) => ({ id: i.id, why: `${i.label}'s conversations are kept in its own store, which this check does not read` }));
  return { understood: ["claude"], unread };
}

/** `YYYY-MM-DD` of the local day `back` days before `now`. */
function dayKey(now: number, back: number): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - back);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The per-request trend's two spans (the last 7 days, the 7 before), as `statsInsights` cuts them. */
export function trendOf(days: readonly { day: string; turns: number; cost: { total: number } }[], now: number): NonNullable<FindingFacts["trend"]> {
  const sum = (from: string, to: string) => days.filter((d) => d.day > from && d.day <= to).reduce((a, d) => ({ usd: a.usd + d.cost.total, turns: a.turns + d.turns }), { usd: 0, turns: 0 });
  return { cur: sum(dayKey(now, 7), dayKey(now, 0)), prev: sum(dayKey(now, 14), dayKey(now, 7)) };
}

/** The compliance check a repo finding came from: `repo.context-weight` -> `context-weight`, `repo.watch.exposure:x` -> `exposure:x` (an exposure key carries `@ / + #`: `A3:left-pad@1.2.3`, `A1:@scope/pkg`, `D3:ciq:a/p#100+`). Null for a finding no check backs (overlaps, permissions, health). */
export function checkIdOfFinding(id: string): string | null {
  // An exposure key is whatever the watch wrote (spaces, `=`, `$`, long crash groups): taken as the rest, never matched by a class. The accepts store checks it against the real findings.
  const ex = /^repo\.(?:watch|install)\.(exposure:.+)$/s.exec(id);
  if (ex) return ex[1]!;
  const m = /^repo\.(?:(?:watch|install)\.)?([a-z0-9][a-z0-9:._@/+#-]*)$/i.exec(id);
  if (!m) return null;
  const rest = m[1]!;
  if (/^(instruction-overlap|permissions-|health-alert|efficiency-rules)/.test(rest)) return null;
  return rest;
}

type Usage = NonNullable<FindingFacts["usage"]>;

/**
 * The capped dollar periods against their pace (`projectedEnd`, the same straight-line rule the pace
 * push uses). `null` = nothing to judge: no capped period is running, or none has a measured spend
 * and a tenth of its length behind it. Never a pass on a period nobody measured.
 */
export function periodFact(states: readonly PeriodState[], ceilings: readonly { periodId: string; max: number; unit: string }[] | undefined, now: number): Usage["period"] {
  const words: string[] = [];
  let judged = false, firing = false;
  for (const s of states) {
    const cap = ceilings?.find((l) => l.periodId === s.period.id && l.unit === "usd");
    if (!cap || !s.active) continue;
    const end = projectedEnd(s.spentUsd ?? null, s.start, s.resetAt, now);
    if (end == null) continue;
    judged = true;
    if (end > cap.max) { firing = true; words.push(`${s.period.id}: ${fmtUsd(s.spentUsd ?? 0)} spent, at this rate the period ends near ${fmtUsd(end)} against a ${fmtUsd(cap.max)} cap.`); }
  }
  if (!judged) return null;
  return { firing, text: firing ? words.join(" ") : "Every capped period is within its pace." };
}

/** The Copilot source's reading off the usage registry: its hottest figure and the words the chip uses. */
export function copilotFact(readings: readonly UsageReading[] | null | undefined, now: number): Usage["copilot"] {
  const r = readings?.find((x) => x.source === "copilot");
  if (!r) return null;
  const pct = readingPct(r);
  return pct == null ? null : { usedPct: pct, text: usageReadingTitle(r, now) };
}

/** Severe health alerts of the repo's latest scored week; `undefined` when the repo has no series to read. */
export function healthFact(res: { series: { points: readonly { alerts: readonly { level: "warn" | "severe"; subject: string; text: string }[] }[] } | null }): FindingFacts["health"] {
  const pts = res.series?.points;
  const last = pts?.[pts.length - 1];
  if (!last) return undefined;
  return { alerts: last.alerts.map((a) => ({ entry: a.subject, level: a.level, text: a.text })) };
}
