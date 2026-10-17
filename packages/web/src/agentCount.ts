/**
 * **How many agents are running on the desktop at once** — every session whose
 * main loop is mid-turn, plus every subagent running under any session — and
 * the person's two marks for "that is a lot" and "that is too many".
 *
 * Why a count at all: one prompt that fans out to thirty agents spends one
 * account's usage thirty ways at once and loads the desktop with thirty CLI
 * processes, and nothing on screen added that up — the session rows each say
 * "3 agents", and the sum was left to the reader.
 *
 * The strip that draws it (`LocalRtBar`) is mounted beside `App`, so it cannot
 * read `App`'s session list: `sessionTabs.ts`'s arrangement — ONE writer
 * (`noteAgentCount`, from `core/sessions/useAgentCountBridge.ts`), one
 * subscription. The pure half (the sum, the marks, the level) is node-tested in
 * `agentCount.test.mjs`.
 *
 * **It observes, it never steers**: nothing here stops an agent or refuses a
 * launch. The marks colour the number and raise one toast on the way UP.
 */
import { useEffect, useRef, useState } from "react";
import { LS, lsJson, lsSetJson } from "./storage.ts";

/** What one session contributes: is its own turn running, and how many
 *  subagents run under it. The bridge decides both off `sessionFacts`. */
export interface AgentRow { working: boolean; agents: number }

export interface AgentCount {
  /** Sessions whose main loop is mid-turn. */
  sessions: number;
  /** Subagents running under any session. */
  subagents: number;
  total: number;
}

export function countAgents(rows: readonly AgentRow[]): AgentCount {
  let sessions = 0;
  let subagents = 0;
  for (const r of rows) {
    if (r.working) sessions++;
    subagents += Math.max(0, r.agents | 0);
  }
  return { sessions, subagents, total: sessions + subagents };
}

/** The two marks: above `warn` is amber, above `alarm` is red. `0` is off. */
export interface AgentWarnCfg { warn: number; alarm: number }

export const AGENT_WARN_DEFAULT: AgentWarnCfg = { warn: 10, alarm: 30 };

/** The steps a mark moves through in Settings; `0` (off) sits past the top. */
export const AGENT_WARN_STEPS = [3, 5, 8, 10, 15, 20, 25, 30, 40, 50, 75, 100] as const;

function cleanMark(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 999 ? v : fallback;
}

/** A stored value off any shape an older build or a hand edit left behind;
 *  garbage falls back to the default per mark, never to "off". */
export function cleanAgentWarn(raw: unknown): AgentWarnCfg {
  const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return { warn: cleanMark(o.warn, AGENT_WARN_DEFAULT.warn), alarm: cleanMark(o.alarm, AGENT_WARN_DEFAULT.alarm) };
}

export type AgentLevel = "ok" | "warn" | "alarm";

/** "More than N": a count AT the mark is still fine. */
export function agentLevel(total: number, cfg: AgentWarnCfg): AgentLevel {
  if (cfg.alarm > 0 && total > cfg.alarm) return "alarm";
  if (cfg.warn > 0 && total > cfg.warn) return "warn";
  return "ok";
}

const RANK: Record<AgentLevel, number> = { ok: 0, warn: 1, alarm: 2 };

/** Did the level go UP? Only a rise is worth a toast; falling back is quiet. */
export function levelRose(prev: AgentLevel, next: AgentLevel): boolean {
  return RANK[next] > RANK[prev];
}

/** The count in words, split — a total is never said without its parts. */
export function agentCountText(c: AgentCount): string {
  const s = `${c.sessions} session${c.sessions === 1 ? "" : "s"} working`;
  const a = `${c.subagents} subagent${c.subagents === 1 ? "" : "s"}`;
  return `${c.total} agent${c.total === 1 ? "" : "s"} running at once on the desktop: ${s} + ${a}`;
}

/** The toast for a rise into `level`. */
export function agentWarnText(c: AgentCount, level: AgentLevel, cfg: AgentWarnCfg): string {
  const mark = level === "alarm" ? cfg.alarm : cfg.warn;
  return `${agentCountText(c)} — more than your ${level === "alarm" ? "limit" : "warning"} of ${mark}`;
}

export function loadAgentWarn(): AgentWarnCfg {
  return cleanAgentWarn(lsJson<unknown>(LS.agentWarn, null));
}

export function saveAgentWarn(v: AgentWarnCfg): void {
  lsSetJson(LS.agentWarn, cleanAgentWarn(v));
}

// ── History and dismissal (pure) ────────────────────────────────────────────

/** One reading of the count, for the graph on *This desktop*. */
export interface AgentSample { at: number; total: number; sessions: number; subagents: number }

/** A reading every this-many ms while the app runs, plus one on every change. */
export const AGENT_SAMPLE_MS = 10_000;
/** An hour of readings at the steady cadence. Memory only: a reload starts again. */
export const AGENT_RING = 360;

/** The ring with `s` appended, oldest dropped past `cap`. */
export function pushAgentSample(ring: readonly AgentSample[], s: AgentSample, cap = AGENT_RING): AgentSample[] {
  const next = [...ring, s];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * One value per reading for the graph — with a `null` wherever the phone was
 * not watching (two readings further apart than three ticks: the page slept).
 * A break is drawn as a break, never bridged: an hour in a pocket is not an
 * hour at a steady count.
 */
export function agentSeries(ring: readonly AgentSample[], pick: (s: AgentSample) => number = (s) => s.total): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < ring.length; i++) {
    if (i > 0 && ring[i].at - ring[i - 1].at > AGENT_SAMPLE_MS * 3) out.push(null);
    out.push(pick(ring[i]));
  }
  return out;
}

/**
 * Is the strip shown BECAUSE of the count? Past a mark, unless the person
 * closed it at this level or higher. A rise past the level it was closed at
 * brings it back — closing the amber strip is not closing the red one.
 */
export function stripForced(level: AgentLevel, dismissed: AgentLevel | null): boolean {
  if (level === "ok") return false;
  return dismissed == null || RANK[level] > RANK[dismissed];
}

/** One session's share of the count, for the list on *This desktop*. */
export interface AgentSessionRow {
  id: string;
  label: string;
  repo: string;
  /** Its own turn is running. */
  working: boolean;
  /** What each subagent under it is doing (`SessionAgent.what`). */
  agents: { what: string; model?: string; startedAt: number }[];
}

/** Busiest first: most agents, then a working main loop, then by name. */
export function orderAgentRows(rows: readonly AgentSessionRow[]): AgentSessionRow[] {
  const n = (r: AgentSessionRow) => r.agents.length + (r.working ? 1 : 0);
  return rows.filter((r) => n(r) > 0).sort((a, b) => n(b) - n(a) || a.label.localeCompare(b.label));
}

// ── The store ───────────────────────────────────────────────────────────────

export interface AgentSnapshot {
  /** Null until `App` has published a session list — absent, never a 0. */
  count: AgentCount | null;
  rows: readonly AgentSessionRow[];
  samples: readonly AgentSample[];
  level: AgentLevel;
  /** The level the person closed the forced strip at; null when not closed. */
  dismissed: AgentLevel | null;
}

let snap: AgentSnapshot = { count: null, rows: [], samples: [], level: "ok", dismissed: null };
const listeners = new Set<(s: AgentSnapshot) => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

function emit(next: AgentSnapshot): void {
  snap = next;
  for (const fn of listeners) fn(snap);
}

function sampleNow(): void {
  const c = snap.count;
  if (!c) return;
  emit({ ...snap, samples: pushAgentSample(snap.samples, { at: Date.now(), ...c }) });
}

/**
 * The one writer: the count, the rows behind it and its level. A change of the
 * count is a reading of its own; the steady tick adds one every
 * `AGENT_SAMPLE_MS` so a flat stretch is drawn as flat, not as two points.
 * Falling back to `ok` forgets a close, so the next warning shows again.
 */
export function noteAgentCount(c: AgentCount, rows: readonly AgentSessionRow[], level: AgentLevel): void {
  const changed = !snap.count || snap.count.total !== c.total || snap.count.sessions !== c.sessions || snap.count.subagents !== c.subagents;
  emit({ ...snap, count: c, rows, level, dismissed: level === "ok" ? null : snap.dismissed });
  if (changed) sampleNow();
  if (!ticker && typeof window !== "undefined") ticker = setInterval(sampleNow, AGENT_SAMPLE_MS);
}

/** The forced strip's ×: hidden until the count climbs past a higher mark. */
export function dismissAgentStrip(): void {
  emit({ ...snap, dismissed: snap.level });
}

/** `useLink`'s shape: select, compare by identity, re-render only on a change. */
export function useAgents<T>(select: (s: AgentSnapshot) => T): T {
  const sel = useRef(select);
  sel.current = select;
  const [v, setV] = useState<T>(() => select(snap));
  useEffect(() => {
    const fn = (s: AgentSnapshot) => {
      const next = sel.current(s);
      setV((prev) => (Object.is(prev, next) ? prev : next));
    };
    listeners.add(fn);
    fn(snap);
    return () => { listeners.delete(fn); };
  }, []);
  return v;
}

export const useAgentCount = (): AgentCount | null => useAgents((s) => s.count);
export const useAgentForced = (): boolean => useAgents((s) => stripForced(s.level, s.dismissed));
