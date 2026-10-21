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
 * Only this machine's chats are seen, so it is a floor, never GitHub's count; a request with no
 * multiplier is counted as a request and left out of the premium sum, never guessed.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

export interface CopilotRequest { ts: number; model: string; mult: number | null; credits: number | null }

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
    out.push({ ts, model: d.model ?? id, mult: d.mult, credits: d.credits });
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

  async read(now: number = Date.now()): Promise<CopilotLocalDoc> {
    const { start, month } = monthStart(now);
    const [sku, logs] = [await readSku(this.userDir), await sessionLogs(this.userDir)];
    const all: CopilotRequest[] = [];
    const seen = new Set<string>();
    for (const f of logs) {
      seen.add(f);
      let st;
      try { st = await stat(f); } catch { continue; }
      if (st.mtimeMs < start) continue; // nothing appended this month
      const hit = this.files.get(f);
      if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) { all.push(...hit.reqs); continue; }
      let reqs: CopilotRequest[] = [];
      try { reqs = replayRequests(await readFile(f, "utf8")); } catch { /* unreadable: skipped */ }
      this.files.set(f, { size: st.size, mtime: st.mtimeMs, reqs });
      all.push(...reqs);
    }
    for (const f of this.files.keys()) if (!seen.has(f)) this.files.delete(f);
    const t = tallyMonth(all, now);
    return {
      sku, plan: planWords(sku), ...t, month, logs: logs.length,
      why: logs.length ? null : "No Copilot Chat sessions found in this VS Code's storage.",
    };
  }
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
