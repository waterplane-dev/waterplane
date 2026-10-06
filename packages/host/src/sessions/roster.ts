/**
 * The roster: the lists a session is remembered on beyond its PTY — the recent
 * shortlist (`.waterplane/sessions.json`), the reopen stack (`.waterplane/closed.json`),
 * stars, pinned prompts and the overview labels derived from them, which
 * sessions a client is watching, the per-session plugin state (the switches a
 * person flipped for a plugin, and the badges plugins set). (`rename` moved to `record.ts` `renameTab`.) Moved verbatim out of `sessions.ts`
 * (docs/notes/host-architecture.md, package S9).
 *
 * Constructed with the facade's `core`, which must already exist: loading the
 * reopen stack asks `core.hasLiveTmux` per `alive` row.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { clipClosedText, closedItemFacts, cleanClosedRow } from "@waterplane/shared";
import type { ClosedBy, Intent, PluginBadge, SessionInfo } from "@waterplane/shared";
import type { ClosedRow, RecentRow, Session, SessionCore } from "./core.js";
import { onRulesChanged, sessionRules } from "../answergate.js";
import { resolveBackend } from "../backends/index.js";
import { hostStateDir } from "../branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "../jsonstore.js";

export class RosterSlice {
  /** Session IDs a client is currently attached to ("in the loop"). A plugin
   *  reads it as `PluginSession.watched`. */
  private watched = new Set<string>();
  private recent: RecentRow[] = [];
  private recentPath: string;
  /**
   * Newest-first stack of closed sessions — the route back from a mis-tapped ×,
   * and from a bulk close. PERSISTED (`.waterplane/closed.json`): a close is not a
   * delete (the conversation log survives on disk and reopens with `--resume`),
   * but until this was written down the only record of WHICH conversations those
   * were lived in this process, so a host restart — which is routine here —
   * silently turned an archive into a needle in `~/.claude/projects`.
   */
  private recentlyClosed: ClosedRow[] = [];
  private closedPath: string;

  /** Durable keys (conversation id, else boot id) of starred "prima interest"
   *  sessions. Persisted to .waterplane/stars.json so a star survives restart/resume. */
  private stars = new Set<string>();
  private starsPath: string;

  /** Session boot id → pinned HistoryEntry id. Keyed by boot id (same key the
   *  history file uses), persisted to .waterplane/pins.json so a pin survives restart. */
  private pins = new Map<string, string>();
  private pinsPath: string;

  constructor(private readonly core: SessionCore) {
    // The standing rules a person can SEE on a session are the gate's store, copied onto its
    // info on every change (made, used, forgotten) — never a plugin's own account of them.
    onRulesChanged((id) => this.setPluginRules(id, sessionRules(id)));
    const root = core.root;
    this.recentPath = join(hostStateDir(root), "sessions.json");
    try {
      if (existsSync(this.recentPath)) this.recent = readJsonGuarded<typeof this.recent>(this.recentPath, this.recent, Array.isArray);
    } catch { /* fresh */ }
    this.closedPath = join(hostStateDir(root), "closed.json");
    try {
      // Cleaned row by row: a row from before the closed-row facts existed reads
      // back exactly as written, and a malformed one is dropped, not the list.
      if (existsSync(this.closedPath)) {
        const raw: unknown = readJsonGuarded<any>(this.closedPath, null);
        this.recentlyClosed = (Array.isArray(raw) ? raw : []).map(cleanClosedRow).filter((r): r is ClosedRow => r !== null);
      }
    } catch { /* fresh */ }
    // A session listed as merely BACKGROUNDED is a claim about a tmux server that
    // did not survive this restart if the daemon was down for it. Downgrade on
    // load: `alive` is re-earned by `hasLiveTmux`, never by a stale file.
    this.recentlyClosed = this.recentlyClosed.map((c) => (c.alive && !this.core.hasLiveTmux(c.id) ? { ...c, alive: false } : c));
    this.starsPath = join(hostStateDir(root), "stars.json");
    try {
      if (existsSync(this.starsPath)) this.stars = new Set(readJsonGuarded<string[]>(this.starsPath, [], Array.isArray));
    } catch { /* fresh */ }
    this.pinsPath = join(hostStateDir(root), "pins.json");
    try {
      if (existsSync(this.pinsPath)) this.pins = new Map(Object.entries(readJsonGuarded<Record<string, any>>(this.pinsPath, {})));
    } catch { /* fresh */ }
  }

  /**
   * Is this session's conversation record claude's jsonl?
   *
   * Asked by `settle.ts`, which counts NOTHING else as proof that a delivery
   * ran: its verdicts are about claude's log, and `getTranscript`'s opencode
   * document is invisible to it by design. Invisible was not free, though —
   * every settled opencode session paid a full synchronous read and fold of a
   * multi-megabyte store to build a document that was then dropped on the next
   * line. This is the question that has to be asked FIRST.
   *
   * True for a session this host has never heard of, deliberately: the claude
   * path answers `null` for an unknown id on its own, and a `false` here would
   * be this predicate inventing a second way to say "no evidence".
   */
  keepsClaudeLog(id: string): boolean {
    const s = this.core.sessions.get(id);
    if (s) return s.backend.caps.transcript === "claude-jsonl";
    const closed = this.closedRow(id);
    if (!closed) return true;
    try { return resolveBackend(closed.launch?.backend).caps.transcript === "claude-jsonl"; }
    catch { return false; } // a backend id this host no longer knows ⇒ no log it can read
  }

  /** `recentlyClosed.find((c) => c.id === id)` — the row, read at call time. */
  closedRow(id: string): ClosedRow | undefined {
    return this.recentlyClosed.find((c) => c.id === id);
  }

  /** The newest closed row of conversation `convId` (claude's id or another backend's). */
  closedRowOfConversation(convId: string): ClosedRow | undefined {
    return this.recentlyClosed.find((c) => c.claudeSessionId === convId || c.backendSessionId === convId);
  }

  /** `recentlyClosed = recentlyClosed.filter((c) => c.id !== id)` — publishing is the caller's. */
  dropClosed(id: string): void {
    this.recentlyClosed = this.recentlyClosed.filter((c) => c.id !== id);
  }

  /** `watched.has(id)` — a client is attached to this session. */
  isWatched(id: string): boolean {
    return this.watched.has(id);
  }

  // ── Recent (cross-restart) ──────────────────────────────────────────

  /** Maximum recent entries kept for one directory — several conversations per
   *  repo stay individually resumable, but one busy repo can't evict the rest.
   *  Both caps are a SHORTLIST, not the archive: `archive.ts` lists every
   *  conversation the CLI ever wrote for a repo, so nothing is lost past the
   *  edge here — it just takes one more tap to find. */
  private static readonly RECENT_PER_CWD = 20;
  private static readonly RECENT_LIMIT = 80;
  /** Reopen-stack depth. One bulk close can retire dozens of sessions at once,
   *  and 15 meant most of them fell off the list in the same tap that made them. */
  private static readonly CLOSED_LIMIT = 120;

  rememberRecent(s: Session): void {
    const cid = s.info.claudeSessionId;
    const entry: RecentRow = {
      cwd: s.info.cwd, title: s.info.title, lastActive: Date.now(), claudeSessionId: cid, launch: s.launch,
      // Carried so a reopen of an opencode row resumes THAT conversation
      // (`--session <id>`) rather than whichever one the directory's
      // `--continue` lands on. Absent until discovered, exactly like the claude
      // one — and it goes to the PHONE, which is what makes the promise in this
      // comment true rather than aspirational: the reopen tap sends it back as
      // `resumeSessionId`, `create()` turns that into `--session <id>`, and
      // nothing here ever puts it in `claudeSessionId`.
      ...(s.info.backendSessionId ? { backendSessionId: s.info.backendSessionId } : {}),
    };
    // One entry PER CONVERSATION (not per cwd). Replace this conversation's own
    // older entry. Id-less entries for the same cwd also go: they're either
    // legacy or this session's placeholder from before its id was detected, and
    // they resume via --continue — which this newer session repoints anyway.
    //
    // **Which id names the conversation depends on the backend**, so the key is
    // whichever one this row has. Keyed on the claude id alone, an opencode row
    // was id-less FOR EVER on that key: every new opencode session in a repo
    // swept away the previous opencode conversation's row as a placeholder, and
    // one conversation per repo was all this list could ever hold for that
    // backend — three lines under a comment promising one entry per
    // conversation. The two backends' ids cannot collide (a uuid and a `ses_…`),
    // so one key is enough and a fallback is not a merge.
    const key = cid ?? s.info.backendSessionId;
    const keyOf = (r: RecentRow): string | undefined => r.claudeSessionId ?? r.backendSessionId;
    const rest = this.recent.filter((r) => !(key != null && keyOf(r) === key) && !(keyOf(r) == null && r.cwd === s.info.cwd));
    let sameCwd = 0;
    const kept = rest.filter((r) => r.cwd !== s.info.cwd || ++sameCwd < RosterSlice.RECENT_PER_CWD);
    this.recent = [entry, ...kept].slice(0, RosterSlice.RECENT_LIMIT);
    try {
      mkdirSync(hostStateDir(this.core.root), { recursive: true });
      writeJsonAtomic(this.recentPath, this.recent, { space: 2 });
    } catch { /* non-fatal */ }
  }

  listRecent(): RecentRow[] {
    return this.recent;
  }

  /** Newest-first stack of recently closed sessions (for the reopen list). */
  /** A copy: the stack is this slice's, and a caller that sorts or trims the
   *  answer must not reorder what the next reopen pops. */
  listClosed(): ClosedRow[] {
    return this.recentlyClosed.slice();
  }

  /** Drop the whole reopen stack. Clears the persisted file too — but the
   *  conversations themselves stay on disk and stay listed by `archive.ts`, so
   *  this is tidying the shortlist, never a delete. */
  clearClosed(): void {
    this.recentlyClosed = [];
    this.publishClosed();
  }

  /** The intent store's row by id — set once at boot (`server/sessionEvents.ts`)
   *  so a closed row can say how its item SETTLED. Unset ⇒ no item outcome. */
  private itemLookup: ((itemId: string) => Pick<Intent, "state" | "result"> | undefined) | null = null;
  setItemLookup(fn: (itemId: string) => Pick<Intent, "state" | "result"> | undefined): void { this.itemLookup = fn; }

  /**
   * The closed row for `s`, built from what the session already holds — no
   * file read beyond the item lookup, no git, no model call. Every fact is
   * optional and left out when unknown (`shared/closed.ts`); strings clipped.
   *
   * `by` wins over `s.closeBy`; `exitCode`/`signal` are kept only for an exit
   * the session made on its own (`exited`/`limit`) — for a close we caused they
   * describe our own kill, not the session.
   */
  closedRowOf(s: Session, alive: boolean, exit: { by?: ClosedBy; exitCode?: number; signal?: number } = {}): ClosedRow {
    const i = s.info;
    const by = exit.by ?? s.closeBy;
    const own = by === "exited" || by === "limit";
    const h = s.history;
    const last = h[h.length - 1];
    const lastActiveAt = i.lastTurnAt ?? last?.outputAt ?? last?.sentAt;
    const o = s.origin;
    let item: ReturnType<typeof closedItemFacts> = {};
    if (o?.itemId && this.itemLookup) { try { item = closedItemFacts(this.itemLookup(o.itemId)); } catch { /* absent */ } }
    const txt = (k: string, v: unknown) => { const c = clipClosedText(v); return c ? { [k]: c } : {}; };
    return {
      id: i.id, cwd: i.cwd, title: i.title, closedAt: Date.now(), launch: s.launch,
      claudeSessionId: i.claudeSessionId, backendSessionId: i.backendSessionId, alive,
      ...(by ? { closedBy: by } : {}),
      ...(own && typeof exit.exitCode === "number" ? { exitCode: exit.exitCode } : {}),
      ...(own && typeof exit.signal === "number" && exit.signal > 0 ? { exitSignal: exit.signal } : {}),
      ...(o ? { kind: o.kind } : {}),
      ...txt("itemId", o?.itemId), ...txt("itemLabel", o?.itemLabel), ...txt("fromSession", o?.fromSession),
      ...item,
      ...(typeof i.createdAt === "number" ? { openedAt: i.createdAt } : {}),
      ...(typeof lastActiveAt === "number" ? { lastActiveAt } : {}),
      ...(h.length > 0 ? { turns: h.length } : {}),
      ...txt("firstPrompt", h[0]?.text ?? i.firstPrompt), ...txt("lastPrompt", last?.text ?? i.lastPrompt),
      ...txt("tabTitle", i.tabTitle), ...txt("model", i.model),
    };
  }

  /** Push (or re-push) one entry onto the newest-first reopen stack. */
  pushClosed(entry: ClosedRow): void {
    this.recentlyClosed = [entry, ...this.recentlyClosed.filter((c) => c.id !== entry.id)]
      .slice(0, RosterSlice.CLOSED_LIMIT);
    this.publishClosed();
  }

  /** Broadcast the stack and write it down (tmp+rename — a half-written file
   *  read at the next boot would lose the whole list, not one row). */
  publishClosed(): void {
    this.core.emit("closed", this.recentlyClosed);
    try {
      mkdirSync(hostStateDir(this.core.root), { recursive: true });
      writeJsonAtomic(this.closedPath, this.recentlyClosed);
    } catch { /* non-fatal — writeJsonAtomic removed its own tmp file */ }
  }

  /** Forget all remembered recent sessions (clears the persisted list). */
  clearRecent(): void {
    this.recent = [];
    try {
      mkdirSync(hostStateDir(this.core.root), { recursive: true });
      writeJsonAtomic(this.recentPath, this.recent, { space: 2 });
    } catch { /* non-fatal */ }
  }

  // ── "Prima interest" star (manual, durable) ─────────────────────────────
  // A star is keyed by the conversation id (stable across resume/restart) so it
  // sticks to the conversation, not the ephemeral boot id. Fresh sessions know
  // their claudeSessionId up front (--session-id); reattaches carry it in meta.

  /** The durable key a star hangs on: conversation id if known, else boot id. */
  private starKey(info: SessionInfo): string {
    return info.claudeSessionId ?? info.id;
  }

  /** Reflect the persisted star set onto a session's info flag. */
  applyStar(info: SessionInfo): void {
    info.starred = this.stars.has(this.starKey(info)) || (info.id ? this.stars.has(info.id) : false);
  }

  private persistStars(): void {
    try {
      mkdirSync(hostStateDir(this.core.root), { recursive: true });
      writeJsonAtomic(this.starsPath, [...this.stars], { space: 2 });
    } catch { /* non-fatal */ }
  }

  // ── Overview labels (first / last / pinned prompt) ──────────────────
  // The phone shows "first prompt … last prompt" per session for a quick sense
  // of where it started and where it's at. The last slot is often a bare "yes",
  // so the user can pin any earlier history entry to show there instead. All
  // three are derived from the session's own prompt history (sessions/record.ts owns
  // it), never from AI — that's the point, the AI summaries read poorly.

  private static readonly LABEL_CAP = 200;

  /** Re-derive firstPrompt/lastPrompt/pinnedPrompt from history + the pin. */
  applyPromptLabels(s: Session): void {
    const cut = (t?: string) => t?.replace(/\s+/g, " ").trim().slice(0, RosterSlice.LABEL_CAP) || undefined;
    const h = s.history;
    s.info.firstPrompt = cut(h[0]?.text);
    s.info.lastPrompt = cut(h[h.length - 1]?.text);
    const pinned = this.pins.get(s.info.id);
    s.info.pinnedEntryId = pinned && h.some((e) => e.id === pinned) ? pinned : undefined;
    s.info.pinnedPrompt = s.info.pinnedEntryId ? cut(h.find((e) => e.id === s.info.pinnedEntryId)!.text) : undefined;
  }

  private persistPins(): void {
    try {
      mkdirSync(hostStateDir(this.core.root), { recursive: true });
      writeJsonAtomic(this.pinsPath, Object.fromEntries(this.pins), { space: 2 });
    } catch { /* non-fatal */ }
  }

  /** Pin a history entry as the session's "last" overview label (null clears). */
  pin(id: string, entryId: string | null): void {
    const s = this.core.sessions.get(id);
    if (!s) return;
    if (entryId && s.history.some((e) => e.id === entryId)) this.pins.set(id, entryId);
    else this.pins.delete(id);
    this.applyPromptLabels(s);
    this.persistPins();
    this.core.emit("updated", s.info);
  }

  /** Toggle a session's manual "prima interest" star. Persists durably. */
  setStar(id: string, starred: boolean): void {
    const s = this.core.sessions.get(id);
    if (!s) return;
    const key = this.starKey(s.info);
    if (starred) this.stars.add(key);
    else { this.stars.delete(key); this.stars.delete(s.info.id); }
    s.info.starred = starred;
    this.persistStars();
    this.core.emit("updated", s.info);
  }

  // ── Watched sessions ─────────────────────────────────────────────────────

  /**
   * Set the full set of currently-watched session IDs (union of all clients'
   * attachments). Emits for any session whose watched flag flipped.
   */
  setWatched(ids: Set<string>): void {
    const changed = new Set<string>();
    for (const id of ids) if (!this.watched.has(id)) changed.add(id);
    for (const id of this.watched) if (!ids.has(id)) changed.add(id);
    if (!changed.size) return;
    this.watched = new Set(ids);
    for (const id of changed) {
      const s = this.core.sessions.get(id);
      if (!s) continue;
      // Attaching = you've now seen it → clear the "new since you left" flag.
      if (ids.has(id)) s.info.newActivity = false;
      // Opening a session is the moment its agent list has to be RIGHT: the
      // reader is the view that cannot see the CLI's own footer, and the poll
      // is only armed while agents are running, so a session that acquired one
      // while nobody watched has published nothing since.
      if (ids.has(id) && !s.agentTimer) this.core.checkAgents(s);
      this.core.emit("updated", s.info);
    }
  }

  // ── Per-session plugin state (docs/notes/plugins.md) ─────────────────────
  // Memory only, like the watched set: a restart puts every "let <plugin>
  // answer" switch back to OFF, which is the safe direction for a switch that
  // lets something type into a session unattended.

  /** A plugin's per-session toggle; `null` goes back to the manifest default. */
  setPluginToggle(id: string, plugin: string, toggle: string, value: boolean | null): boolean {
    const s = this.core.sessions.get(id);
    if (!s) return false;
    const all = { ...(s.info.pluginToggles ?? {}) };
    const mine = { ...(all[plugin] ?? {}) };
    if (value == null) delete mine[toggle]; else mine[toggle] = value;
    if (Object.keys(mine).length) all[plugin] = mine; else delete all[plugin];
    s.info.pluginToggles = Object.keys(all).length ? all : undefined;
    this.core.emit("updated", s.info);
    return true;
  }

  /** The core-owned "let <plugin> answer" switch. Off is stored as absent. */
  setPluginAnswer(id: string, plugin: string, value: boolean): boolean {
    const s = this.core.sessions.get(id);
    if (!s) return false;
    const all = { ...(s.info.pluginAnswer ?? {}) };
    if (value) all[plugin] = true; else delete all[plugin];
    s.info.pluginAnswer = Object.keys(all).length ? all : undefined;
    this.core.emit("updated", s.info);
    return true;
  }

  setPluginBadge(id: string, plugin: string, badge: PluginBadge | null): void {
    const s = this.core.sessions.get(id);
    if (!s) return;
    const all = { ...(s.info.pluginBadges ?? {}) };
    const before = JSON.stringify(all[plugin] ?? null);
    if (badge) all[plugin] = { text: String(badge.text).slice(0, 40), tone: badge.tone }; else delete all[plugin];
    if (JSON.stringify(all[plugin] ?? null) === before) return;
    s.info.pluginBadges = Object.keys(all).length ? all : undefined;
    this.core.emit("updated", s.info);
  }

  /** The standing rules on this session, as `answergate.ts` holds them — the store is the truth,
   *  this is its copy on the wire (`SessionInfo.pluginRules`). */
  setPluginRules(id: string, rules: SessionInfo["pluginRules"]): void {
    const s = this.core.sessions.get(id);
    if (!s) return;
    if (JSON.stringify(s.info.pluginRules ?? null) === JSON.stringify(rules ?? null)) return;
    s.info.pluginRules = rules;
    this.core.emit("updated", s.info);
  }

  anyPluginAnswer(plugin: string): boolean {
    for (const s of this.core.sessions.values()) if (s.info.pluginAnswer?.[plugin]) return true;
    return false;
  }
}
