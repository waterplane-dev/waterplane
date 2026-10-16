/**
 * The demo's `/api/*` — the reads the phone makes over HTTP rather than the
 * socket. Everything not here is 404 with a sentence (never a bare status:
 * the phone prints the body where it can).
 *
 * `/api/repos` is answered although plan §1's HTTP list does not name it: the
 * repo list IS the demo's first screen, and it travels over HTTP.
 *
 * `/api/health` stays in index.ts — it belongs to the disconnect fault.
 */
import { ASK_RULE_BACKENDS, PRICES_AS_OF, SUGGESTED_ASK_RULES, filterGalleryRows, zeroCost, zeroTotals, type GalleryQuery, type GalleryRow, type TokenStatsDoc } from "@waterplane/shared";
import { demoCostWindow, demoTokenStats, demoTokenWindows, demoUsageLog, parseWindowSpecs } from "./ledger.ts";
import { demoRepoHealth } from "./repohealth.ts";
import { demoHealthIndex } from "./healthindex.ts";
import { findSession, screenLines, sessions } from "./desk.ts";
import { NOT_IN_DEMO } from "./verdict.ts";
import type { DemoModel } from "./model.ts";
import type { DemoHttpRequest, DemoHttpResponse } from "./types.ts";

export const ONBOARD_NOT_IN_DEMO = "Not in the demo — this builds a real app on your desktop.";

const json = (v: unknown, status = 200): DemoHttpResponse =>
  ({ status, contentType: "application/json", body: JSON.stringify(v) });

const repoTargets = (m: DemoModel): { id?: unknown; outboxSeenAt?: unknown }[] =>
  (m.repos ?? []).filter((r): r is { id?: unknown } => !!r && typeof r === "object");

const MEDIA_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".heif", ".svg", ".avif", ".tif", ".tiff", ".ico", ".jfif", ".mp4", ".webm", ".mov", ".m4v", ".ogv", ".mkv"]);

/** `TokenStatsDoc` for a desktop with no conversation logs: every total zero, no days. */
export function emptyTokenStats(now: number): TokenStatsDoc {
  const t = () => zeroTotals();
  const c = () => zeroCost();
  return {
    totals: t(), days: [], hours: [], hoursFrom: null,
    hourOfDay: Array.from({ length: 24 }, (_, hour) => ({ hour, ...t(), cost: c() })),
    models: [], repos: [], conversations: 0, subagents: t(), subagentLogs: 0,
    cost: c(), subagentCost: c(), unpriced: t(), fastTurns: 0,
    coldStarts: { count: 0, tok: 0 }, top: [],
    pricesAsOf: PRICES_AS_OF, firstAt: null, lastAt: null, scannedAt: now, logs: 0, reread: 0,
  };
}

/** A header's file name as one plain path segment, or null. */
function safeName(raw: string | undefined): string | null {
  if (!raw) return null;
  let n = raw;
  try { n = decodeURIComponent(raw); } catch { /* keep it as sent */ }
  n = n.split(/[\\/]/).pop()?.trim() ?? "";
  return n && n !== "." && n !== ".." ? n : null;
}

/** The host's `kind=image`, pictures and clips (`files.ts` `kindExt`), for the demo's own fixtures.
 *  The app's `docKind.isImageKind` is out of reach here: DemoHost imports only shared. */
const isDemoImage = (p: string): boolean => /\.(png|jpe?g|gif|webp|svg|avif|bmp|mp4|webm|mov)$/i.test(p);

export function demoHttp(m: DemoModel, now: number, req: DemoHttpRequest): DemoHttpResponse {
  const { method, path } = req;
  const q = req.query ?? {};

  if (path === "/api/repos" && method === "GET") return json({ targets: m.repos ?? [] });

  const repo = /^\/api\/repos\/([^/]+)\/(artifacts|inbox)(?:\/(seen))?$/.exec(path);
  if (repo) {
    const [, rawId, kind, seen] = repo;
    const id = decodeURIComponent(rawId);
    const target = repoTargets(m).find((r) => r.id === id);
    if (!target) return json({ error: "That is not one of the demo's repos." }, 404);
    if (seen && method === "POST") {
      if (kind === "artifacts") target.outboxSeenAt = now;
      return json({ ok: true });
    }
    if (!seen && method === "GET") {
      // The real host cuts the listing by kind, age and name (`files.ts`); so does this one, or a
      // lit "docs" or "4h" toggle in the demo sits over a grid it did not change.
      if (kind === "artifacts") {
        const since = Number(q.since) || undefined;
        const want: GalleryQuery = { kind: q.kind === "image" || q.kind === "doc" ? q.kind : "all", since, query: q.q };
        return json({ files: filterGalleryRows((m.gallery?.[id] ?? []) as GalleryRow[], want, isDemoImage, now), truncated: false });
      }
      return json({ files: m.inbox?.[id] ?? [] });
    }
    // An upload (the annotator's marked picture, a file from the phone): listed in the inbox under
    // the name the phone asked for — the queue predicted that path and the prompt already names it.
    // No bytes are kept here; the page that sent them shows them (`demo/media.ts` `rememberDemoUpload`).
    if (!seen && kind === "inbox" && method === "POST") {
      const asked = safeName(req.headers?.["x-file-name"]);
      const list = ((m.inbox ??= {})[id] ??= []) as { name?: unknown }[];
      const name = asked ?? `upload-${list.length + 1}.png`;
      const entry = { name, relPath: `.claude/inbox/${name}`, size: req.bodyBytes ?? 0, mtime: now, ctime: now };
      const at = list.findIndex((f) => f.name === name);
      if (at >= 0) list.splice(at, 1);
      list.unshift(entry);
      return json({ saved: [entry], skipped: [] });
    }
  }

  // The gallery's "all repos" tab. The real host's walk, over what the model keeps: every repo's
  // outbox (`m.gallery`), `q` a case-insensitive substring of the file NAME, `since` seconds back, `kind` image|doc by
  // extension (image covers video, as the host's does), `repos` a csv of ids, newest first.
  if (path === "/api/search" && method === "GET") {
    const query = (q.q ?? "").trim().toLowerCase();
    const kind = q.kind ?? "";
    const allowed = q.repos ? new Set(q.repos.split(",").map((s) => s.trim()).filter(Boolean)) : null;
    const limit = Math.min(Number(q.limit || 0) || 300, 1000);
    const cutoff = Number(q.since || 0) ? now - Number(q.since) * 1000 : 0;
    const hits: Record<string, unknown>[] = [];
    for (const r of repoTargets(m) as { id?: string; repoName?: string; branch?: string }[]) {
      if (typeof r.id !== "string" || (allowed && !allowed.has(r.id))) continue;
      for (const f of (m.gallery?.[r.id] ?? []) as { name: string; mtime: number }[]) {
        const ext = /\.[^.]+$/.exec(f.name)?.[0].toLowerCase() ?? "";
        if (f.mtime < cutoff) continue;
        if (query && !f.name.toLowerCase().includes(query)) continue;
        if (kind === "image" && !MEDIA_EXT.has(ext)) continue;
        if (kind === "doc" && MEDIA_EXT.has(ext)) continue;
        hits.push({ repoId: r.id, repoName: r.repoName ?? r.id, branch: r.branch ?? "main", ...f });
      }
    }
    hits.sort((a, b) => Number(b.mtime) - Number(a.mtime));
    return json({ hits: hits.slice(0, limit), truncated: hits.length > limit });
  }

  // The token ledger counts conversation logs on disk; the demo has none. By default an honest empty
  // document in the real shape (the sheet's own "nothing counted" reading) — `jget` drops an error
  // body, so a refusal sentence would reach the screen as a bare "404 /api/tokenstats" (R-demo-005).
  // A scenario that opts in (`numbers.ledger`) gets `ledger.ts`'s invented fortnight instead, one set
  // of synthetic records folded into all three reads so they cannot disagree; it all shows under the
  // always-on demo line.
  if (path === "/api/tokenstats" && method === "GET") return json(m.numbers?.ledger ? demoTokenStats(now) : emptyTokenStats(now));
  if (path === "/api/tokenwindows" && method === "GET" && m.numbers?.ledger) {
    return json(demoTokenWindows(now, parseWindowSpecs(q.w)));
  }
  // The week card's read, folded over the same records. As the host: a malformed span (or one past
  // five weeks) is an empty document, never a 404; without the ledger, a fold over no logs.
  if (path === "/api/costwindow" && method === "GET") {
    const from = Number(q.from), to = Number(q.to);
    const ok = to > from && to - from <= 35 * 24 * 3_600_000; // NaN compares false
    return json(demoCostWindow(now, ok ? from : 0, ok ? to : 0, ok && !!m.numbers?.ledger));
  }
  if (path === "/api/usagelog" && method === "GET" && m.numbers?.ledger && m.numbers.usage) {
    return json(demoUsageLog(now, m.numbers.usage, Number(q.hours || 0) || undefined));
  }

  if (path === "/api/transcript" && method === "GET") {
    const id = q.id ?? "";
    if (!id || !findSession(m, id)) return json({ error: "no such session" }, 404);
    const doc = transcriptDoc(m, id, now);
    if (Number(q.since || 0) >= doc.updatedAt) return { status: 204, contentType: "text/plain", body: "" };
    return json(doc);
  }

  if (path === "/api/scrollback" && method === "GET") {
    const id = q.id ?? "";
    if (!id || !findSession(m, id)) return json({ error: "no such session" }, 404);
    const cols = m.screens?.[id]?.cols ?? 80;
    return json({ sessionId: id, lines: screenLines(m, id), cols, history: false, bounded: false, at: now });
  }

  if (path === "/api/context" && method === "GET") {
    const doc = m.numbers?.context?.[q.id ?? ""];
    if (!doc) return json({ error: "no context series" }, 404);
    if (Number(q.since || 0) >= doc.updatedAt) return { status: 204, contentType: "text/plain", body: "" };
    return json(doc);
  }

  // Repo health: a fictional series for the demo repos, only where the scenario opts in.
  const health = /^\/api\/repos\/([^/]+)\/repohealth$/.exec(path);
  if (health && method === "GET" && m.numbers?.repoHealth) {
    const id = decodeURIComponent(health[1]);
    const target = repoTargets(m).find((r) => r.id === id) as { repoName?: unknown } | undefined;
    const view = typeof target?.repoName === "string" ? demoRepoHealth(target.repoName, now) : null;
    if (!view) return json({ error: "no repo-health series for that repo" }, 404);
    return json(view);
  }

  // The health index: the same fictional repos, chained through the real shared arithmetic.
  const hix = /^\/api\/repos\/([^/]+)\/healthindex$/.exec(path);
  if (hix && method === "GET" && m.numbers?.repoHealth) {
    const id = decodeURIComponent(hix[1]);
    const target = repoTargets(m).find((r) => r.id === id) as { repoName?: unknown } | undefined;
    const doc = typeof target?.repoName === "string" ? demoHealthIndex(target.repoName, now) : null;
    if (!doc) return json({ error: "no health index for that repo" }, 404);
    return json(doc);
  }

  // Sessions started outside waterplane on this desktop: the demo's desktop runs no claude of its own,
  // so none — an honest empty list rather than a 404 the adopt sheet would print as a failure.
  if (path === "/api/external" && method === "GET") return json({ sessions: [] });

  // A fork's theme overlay (`themeOverlay.ts`): the demo desktop has none — the upstream look.
  if (path === "/api/theme" && method === "GET") return json({ overlay: {} });

  // Peer desktops: the demo has one desktop and has handed nothing to another — an empty ledger,
  // not a 404 the Activity sheet would print as "could not read".
  if (path === "/api/peerjobs" && method === "GET") return json({ ok: true, jobs: [] });

  // The demo's repos build no Android app: the Apps screen's setup pane says so.
  if (path === "/api/apps/readiness" && method === "GET") return json({ at: now, apps: [] });
  if (path === "/api/storage/transport" && method === "GET") {
    return json(m.storage?.transport ?? { at: now, repos: [], total: { count: 0, bytes: 0 }, partial: false });
  }
  if (path === "/api/storage/host" && method === "GET") {
    return json(m.storage?.host ?? { at: now, dir: "demo", rows: [], total: 0, partial: false });
  }
  if (path === "/api/storage/host/clear" && method === "POST") {
    return json({ deleted: 0, bytes: 0, failed: 0, refused: "The demo's desktop keeps no files, so there is nothing to clear." });
  }

  // Ask rules (agent-authority §2): the demo's desktop launches no claude, so it holds an empty
  // list with the suggested rules offered — and a save is refused in words, never pretended.
  if (path === "/api/askrules" && method === "GET") {
    // No `confirm`: there is nothing a save could change here, and the PUT below says so.
    return json({ ok: true, doc: { rules: [] }, suggested: SUGGESTED_ASK_RULES, honouredBy: ASK_RULE_BACKENDS, rev: "demo" });
  }
  if (path === "/api/askrules" && method === "PUT") {
    return json({ ok: false, error: "The demo's desktop launches no claude, so it keeps no ask rules — nothing was changed." }, 400);
  }

  // The first-app journey (first-app plan WP7). Its card is not drawn in the demo, but "Build
  // another app" in the New sheet still reaches here: the plan refuses in words, there is never a
  // job, and a start is refused the same way — nothing is built on a desktop that is a scenario.
  if (path === "/api/onboard/plan" && method === "GET") {
    return json({ ok: false, error: ONBOARD_NOT_IN_DEMO, path: q.path === "android" ? "android" : "web", name: q.name ?? "", folder: "", steps: [], consent: [], suggestedPrompt: "" });
  }
  if (path === "/api/onboard" && method === "GET") return json({ ok: true, job: null });
  if ((path === "/api/onboard" || path === "/api/onboard/resume") && method === "POST") return json({ ok: false, error: ONBOARD_NOT_IN_DEMO }, 400);

  return { status: 404, contentType: "text/plain", body: `${NOT_IN_DEMO} (${method} ${path})` };
}

/**
 * The reader's document for a session, built from what the model keeps: each
 * history row is a turn; its answer is the row's `output` when the scenario
 * wrote one, else (the last turn only — a turn played live) the lines the PTY
 * printed after the echoed prompt, as a `screen` block. Source `"history"`, the
 * host's own approximate fallback, which the reader already words as such.
 * `updatedAt` is the newest turn's time, so a poll for `since` costs a 204.
 */
function transcriptDoc(m: DemoModel, id: string, now: number) {
  const rows = (m.history?.[id] ?? []).filter((h) => h.kind === "prompt");
  const lines = screenLines(m, id);
  const turns = rows.map((h, i) => {
    let blocks: { kind: "text" | "screen"; text: string }[] = [];
    if (h.output) blocks = [{ kind: "text", text: h.output }];
    else if (i === rows.length - 1) {
      const at = lines.lastIndexOf(`❯ ${h.text}`);
      if (at >= 0) {
        const rest: string[] = [];
        // The next prompt ends the turn — `❯ text`, not a choice box's selected `❯ 1.` row.
        for (const l of lines.slice(at + 1)) { if (/^❯ (?!\d+\. )/.test(l)) break; rest.push(l); }
        const text = rest.join("\n").trim();
        if (text) blocks = [{ kind: "screen", text }];
      }
    }
    return {
      id: h.id, n: i + 1, prompt: h.text, promptLabel: h.text.replace(/\s+/g, " ").slice(0, 80),
      sentAt: h.sentAt, endedAt: h.outputAt ?? h.sentAt, blocks, toolCount: 0, files: [] as string[], sidechains: 0,
      // The figures a real host prices off the log (`transcript.ts`), where the scenario states them.
      ...m.turnFacts?.[id]?.[h.id],
    };
  });
  // A turn played live has no stored answer: it is read off the PTY, which may still be moving.
  const live = rows.length > 0 && !rows[rows.length - 1].output;
  const updatedAt = live || !rows.length ? now : Math.max(...rows.map((h) => h.outputAt ?? h.sentAt));
  return { sessionId: id, source: "history" as const, turns, truncated: false, bytes: 0, updatedAt, detail: "lite" as const };
}

/** `/api/health`'s numbers, from the model. `ptys` is the real host's leak
 *  gauge — the master/slave fds its process holds (`ownPtys()`), null when
 *  they cannot be read. The demo holds no fds, so null: a count of running
 *  sessions there would be a different number under the same name (the
 *  contract suite's health check, scripts/contract/checks.mjs). */
export const healthCounts = (m: DemoModel): { ptys: null; sessions: number } =>
  ({ ptys: null, sessions: sessions(m).length });
