/**
 * **Later work, asked for by an AGENT** — the loopback route a `claude` working
 * in one of this desktop's repos uses when the person told it "run this 3 h
 * before the weekly reset", "after that one finishes, do this", or "start a new
 * session with this prompt". Until this existed the phone could post all three
 * (`intent.post`, `schedule.save`, `session.create`) and an agent could only
 * hand the person a text file to paste.
 *
 * Two halves, one path:
 *
 *  - `postClientDraft` — what `intent.post` did inline in `routes/work.ts`,
 *    lifted here so the socket route and this HTTP route are ONE path into
 *    `IntentManager.post`: contain the cwd, force the naming authors to `hand`,
 *    strip the two budget fields only the host may write, and refuse a client's
 *    claim to be an agent. There is no second implementation to drift.
 *  - `handleAgentIntents` — `POST|GET|DELETE /api/agent/intents[/<id>]`, the
 *    HTTP shape, answered only to a process on THIS machine that is not a
 *    browser (`agentCallerRefusal`).
 *
 * **At-most-once by the caller's `key`, forever.** The row id IS `agent-<key>`
 * and `IntentManager.post` returns an existing row for an id it already holds —
 * the store's own guard, which outlives the 45-minute ack ledger. A retried
 * curl gets the SAME row back with `existing: true` and nothing new written.
 *
 * **Nothing here fires anything.** The row is posted `auto` (held by the
 * person's auto-fire switch and the budget, like a scheduled item from the
 * phone) and the ladder decides when; the answer says when in `whenWords`'s
 * words, the send sheet's own.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AGENT_POSTED_WORDS,
  AGENT_WITHDREW_DETAIL,
  DEFAULT_GRACE_MIN,
  INTENT_MAX_STEPS,
  MANUAL_HOLD_TEXT,
  ORIGIN_AGENT,
  cleanRule,
  cleanSessionBudget,
  isAgentPosted,
  itemHeadline,
  whenWords,
  windowRuleRefusal,
  type BacklogItem,
  type BudgetPeriod,
  type Intent,
  type IntentDraft,
  type IntentTrigger,
  type LaunchOpts,
  type SessionBudget,
  type WhenShape,
} from "@waterplane/shared";
import { localProcessRefusal } from "./net.js";
import type { IntentManager } from "./intents/manager.js";
import type { BacklogManager } from "./backlog.js";

/** Settled for good — `intents/contract.ts`'s test, which a flat module may not import. */
const isTerminal = (i: Intent): boolean => i.state === "done" || i.state === "failed" || i.state === "canceled";

// ── The one client path into the store ──────────────────────────────────────

export interface ClientPostDeps {
  intents: Pick<IntentManager, "post">;
  /** `server/wsops.ts`'s gate — the ONE gate on a client-named directory. */
  containRepoDir(dir: unknown): Promise<string | null>;
}

export type ClientPostResult =
  | { ok: true; intent: Intent; existing: boolean }
  | { ok: false; reason: string; refusedCwd?: true };

/**
 * A build payload names the directory `builds.execute` spawns in, apart from
 * the intent's own `cwd` — so it goes through the same gate. `null` => outside
 * the root (refuse). Any other payload passes through untouched.
 */
export async function containPayloadCwd<P extends { kind?: string; cwd?: string } | undefined>(
  deps: { containRepoDir(dir: unknown): Promise<string | null> }, payload: P,
): Promise<P | null> {
  if (!payload || payload.kind !== "build" || payload.cwd === undefined) return payload;
  const cwd = await deps.containRepoDir(payload.cwd);
  return cwd ? { ...payload, cwd } : null;
}

/**
 * Post a draft that came from OUTSIDE the host — a phone's `intent.post`, or an
 * agent's HTTP call. `origin` is the host's to write: pass `ORIGIN_AGENT` from
 * the agent route and nothing from the socket.
 */
export async function postClientDraft(deps: ClientPostDeps, raw: IntentDraft, opts: { origin?: string } = {}): Promise<ClientPostResult> {
  // Contained on the way IN — while there is still a caller to tell — rather
  // than at fire time, when there is not. An intent names the directory an
  // agent will later be spawned in.
  const cwd = await deps.containRepoDir(raw?.cwd);
  if (!cwd) return { ok: false, reason: "cwd outside root", refusedCwd: true };
  const draft: IntentDraft = { ...raw, cwd };
  // A build is started with `build.run`: an agent or a peer (an `origin` is
  // passed) never posts one. A device's own `intent.post` may (schedules).
  if (opts.origin && raw.payload?.kind === "build") return { ok: false, reason: "a build is started with build.run" };
  const payload = await containPayloadCwd(deps, raw.payload);
  if (!payload) return { ok: false, reason: "cwd outside root", refusedCwd: true };
  draft.payload = payload;
  /**
   * **A client may bring a name; it may never bring an AUTHOR.** Off the wire
   * the authors are forced to `hand`, because the author decides whether a
   * later naming pass may write over the title, and a client claiming `assess`
   * would make a typed title overwritable. Pairwise: no value, no author.
   */
  if (draft.headline) draft.headlineBy = "hand"; else delete draft.headlineBy;
  if (draft.category) draft.categoryBy = "hand"; else delete draft.categoryBy;
  // …and never a way past the BUDGET: `pastBudget` is `intent.waive`'s and
  // `budgetPass` is stamped by `workItemInherits`, `leftoverOf` by the tick.
  // All three are the host's.
  delete draft.pastBudget;
  delete draft.budgetPass;
  delete draft.leftoverOf;
  // …and never the AGENT mark: it is written by the agent route and nowhere
  // else, so the person can trust it both ways.
  if (opts.origin) draft.origin = opts.origin;
  else if (isAgentPosted(draft)) delete draft.origin;
  const posted = deps.intents.post(draft);
  if (!posted.ok || !posted.intent) return { ok: false, reason: posted.reason || "could not be written down" };
  return { ok: true, intent: posted.intent, existing: posted.existing === true };
}

/**
 * **The one client path into `backlog.add`** — the socket's `backlog.add` and
 * the agent's `POST /api/agent/backlog` both call it. Contained on the way in,
 * like `postClientDraft`. The socket route keeps its own ack ledger and
 * in-flight join around it; the agent route's at-most-once is the `id`.
 */
export async function addClientBacklogItem(
  deps: { containRepoDir(dir: unknown): Promise<string | null>; backlog: Pick<BacklogManager, "add"> },
  p: {
    repoDir: unknown; text: string; label?: string; targetSessionId?: string; autoFire?: boolean;
    steps?: readonly string[]; resume?: boolean; closeWhenDone?: boolean; flagWhenDone?: boolean; budget?: SessionBudget; launch?: LaunchOpts; id?: string; origin?: string; manual?: boolean;
  },
): Promise<{ ok: false; refusedCwd: true } | { ok: true; item: BacklogItem }> {
  const repoDir = await deps.containRepoDir(p.repoDir);
  if (!repoDir) return { ok: false, refusedCwd: true };
  const item = deps.backlog.add(p.text, repoDir, p.label, p.targetSessionId, p.autoFire,
    { steps: p.steps, resume: p.resume, closeWhenDone: p.closeWhenDone, flagWhenDone: p.flagWhenDone, budget: p.budget, launch: p.launch, id: p.id, origin: p.origin, manual: p.manual });
  return { ok: true, item };
}

/**
 * A plugin's `api.handToAgent` (`plugins/pluginapi.ts`): the SAME add, so a
 * prompt a plugin hands over is contained, persisted and fired by the intent
 * ladder like any other — never typed into a session. Waits for a tap
 * (`manual`) unless the caller asked to fire, and then it is an auto row the
 * ladder fires when it lets it — never fired directly; a key already in the store is
 * answered with that row and never fired a second time.
 */
export async function handToAgentVia(
  deps: { containRepoDir(dir: unknown): Promise<string | null>; backlog: Pick<BacklogManager, "add">; intents: Pick<IntentManager, "get"> },
  p: { repoDir: string; text: string; label?: string; id?: string; origin: string; fire: boolean },
): Promise<{ ok: true; intentId: string; existing: boolean; state?: string } | { ok: false; reason: string }> {
  const prior = p.id ? deps.intents.get(p.id) : undefined;
  const existed = !!prior;
  const added = await addClientBacklogItem(deps, {
    repoDir: p.repoDir, text: p.text, label: p.label, id: p.id, origin: p.origin, manual: !p.fire,
  });
  if (!added.ok) return { ok: false, reason: "that folder is outside the configured root — nothing was handed over" };
  if (added.item.status === "failed" && added.item.error && !existed) return { ok: false, reason: `not added: ${added.item.error}` };
  return { ok: true, intentId: added.item.id, existing: existed, ...(prior ? { state: prior.state } : {}) };
}

// ── Who may call the HTTP route ─────────────────────────────────────────────

/**
 * Why this caller is not an agent on this machine, or null when it is.
 *
 * Three tests, each for a different way in:
 *  - not LOOPBACK — a Tailscale peer passes the app-wide boundary but has no
 *    reason to post as an agent (`/api/hook`'s rule);
 *  - PROXIED — `tailscale serve` terminates HTTPS and forwards to 127.0.0.1, so
 *    the phone's own traffic arrives from loopback; the forwarding headers are
 *    what tell it apart;
 *  - a BROWSER — anything carrying `Origin` or `Sec-Fetch-Site`. `origin.ts`
 *    already refuses a cross-origin page; this also refuses the SAME-origin
 *    one, because an agent's curl sends neither and the phone has its socket.
 */
export function agentCallerRefusal(remoteAddress: string | undefined, headers: IncomingMessage["headers"]): string | null {
  // Not loopback, or proxied: the one predicate every local-process route shares (`net.ts`).
  const local = localProcessRefusal(remoteAddress, headers);
  if (local) return local;
  if (headers["origin"] || headers["sec-fetch-site"]) return "local only — a browser is not an agent; the phone posts over its socket";
  return null;
}

// ── The body → a draft ──────────────────────────────────────────────────────

/** `agent-<key>`: the key is the caller's, the prefix keeps it clear of every
 *  id the phone mints (`i_…`, `s_…`) and the host mints (8 hex). */
export const agentIntentId = (key: string): string => `agent-${key}`;
const KEY_RE = /^[A-Za-z0-9._:-]{1,64}$/;

export interface DraftFacts {
  now: number;
  /** The contained directory the caller named (`repo` or `dir`), or null. */
  cwd: string | null;
  /** A live session's cwd, when `session` was named. */
  sessionCwd(id: string): string | null;
  /** A row in the store — the chain's predecessor. */
  intent(id: string): Intent | undefined;
  /** The configured budget periods, so a `window` trigger may name one by id. */
  periods?(): readonly BudgetPeriod[];
}

/**
 * The caller's body as an `IntentDraft`, or the sentence saying why not. Pure,
 * so every refusal is pinned without a host (`packages/host/test/agentintents`).
 *
 * The draft is the phone's own shape for each case (`useSend.tsx`): a session
 * target is `pinned` (aimed at one session, as the compose bar's "queue for this
 * session"), a repo target is `serial` and opens a fresh session, and every row
 * is `auto` — machinery, held by the person's auto-fire switch and the budget.
 * The one rule the phone never meets: **an agent posts one-offs only.** A
 * standing rule is the person's to set, on the phone, where they will see it
 * every week — a recurring rule is refused in words.
 */
/** What every agent body names — the key, the words, and where — or why not.
 *  Shared by the intent post and the backlog add, so the two refuse alike. */
export function agentBasics(body: any, f: DraftFacts):
  | { refused: string }
  | { b: any; key: string; steps: string[]; cwd: string; sessionId?: string; label?: string } {
  const b = body && typeof body === "object" ? body : {};
  const key = typeof b.key === "string" ? b.key.trim() : "";
  if (!KEY_RE.test(key)) return { refused: "`key` is required: 1-64 of A-Z a-z 0-9 . _ : - — the same key on a retry returns the same row" };

  const steps: string[] = (Array.isArray(b.steps) ? b.steps : [b.prompt])
    .filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0);
  if (!steps.length) return { refused: "`prompt` (or `steps`, a list of turns) is required" };
  if (steps.length > INTENT_MAX_STEPS) return { refused: `at most ${INTENT_MAX_STEPS} steps` };

  // Where. A named session wins the cwd; a repo named beside it must agree.
  const sessionId = typeof b.session === "string" ? b.session.trim() : "";
  let cwd = f.cwd;
  if (sessionId) {
    const sc = f.sessionCwd(sessionId);
    if (!sc) return { refused: `no live session "${sessionId}" — omit \`session\` to open a new one` };
    if (cwd && cwd !== sc) return { refused: "that session runs in a different repo than the one named" };
    cwd = sc;
  } else if (!cwd) {
    return { refused: "`repo` (an id from GET /api/repos) or `dir` is required, and must be inside the configured root" };
  }
  const label = typeof b.label === "string" && b.label.trim() ? b.label.trim().slice(0, 80) : undefined;
  return { b, key, steps, cwd: cwd!, sessionId: sessionId || undefined, label };
}

export function agentDraftFrom(body: any, f: DraftFacts): { draft: IntentDraft } | { refused: string } {
  const basics = agentBasics(body, f);
  if ("refused" in basics) return basics;
  const { b, key, steps, cwd, sessionId, label } = basics;
  const target: IntentDraft["target"] = sessionId ? { kind: "session", sessionId } : { kind: "repo" };

  // When.
  const w = b.when && typeof b.when === "object" ? b.when : { kind: "now" };
  const grace = (v: unknown): number => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(7 * 24 * 60, Math.max(0, n)) : DEFAULT_GRACE_MIN;
  };
  let trigger: IntentTrigger;
  if (w.kind === "now") {
    trigger = { kind: "now" };
  } else if (w.kind === "at") {
    const at = typeof w.at === "string" ? Date.parse(w.at) : Number(w.at);
    if (!Number.isFinite(at) || at <= 0) return { refused: "`when.at` must be epoch ms or an ISO date" };
    if (at <= f.now) return { refused: "that instant has passed — use {\"kind\":\"now\"}" };
    trigger = { kind: "at", rule: cleanRule({ kind: "once", at }), graceMin: w.graceMin == null ? DEFAULT_GRACE_MIN : grace(w.graceMin) };
  } else if (w.kind === "window") {
    if (typeof w.window !== "string" || !w.window.trim()) return { refused: "`when.window` is \"session\", \"weekly\" or the id of a configured budget period" };
    const periodRefusal = windowRuleRefusal(w.window, f.periods?.());
    if (periodRefusal) return { refused: `\`when.window\`: ${periodRefusal}` };
    if (w.oneShot === false) return { refused: "an agent posts one-offs only — a standing rule is the person's to set on the phone" };
    const lead = Math.round(Number(w.leadMin ?? 0));
    if (!Number.isFinite(lead) || lead < 0 || lead > 1440) return { refused: "`when.leadMin` is 0-1440 minutes before the reset" };
    trigger = {
      kind: "at",
      rule: cleanRule({ kind: "window", window: w.window === "weekly" ? "weekly" : "session", ...(w.window === "session" || w.window === "weekly" ? {} : { periodId: w.window }), edge: "before", offsetMin: -lead, oneShot: true }),
      graceMin: w.graceMin == null ? DEFAULT_GRACE_MIN : grace(w.graceMin),
    };
  } else if (w.kind === "after") {
    const id = typeof w.id === "string" ? w.id.trim() : "";
    const prev = id ? f.intent(id) : undefined;
    if (!prev) return { refused: "`when.id` must name an intent this host holds (GET /api/agent/intents lists yours)" };
    const title = itemHeadline({ label: prev.label, text: prev.payload.kind === "prompt" ? prev.payload.steps[0] ?? "" : "", headline: prev.headline })
      ?? prev.title ?? undefined;
    trigger = {
      kind: "after", id, onlyIfOk: w.onlyIfOk === true || undefined, title,
      ...(w.graceMin == null ? {} : { graceMin: grace(w.graceMin) }),
    };
  } else {
    return { refused: "`when.kind` is one of now, at, window, after" };
  }

  return {
    draft: {
      id: agentIntentId(key),
      cwd,
      payload: { kind: "prompt", steps },
      target,
      trigger,
      auto: true,
      ...(target.kind === "session" ? { pinned: true } : {
        serial: true, resume: b.resume === true || undefined,
        // Only where it opens a session; a boolean or nothing (follow the person's setting).
        ...(typeof b.closeWhenDone === "boolean" ? { closeWhenDone: b.closeWhenDone } : {}),
        ...(b.flagWhenDone === true ? { flagWhenDone: true } : {}),
        // …and the budget that session is born with, refused whole if garbage.
        ...(cleanSessionBudget(b.budget) ? { budget: cleanSessionBudget(b.budget)! } : {}),
      }),
      label,
    },
  };
}

/**
 * An agent's backlog ADD: words put on the person's list, never started.
 * `manual` is what makes that true (`Intent.manual`: rung 1 holds it, only the
 * person's own `fire` runs it) — so no `fire`, no `autoFire`, and no `when`.
 */
export function agentBacklogFrom(body: any, f: DraftFacts):
  | { refused: string }
  | { add: { id: string; repoDir: string; text: string; steps: string[]; label?: string; targetSessionId?: string; resume?: boolean; closeWhenDone?: boolean; flagWhenDone?: boolean; budget?: SessionBudget } } {
  const basics = agentBasics(body, f);
  if ("refused" in basics) return basics;
  const { b, key, steps, cwd, sessionId, label } = basics;
  if (b.when != null || b.fire != null) return { refused: "a backlog add never starts by itself — no `when`, no `fire`; POST /api/agent/intents is the route for timed work" };
  return {
    add: {
      id: agentIntentId(key), repoDir: cwd, text: steps[0], steps, label,
      targetSessionId: sessionId, resume: !sessionId && b.resume === true ? true : undefined,
      ...(!sessionId && typeof b.closeWhenDone === "boolean" ? { closeWhenDone: b.closeWhenDone } : {}),
      ...(!sessionId && b.flagWhenDone === true ? { flagWhenDone: true } : {}),
      ...(!sessionId && cleanSessionBudget(b.budget) ? { budget: cleanSessionBudget(b.budget)! } : {}),
    },
  };
}

// ── What the agent is told back ─────────────────────────────────────────────

/** The row's WHEN in the send sheet's words (`whenWords`). */
export function agentWhenOf(i: Intent): string {
  if (i.manual) return MANUAL_HOLD_TEXT;
  const t = i.trigger;
  const w: WhenShape | null = t.kind === "now" || t.kind === "idle" ? { kind: t.kind }
    : t.kind === "after" ? { kind: "after", title: t.title, onlyIfOk: t.onlyIfOk }
      : t.kind === "at" ? { kind: "at", rule: t.rule }
        : null;
  return w ? whenWords(w, t.kind === "at" ? i.nextAt ?? null : null) : t.kind;
}

/** One row, as the agent sees it — the words, never clipped, and what the
 *  person sees beside it. */
export function agentRowView(i: Intent) {
  return {
    id: i.id,
    state: i.state,
    fires: agentWhenOf(i),
    cwd: i.cwd,
    target: i.target.kind === "session" ? { session: i.target.sessionId } : { newSession: true },
    label: i.label,
    ...(typeof i.closeWhenDone === "boolean" ? { closeWhenDone: i.closeWhenDone } : {}),
    ...(i.flagWhenDone ? { flagWhenDone: true } : {}),
    ...(i.budget ? { budget: i.budget } : {}),
    steps: i.payload.kind === "prompt" ? i.payload.steps : [],
    ...(i.blockDetail ? { waiting: i.blockDetail } : {}),
    ...(i.result ? { result: { ok: i.result.ok, detail: i.result.detail } } : {}),
    shownAs: AGENT_POSTED_WORDS,
  };
}

/**
 * **The run order an agent may read and set** — every waiting row, whoever
 * wrote it, because the person asks for it by prompt: "run the migration
 * first, the docs pass last". Waiting means not settled, not started and not
 * set aside; started work has no seat left to move.
 */
const waiting = (i: Intent): boolean => !isTerminal(i) && i.state !== "starting" && i.state !== "running" && !i.archived;
const slotOf = (i: Intent): number => i.order ?? i.createdAt;

/** The queue in the order the tick reads it (`ladder.ts`: `order ?? createdAt`). */
export function agentQueue(rows: Intent[], cwd: string | null) {
  return rows.filter((i) => waiting(i) && (!cwd || i.cwd === cwd))
    .sort((a, b) => slotOf(a) - slotOf(b))
    .map((i, n) => ({
      seat: n + 1,
      ...agentRowView(i),
      title: itemHeadline({ label: i.label, text: i.payload.kind === "prompt" ? i.payload.steps[0] ?? "" : "", headline: i.headline }) ?? i.title ?? undefined,
      shownAs: isAgentPosted(i) ? AGENT_POSTED_WORDS : "the person's",
    }));
}

/** `ids` for a reorder, or the sentence saying why not. Two or more, each a
 *  waiting row this host holds, none twice. */
export function agentOrderIds(body: any, get: (id: string) => Intent | undefined): { ids: string[] } | { refused: string } {
  const raw = body?.ids;
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 200 || !raw.every((x) => typeof x === "string" && x.trim())) {
    return { refused: "`ids` is a list of 2-200 intent ids, first to run first (GET /api/agent/queue lists them)" };
  }
  const ids = raw.map((x: string) => x.trim());
  if (new Set(ids).size !== ids.length) return { refused: "an id is listed twice — each row has one seat" };
  for (const id of ids) {
    const row = get(id);
    if (!row) return { refused: `no such intent: ${id} — nothing was moved` };
    if (!waiting(row)) return { refused: `${id} is ${row.archived ? "archived" : row.state} — only waiting rows have a seat; nothing was moved` };
  }
  return { ids };
}

// ── The route ───────────────────────────────────────────────────────────────

export interface AgentRouteDeps extends ClientPostDeps {
  intents: Pick<IntentManager, "post" | "get" | "list" | "cancel">;
  backlog: Pick<BacklogManager, "add" | "reorder">;
  /** The configured budget periods (`window` triggers may name one). */
  periods?: () => readonly BudgetPeriod[];
  sessionCwd(id: string): string | null;
  /** A repo id (from `/api/repos`) → its worktree, or null. */
  repoDir(id: string): Promise<string | null>;
  json(res: ServerResponse, data: unknown, status?: number): void;
  readJson(req: IncomingMessage): Promise<any>;
}

const BASE = "/api/agent/intents";
const BACKLOG = "/api/agent/backlog";
const QUEUE = "/api/agent/queue";
const ORDER = "/api/agent/queue/order";

/** `true` when the request was this route's (answered, or refused). */
export async function handleAgentIntents(req: IncomingMessage, res: ServerResponse, path: string, url: URL, d: AgentRouteDeps): Promise<boolean> {
  if (path !== BASE && !path.startsWith(BASE + "/") && path !== BACKLOG && path !== QUEUE && path !== ORDER) return false;
  const method = req.method ?? "GET";
  const refusal = agentCallerRefusal(req.socket.remoteAddress, req.headers);
  if (refusal) { d.json(res, { ok: false, error: refusal }, 403); return true; }
  const id = path.length > BASE.length ? decodeURIComponent(path.slice(BASE.length + 1)) : "";

  // The caller's cwd, however it was named. `repo` resolves through the repo
  // listing; `dir` (and the repo's own worktree) through the containment gate.
  const cwdOf = async (repo: unknown, dir: unknown): Promise<string | null | "unknown-repo"> => {
    if (typeof repo === "string" && repo.trim()) {
      const wt = await d.repoDir(repo.trim());
      return wt ? d.containRepoDir(wt) : "unknown-repo";
    }
    return typeof dir === "string" && dir.trim() ? d.containRepoDir(dir) : null;
  };

  // ── The run order: read it, and set it when the person asked ──────────
  // `reorder` is the drag's own verb: the listed rows trade their own slots,
  // so a row not listed keeps its seat, and each is stamped `handOrdered` —
  // the person decided it, through their agent, exactly as a drag is.
  if (path === QUEUE) {
    if (method !== "GET") { d.json(res, { ok: false, error: `GET ${QUEUE} reads the order; POST ${ORDER} sets it` }, 405); return true; }
    const cwd = await cwdOf(url.searchParams.get("repo"), url.searchParams.get("dir"));
    if (cwd === "unknown-repo") { d.json(res, { ok: false, error: "unknown repo" }, 404); return true; }
    d.json(res, { ok: true, queue: agentQueue(d.intents.list(), cwd) });
    return true;
  }
  if (path === ORDER) {
    if (method !== "POST") { d.json(res, { ok: false, error: `POST ${ORDER} with {"ids":[…]}` }, 405); return true; }
    const made = agentOrderIds(await d.readJson(req), (x) => d.intents.get(x));
    if ("refused" in made) { d.json(res, { ok: false, error: made.refused }, 400); return true; }
    d.backlog.reorder(made.ids);
    const rows = made.ids.map((x) => d.intents.get(x)).filter((r): r is Intent => !!r);
    d.json(res, {
      ok: true,
      order: agentQueue(rows, null).map((r) => ({ id: r.id, title: r.title, fires: r.fires })),
      note: "these run in this order among themselves; rows not listed kept their seats, and each still waits for its own clock, the auto-fire switch and the budget",
    });
    return true;
  }

  // ── An item on the person's list, never started ──────────────────────
  if (path === BACKLOG) {
    if (method !== "POST") { d.json(res, { ok: false, error: `POST ${BACKLOG} adds; GET/DELETE ${BASE}[/<id>] list and call off` }, 405); return true; }
    const body = await d.readJson(req);
    const cwd = await cwdOf(body?.repo, body?.dir);
    if (cwd === "unknown-repo") { d.json(res, { ok: false, error: "unknown repo — ids come from GET /api/repos" }, 404); return true; }
    if ((body?.repo || body?.dir) && !cwd) { d.json(res, { ok: false, error: "that folder is outside the configured root — nothing was written down" }, 400); return true; }
    const made = agentBacklogFrom(body, { now: Date.now(), cwd, sessionCwd: d.sessionCwd, intent: (x) => d.intents.get(x), periods: d.periods });
    if ("refused" in made) { d.json(res, { ok: false, error: made.refused }, 400); return true; }
    // Read AFTER every await: the add below is synchronous, so a racing twin
    // either finds this row here or is found by `post()`'s own id guard.
    const existed = !!d.intents.get(made.add.id);
    const added = await addClientBacklogItem(d, { ...made.add, origin: ORIGIN_AGENT, manual: true });
    if (!added.ok) { d.json(res, { ok: false, error: "that folder is outside the configured root — nothing was written down" }, 400); return true; }
    if (added.item.status === "failed" && added.item.error && !existed) { d.json(res, { ok: false, error: `not added: ${added.item.error}` }, 409); return true; }
    const row = d.intents.get(added.item.id);
    d.json(res, {
      ok: true,
      existing: existed,
      ...(row ? agentRowView(row) : { id: added.item.id }),
      note: existed
        ? "already added under this key — nothing new was written"
        : `added to the backlog — ${MANUAL_HOLD_TEXT}; DELETE ${BASE}/${added.item.id} takes it back`,
    });
    return true;
  }

  if (method === "POST" && !id) {
    const body = await d.readJson(req);
    const cwd = await cwdOf(body?.repo, body?.dir);
    if (cwd === "unknown-repo") { d.json(res, { ok: false, error: "unknown repo — ids come from GET /api/repos" }, 404); return true; }
    const hadDir = body?.repo || body?.dir;
    if (hadDir && !cwd) { d.json(res, { ok: false, error: "that folder is outside the configured root — nothing was written down" }, 400); return true; }
    const made = agentDraftFrom(body, { now: Date.now(), cwd, sessionCwd: d.sessionCwd, intent: (x) => d.intents.get(x), periods: d.periods });
    if ("refused" in made) { d.json(res, { ok: false, error: made.refused }, 400); return true; }
    const r = await postClientDraft(d, made.draft, { origin: ORIGIN_AGENT });
    if (!r.ok) {
      d.json(res, { ok: false, error: r.refusedCwd ? "that folder is outside the configured root — nothing was written down" : `not queued: ${r.reason}` }, r.refusedCwd ? 400 : 409);
      return true;
    }
    d.json(res, {
      ok: true,
      existing: r.existing,
      ...agentRowView(r.intent),
      note: r.existing
        ? "already posted under this key — nothing new was written"
        : `posted — the person sees it on the phone (${AGENT_POSTED_WORDS}); DELETE ${BASE}/${r.intent.id} calls it off`,
    });
    return true;
  }

  if (method === "GET" && !id) {
    const cwd = await cwdOf(url.searchParams.get("repo"), url.searchParams.get("dir"));
    if (cwd === "unknown-repo") { d.json(res, { ok: false, error: "unknown repo" }, 404); return true; }
    const rows = d.intents.list().filter((i) => isAgentPosted(i) && (!cwd || i.cwd === cwd));
    d.json(res, { ok: true, intents: rows.map(agentRowView) });
    return true;
  }

  if (id && (method === "GET" || method === "DELETE")) {
    const row = d.intents.get(id);
    if (!row || !isAgentPosted(row)) {
      d.json(res, { ok: false, error: row ? "that row was not posted by an agent — it is the person's" : "no such intent" }, row ? 403 : 404);
      return true;
    }
    if (method === "GET") { d.json(res, { ok: true, ...agentRowView(row) }); return true; }
    // Not durable, `intent.cancel`'s reason: a cancel is about the row as it is
    // NOW, and one that has started is refused rather than interrupted.
    if (isTerminal(row)) { d.json(res, { ok: true, already: true, ...agentRowView(row) }); return true; }
    const done = d.intents.cancel(id, AGENT_WITHDREW_DETAIL);
    const after = d.intents.get(id) ?? row;
    d.json(res, done ? { ok: true, ...agentRowView(after) }
      : { ok: false, error: "it has already started — only the person can stop it now", ...agentRowView(after) }, done ? 200 : 409);
    return true;
  }

  d.json(res, { ok: false, error: `${method} is not a verb here — POST ${BASE}, GET ${BASE}[/<id>], DELETE ${BASE}/<id>` }, 405);
  return true;
}
