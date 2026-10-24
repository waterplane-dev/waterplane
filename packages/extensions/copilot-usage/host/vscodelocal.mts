/**
 * Copilot's plan and this month's requests, read off VS Code's own files on this machine — no
 * sign-in, no network, nothing spawned. The GitHub quota (`ghquota.mts`, and the VS Code
 * extension's `copilotquota.ts`) stays the one figure that knows the limit; this is what can be
 * known without it, and says so. One implementation for both readers: the VS Code extension's
 * Copilot row bundles it from here, and this extension's host half puts it on its status line.
 *
 * - The plan: `copilotSku` in VS Code's `state.vscdb` (Copilot's experiment filter writes it).
 *   Read with `node:sqlite` when the runtime has it; otherwise absent.
 * - The requests: Copilot Chat's session logs, `workspaceStorage/<id>/chatSessions/*.jsonl` and
 *   `globalStorage/emptyWindowChatSessions/*.jsonl`. Each is a mutation log (kind 0 = snapshot,
 *   1 = set at path, 2 = push at path, truncating to `i` first, 3 = delete); replaying it gives
 *   `requests[]`, each with a `timestamp` and a `result.details` such as
 *   `"Claude Opus 4.7 • 7.5x"` — the premium multiplier Copilot itself showed under the answer.
 *
 * - The tokens: the same answers' `result.metadata.promptTokens` / `outputTokens`, where Copilot
 *   recorded them, folded by `copilotLedger` into the token-stats screen's generic ledger.
 *
 * Only this machine's chats are seen, so it is a floor, never GitHub's count; a request with no
 * multiplier is counted as a request and left out of the premium sum, never guessed.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { localDayKey, type BackendTokensDoc } from "@waterplane/shared";

export interface CopilotModelCount { model: string; requests: number; premium: number }

export interface CopilotLocalDoc {
  /** `free_limited_copilot` etc. as VS Code stored it; null = not found or not readable here. */
  sku: string | null;
  /** The plan in words (`Copilot Free`), or the sku itself when this version does not know it. */
  plan: string | null;
  /** The month counted, `2026-10` (UTC: Copilot's premium allowance resets on the 1st, 00:00 UTC). */
  month: string;
  requests: number;
  /** Sum of the multipliers shown, over the requests that showed one. */
  premium: number;
  /** Requests that showed no multiplier (cancelled, failed, or an older Copilot) — not in `premium`. */
  unpriced: number;
  /** Requests priced in credits instead (`• 0.3 credits`), summed apart: a different unit. */
  credits: number;
  byModel: CopilotModelCount[];
  /** Session logs read; 0 with `why` = nothing found where VS Code keeps them. */
  logs: number;
  why: string | null;
}

/** `prompt` / `output`: the token counts Copilot recorded on the answer (`result.metadata.promptTokens` /
 *  `outputTokens`); null where it recorded none (an older Copilot, a cancelled or failed answer). */
export interface CopilotRequest { ts: number; model: string; mult: number | null; credits: number | null; prompt: number | null; output: number | null }

const KNOWN_PLANS: Record<string, string> = {
  free_limited_copilot: "Copilot Free",
  free_educational: "Copilot Free (education)",
};

export function planWords(sku: string | null): string | null {
  if (!sku) return null;
  if (KNOWN_PLANS[sku]) return KNOWN_PLANS[sku];
  if (/enterprise/i.test(sku)) return "Copilot Enterprise";
  if (/business/i.test(sku)) return "Copilot Business";
  return sku;
}

/** `"Claude Opus 4.7 • 7.5x"` → model + multiplier; `"… • 0.3 credits"` → credits. */
export function parseDetails(details: unknown): { model: string | null; mult: number | null; credits: number | null } {
  if (typeof details !== "string") return { model: null, mult: null, credits: null };
  const [name, price] = details.split(" • ");
  const m = /^\s*(\d+(?:\.\d+)?)x\s*$/.exec(price ?? "");
  const c = /^\s*(\d+(?:\.\d+)?)\s*credits?\s*$/i.exec(price ?? "");
  return { model: name?.trim() || null, mult: m ? Number(m[1]) : null, credits: c ? Number(c[1]) : null };
}

type Obj = Record<string | number, unknown>;

function at(root: unknown, k: (string | number)[]): unknown {
  let o = root;
  for (const p of k) { if (o == null || typeof o !== "object") return undefined; o = (o as Obj)[p]; }
  return o;
}

const tokenCount = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/** Replays one chat session log into its requests. A line that does not parse is skipped. */
export function replayRequests(text: string): CopilotRequest[] {
  let state: unknown = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let e: { kind?: number; k?: (string | number)[]; v?: unknown; i?: number };
    try { e = JSON.parse(line); } catch { continue; }
    if (e.kind === 0) { state = e.v; continue; }
    const k = Array.isArray(e.k) ? e.k : null;
    if (!k || !k.length) continue;
    if (e.kind === 1 || e.kind === 3) {
      const parent = at(state, k.slice(0, -1));
      if (parent && typeof parent === "object") {
        if (e.kind === 1) (parent as Obj)[k[k.length - 1]] = e.v;
        else delete (parent as Obj)[k[k.length - 1]];
      }
    } else if (e.kind === 2) {
      const arr = at(state, k);
      if (!Array.isArray(arr)) continue;
      if (typeof e.i === "number") arr.length = Math.min(arr.length, e.i);
      if (Array.isArray(e.v)) arr.push(...e.v);
    }
  }
  const reqs = at(state, ["requests"]);
  if (!Array.isArray(reqs)) return [];
  const out: CopilotRequest[] = [];
  for (const r of reqs) {
    if (!r || typeof r !== "object") continue;
    const ts = Number((r as Obj).timestamp);
    if (!Number.isFinite(ts)) continue;
    const d = parseDetails(at(r, ["result", "details"]));
    const id = typeof (r as Obj).modelId === "string" ? String((r as Obj).modelId).replace(/^copilot\//, "") : "unknown model";
    out.push({ ts, model: d.model ?? id, mult: d.mult, credits: d.credits, prompt: tokenCount(at(r, ["result", "metadata", "promptTokens"])), output: tokenCount(at(r, ["result", "metadata", "outputTokens"])) });
  }
  return out;
}

/** The first instant of `now`'s UTC month, and its `YYYY-MM`. */
export function monthStart(now: number): { start: number; month: string } {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return { start, month: new Date(start).toISOString().slice(0, 7) };
}

export function tallyMonth(reqs: CopilotRequest[], now: number): Omit<CopilotLocalDoc, "sku" | "plan" | "logs" | "why"> {
  const { start, month } = monthStart(now);
  const by = new Map<string, CopilotModelCount>();
  let requests = 0, premium = 0, unpriced = 0, credits = 0;
  for (const r of reqs) {
    if (r.ts < start || r.ts > now) continue;
    requests++;
    const m = by.get(r.model) ?? { model: r.model, requests: 0, premium: 0 };
    m.requests++;
    if (r.mult != null) { premium += r.mult; m.premium += r.mult; }
    else if (r.credits != null) credits += r.credits;
    else unpriced++;
    by.set(r.model, m);
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    month, requests, premium: round(premium), unpriced, credits: round(credits),
    byModel: [...by.values()].map((m) => ({ ...m, premium: round(m.premium) })).sort((a, b) => b.premium - a.premium || b.requests - a.requests),
  };
}

/** VS Code's `User` directory, from an extension's `globalStorageUri` (`User/globalStorage/<id>`). */
export function userDirOf(globalStorageFsPath: string): string {
  return path.dirname(path.dirname(globalStorageFsPath));
}

/**
 * Where VS Code (stable, then Insiders) keeps its `User` directory on this OS, for a reader that
 * is not inside VS Code (the desktop host). Only directories that exist; empty = no VS Code here.
 */
export function vscodeUserDirs(home: string = os.homedir(), platform: string = process.platform, appData = process.env.APPDATA): string[] {
  const base = platform === "darwin" ? path.join(home, "Library", "Application Support")
    : platform === "win32" ? appData ?? path.join(home, "AppData", "Roaming")
    : process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return ["Code", "Code - Insiders"].map((n) => path.join(base, n, "User")).filter((d) => existsSync(d));
}

async function sessionLogs(userDir: string): Promise<string[]> {
  const dirs: string[] = [path.join(userDir, "globalStorage", "emptyWindowChatSessions")];
  try {
    for (const w of await readdir(path.join(userDir, "workspaceStorage"))) dirs.push(path.join(userDir, "workspaceStorage", w, "chatSessions"));
  } catch { /* no workspaceStorage: nothing there */ }
  const out: string[] = [];
  for (const d of dirs) {
    try { for (const f of await readdir(d)) if (f.endsWith(".jsonl")) out.push(path.join(d, f)); } catch { /* absent */ }
  }
  return out;
}

export async function readSku(userDir: string): Promise<string | null> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(userDir, "globalStorage", "state.vscdb"), { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("extensionsAssignmentFilterProvider.copilotSku") as { value?: unknown } | undefined;
      const v = row?.value instanceof Uint8Array ? Buffer.from(row.value).toString("utf8") : row?.value;
      return typeof v === "string" && /^[\w.-]{1,64}$/.test(v) ? v : null;
    } finally { db.close(); }
  } catch { return null; }
}

/** Per-file requests, kept across reads; a file is re-read only when its size or mtime moved. */
export class CopilotLocalReader {
  private files = new Map<string, { size: number; mtime: number; reqs: CopilotRequest[] }>();

  constructor(private userDir: string) {}

  /** The per-file cache, for a reader that lives one scan (the panel's worker) to keep across runs. */
  cached(): Record<string, { size: number; mtime: number; reqs: CopilotRequest[] }> {
    return Object.fromEntries(this.files);
  }

  /** Seed the cache from `cached()`; an entry not in that shape is dropped (re-read), never trusted. */
  seed(entries: unknown): void {
    if (!entries || typeof entries !== "object") return;
    for (const [f, e] of Object.entries(entries as Record<string, unknown>)) {
      const v = e as { size?: unknown; mtime?: unknown; reqs?: unknown } | null;
      if (v && typeof v.size === "number" && typeof v.mtime === "number" && Array.isArray(v.reqs)) this.files.set(f, { size: v.size, mtime: v.mtime, reqs: v.reqs as CopilotRequest[] });
    }
  }

  async read(now: number = Date.now()): Promise<CopilotLocalDoc> {
    const { start, month } = monthStart(now);
    const [sku, { logs, perFile }] = [await readSku(this.userDir), await this.scan(start)];
    const t = tallyMonth(perFile.flat(), now);
    return {
      sku, plan: planWords(sku), ...t, month, logs: logs.length,
      why: logs.length ? null : "No Copilot Chat sessions found in this VS Code's storage.",
    };
  }

  /** Every session log's tokens, as the token-stats screen's generic ledger (`copilotLedger`). */
  async ledger(now: number = Date.now()): Promise<BackendTokensDoc> {
    const { logs, perFile } = await this.scan(0);
    if (!logs.length) return { available: false, reason: "No Copilot Chat sessions found in this VS Code's storage." };
    return copilotLedger(perFile, now);
  }

  /** The requests of each log written to since `since` (one array per file); files that went are forgotten. */
  private async scan(since: number): Promise<{ logs: string[]; perFile: CopilotRequest[][] }> {
    const logs = await sessionLogs(this.userDir);
    const perFile: CopilotRequest[][] = [];
    const seen = new Set<string>();
    for (const f of logs) {
      seen.add(f);
      let st;
      try { st = await stat(f); } catch { continue; }
      if (st.mtimeMs < since) continue; // nothing appended since
      const hit = this.files.get(f);
      if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) { perFile.push(hit.reqs); continue; }
      let reqs: CopilotRequest[] = [];
      try { reqs = replayRequests(await readFile(f, "utf8")); } catch { /* unreadable: skipped */ }
      this.files.set(f, { size: st.size, mtime: st.mtimeMs, reqs });
      perFile.push(reqs);
    }
    for (const f of this.files.keys()) if (!seen.has(f)) this.files.delete(f);
    return { logs, perFile };
  }
}

/** The tokens of a request, as the ledger's kinds; null when Copilot recorded neither count. */
function kindsOf(r: CopilotRequest): Record<string, number> | null {
  if (r.prompt == null && r.output == null) return null;
  return { ...(r.prompt != null ? { prompt: r.prompt } : {}), ...(r.output != null ? { output: r.output } : {}) };
}

function addKinds(into: Record<string, number>, k: Record<string, number>): void {
  for (const [n, v] of Object.entries(k)) into[n] = (into[n] ?? 0) + v;
}

/**
 * Copilot Chat's own token counts (`result.metadata.promptTokens` / `outputTokens`), as the generic
 * `BackendTokensDoc` the token-stats screen draws for any backend. Two kinds, Copilot's words, never
 * folded: `prompt` is the whole prompt as Copilot sent it (it records no cache split, so none is
 * claimed) and `output` the answer. A turn is a request that recorded a count; a request without one
 * is not a turn and not a 0. The premium multipliers shown under the answers ride as the unit, per
 * day, over every request that showed one. Days are local-zone, as the Claude ledger's are.
 */
export function copilotLedger(perFile: readonly (readonly CopilotRequest[])[], now: number): BackendTokensDoc {
  const totals: Record<string, number> = {};
  let turns = 0, sessions = 0;
  let firstAt: number | null = null, lastAt: number | null = null;
  const days = new Map<string, { kinds: Record<string, number>; turns: number; byModel: Map<string, { kinds: Record<string, number>; turns: number }> }>();
  const models = new Map<string, { kinds: Record<string, number>; turns: number }>();
  const premium: Record<string, number> = {};
  for (const reqs of perFile) {
    let counted = false;
    for (const r of reqs) {
      if (r.ts > now) continue;
      const day = localDayKey(r.ts);
      if (r.mult != null) premium[day] = Math.round(((premium[day] ?? 0) + r.mult) * 100) / 100;
      const k = kindsOf(r);
      if (!k) continue;
      counted = true;
      turns++;
      addKinds(totals, k);
      firstAt = firstAt == null ? r.ts : Math.min(firstAt, r.ts);
      lastAt = lastAt == null ? r.ts : Math.max(lastAt, r.ts);
      const d = days.get(day) ?? { kinds: {}, turns: 0, byModel: new Map() };
      addKinds(d.kinds, k);
      d.turns++;
      const dm = d.byModel.get(r.model) ?? { kinds: {}, turns: 0 };
      addKinds(dm.kinds, k);
      dm.turns++;
      d.byModel.set(r.model, dm);
      days.set(day, d);
      const m = models.get(r.model) ?? { kinds: {}, turns: 0 };
      addKinds(m.kinds, k);
      m.turns++;
      models.set(r.model, m);
    }
    if (counted) sessions++;
  }
  const sum = (k: Record<string, number>) => Object.values(k).reduce((a, b) => a + b, 0);
  const bySize = <T extends { kinds: Record<string, number> }>(a: T, b: T) => sum(b.kinds) - sum(a.kinds);
  return {
    available: true,
    totals: { kinds: totals, turns },
    days: [...days].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, d]) => ({
      day, kinds: d.kinds, turns: d.turns,
      byModel: [...d.byModel].map(([key, v]) => ({ key, ...v })).sort(bySize),
    })),
    models: [...models].map(([key, v]) => ({ key, label: key, ...v })).sort(bySize),
    sessions,
    ...(Object.keys(premium).length ? { unit: { name: "premium requests", perDay: premium } } : {}),
    firstAt, lastAt, scannedAt: now,
  };
}

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ""));

/** The row's description: `Copilot Free · 12.5 premium requests this month here`. */
export function localWords(d: CopilotLocalDoc, where = "here"): string {
  const used = [
    d.premium > 0 ? `${num(d.premium)} premium request${d.premium === 1 ? "" : "s"}` : null,
    d.credits > 0 ? `${num(d.credits)} credit${d.credits === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" + ");
  const month = used || (d.requests ? `${d.requests} request${d.requests === 1 ? "" : "s"}` : "no requests");
  return `${d.plan ?? "plan unknown"} · ${month} this month ${where}`;
}

/** The tooltip's local block, one paragraph per line. */
export function localLines(d: CopilotLocalDoc): string[] {
  const lines = [`Plan: ${d.plan ?? "not found in VS Code's storage"}${d.plan && d.sku && d.plan !== d.sku ? ` (${d.sku})` : ""}.`];
  if (d.why) return [...lines, d.why];
  lines.push(`This month (${d.month}, from the 1st, UTC), on this machine: ${d.requests} request${d.requests === 1 ? "" : "s"}`
    + `${d.premium > 0 ? `, ${num(d.premium)} premium` : ""}${d.credits > 0 ? `, ${num(d.credits)} credits` : ""}.`);
  for (const m of d.byModel.slice(0, 5)) lines.push(`${m.model}: ${m.requests} request${m.requests === 1 ? "" : "s"}${m.premium > 0 ? `, ${num(m.premium)} premium` : ""}`);
  if (d.unpriced) lines.push(`${d.unpriced} request${d.unpriced === 1 ? "" : "s"} showed no multiplier (cancelled, failed or older), so not in the premium sum.`);
  lines.push("Counted from this VS Code's Copilot Chat logs. Other machines, github.com and the Copilot CLI are not seen, and only GitHub knows the limit.");
  return lines;
}
