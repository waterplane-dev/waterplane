/**
 * The disk of the intent store (I2 of the split in
 * docs/notes/host-architecture.md): `<state dir>/intents.json` read on boot (`load`,
 * the schema conversions, `foldLegacyWorkParents`), the one-time imports of
 * the old per-subsystem files, the archive (`intents-archive.jsonl`: `compact`
 * appends to it, `readArchiveTail` reads it back for `chainFacts`), and
 * `persist()` — which stays the ONE write to `intents.json`; every other slice
 * reaches it as `core.persist()`.
 *
 * `DiskSlice` owns the file paths, the schema the file on disk carried, and the
 * archive-tail cache. The rows are the facade's: every read is `core.rows()`,
 * every replacement `core.setRows(...)`. The facade constructs this slice first
 * and its two boot calls — `load()`, then `foldLegacyWorkParents()` — are the
 * constructor's only calls, in that order.
 */
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { 
  cleanIntentRow,
  isTimedWorkRow,
  safeRel,
  type Intent,
  type IntentDraft,
  type IntentFacts,
  type IntentSettlement, BRAND, legacyStateDirNames, logTag } from "@waterplane/shared";
import {
  ARCHIVE_TAIL_BYTES,
  FILE_MAX_BYTES,
  isRecurring,
  isTerminal,
  SETTLED_KEEP,
  STORE_SCHEMA,
  type IntentCore,
} from "./contract.js";

/** How often a STILL-failing write is logged again (the first failure always is). */
const WRITE_ERROR_LOG_MS = 10 * 60_000;
/** How soon a NEW failing streak tells a person again — a nearly-full disk flaps, and each flap is a feed row plus a push. */
const WRITE_ERROR_NOTICE_MS = 30 * 60_000;

export class DiskSlice {
  /** The `schema` the file on disk carried, or today's for a host with no file
   *  yet — see `STORE_SCHEMA` and `foldLegacyWorkParents()`. */
  private loadedSchema = STORE_SCHEMA;
  /** The dir the store persists under: `deps.stateDir` (the daemon's global
   *  state dir, injected — this slice imports no host module), else
   *  `<root>/<state dir>` for a store built on a scratch root. */
  private dir: string;
  private path: string;
  private archivePath: string;
  /**
   * The tail of `intents-archive.jsonl`, parsed — how the rows that have left
   * the live file finished, and that they existed at all.
   *
   * Cached against the file's own size+mtime rather than against a clock: the
   * archive is append-only, so "unchanged" is exactly "nothing was compacted
   * since the last read" and the re-parse happens on the tick after a
   * compaction instead of on every tick for ever. `null` is "never read", which
   * is different from an empty map (read, holds nothing) only in that the
   * former still has to do the work once.
   */
  private archiveTail: { settled: Map<string, IntentSettlement>; stamp: string } | null = null;
  /**
   * What went wrong with the file at boot, kept for the one notice that says so
   * (`storeNotice()`, fed by `main.ts`). Two cases, and they are handled in
   * opposite directions:
   *  - `corrupt`: the file did not parse (or was not a store at all). Its bytes
   *    were MOVED ASIDE (`jsonstore.ts`, `intents.json.corrupt-<ts>`) and the
   *    store starts empty — the next write cannot erase the evidence.
   *  - `newer`: the file was written by a NEWER host (its `schema` is past
   *    `STORE_SCHEMA`). Its rows are read as far as this code understands them,
   *    but the store is READ-ONLY for this boot: `persist()` writes nothing, a
   *    post is refused and the tick fires nothing — a write would downgrade the
   *    file, and a fire whose `starting` cannot reach the disk breaks
   *    at-most-once on the next restart.
   */
  private bootProblem: { kind: "corrupt"; movedTo: string | null; error: string } | { kind: "newer"; schema: number } | null = null;

  constructor(private readonly core: IntentCore) {
    this.dir = core.deps.stateDir ?? join(core.deps.root, BRAND.stateDirName);
    this.path = join(this.dir, "intents.json");
    this.archivePath = join(this.dir, "intents-archive.jsonl");
  }

  /**
   * The LEGACY two-row shape, folded on boot — set aside, never deleted.
   *
   * Before `isTimedWorkRow`, a one-off `at` row with `origin: schedule:work`
   * did not run its own words: it `backlog.add`ed a CHILD and settled itself
   * `done` with the child's id. One piece of work, two rows — and the second
   * one was the account of it. That shape is gone (`execute()` routes a one-off
   * to `freshSession` now), but eight of those parents are sitting in the live
   * store, and under the new classification they are BACKLOG rows: the repo's
   * backlog shows each piece of work twice, once as the session that ran it and
   * once as a parent with a clock chip, no session, no *open*, and a *re-fire*
   * that would type the words a second time. The spent-clocks foot counted them
   * as timed items that "have been and gone — run or missed"; they neither ran
   * nor missed, they made a child.
   *
   * So: a timed WORK row whose `result.childId` names a row this store still
   * holds is archived. `archived` is rung 1 of `intentVerdict` — *set aside —
   * bring it back to let it run* — so nothing fires, nothing is lost, and the
   * row is one tap from coming back if the fold was wrong about it.
   *
   * Narrow on purpose. `isTimedWorkRow` excludes the recurring rules, which
   * still make a child per occurrence and must keep standing, and a `childId`
   * pointing at a row that has been compacted away is left alone: the parent is
   * then the only account left of that work.
   *
   * ONCE EVER, not once per boot, and that is what the schema bump buys. The
   * fold is a judgement a person is allowed to disagree with — *bring it back*
   * is one tap on an archived row — and a pass that re-derived itself from the
   * rows would undo that decision on the next restart, which is a thing this
   * daemon does routinely. The file is the only place that can remember the
   * conversion happened, so it is where it is recorded, exactly as schema 2
   * records "every repo target has been re-read as fresh". The mark is written
   * even when nothing was folded — a conversion that found nothing to do is
   * still a conversion that has run.
   */
  foldLegacyWorkParents(): void {
    if (this.loadedSchema >= STORE_SCHEMA) return;
    const ids = new Set(this.core.rows().map((r) => r.id));
    let folded = 0;
    for (const row of this.core.rows()) {
      if (row.archived) continue;
      const child = row.result?.childId;
      if (!child || !ids.has(child)) continue;
      if (!isTimedWorkRow(row)) continue;
      row.archived = true;
      folded++;
    }
    try {
      this.persist();
      this.loadedSchema = STORE_SCHEMA;
      if (folded) console.log(`${logTag} set aside ${folded} timed row${folded === 1 ? "" : "s"} whose work already has a row of its own (the child is the account of it); bring one back from the backlog if you want it again`);
    } catch { /* the in-memory rows are already right; the next write re-tries */ }
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  /** A sentence saying the store is read-only this boot, or null when it may write. */
  readOnly(): string | null {
    return this.bootProblem?.kind === "newer"
      ? `intents.json was written by a newer version of this host (schema ${this.bootProblem.schema}, this one knows ${STORE_SCHEMA}); nothing is saved or run until the host is updated`
      : null;
  }

  /** The feed row for a boot-time problem with the file, or null. */
  storeNotice(): { title: string; body: string; tag: string } | null {
    const p = this.bootProblem;
    if (!p) return null;
    if (p.kind === "corrupt") {
      return {
        title: "Scheduled work could not be read",
        body: `${this.path} was unreadable at start-up (${p.error}), so the backlog and schedules start empty. ` +
          (p.movedTo ? `The damaged file is kept as ${p.movedTo}; nothing has overwritten it.` : "It could not be moved aside; it is left where it was."),
        tag: "intents-corrupt",
      };
    }
    return {
      title: "Scheduled work is read-only",
      body: `${this.path} was written by a newer version of this host (schema ${p.schema}; this one knows ${STORE_SCHEMA}). ` +
        "Its rows are shown as far as this version understands them, but nothing is saved and nothing fires, so the file is never downgraded. Update the host to run them.",
      tag: "intents-newer",
    };
  }

  load(): void {
    let legacy = false;
    // Guarded: present-but-unparseable (or not a store at all) is moved aside,
    // never left to be overwritten by the first `persist()` of this boot.
    const isStore = (v: unknown): boolean => Array.isArray(v) || Array.isArray((v as { intents?: unknown })?.intents);
    const read = this.core.deps.files ? this.core.deps.files.readGuarded(this.path, null, isStore) : this.plainRead();
    if (read.corrupt) this.bootProblem = { kind: "corrupt", movedTo: read.corrupt.movedTo, error: read.corrupt.error };
    try {
      const parsed = read.value;
      if (parsed == null) return;
      // ── schema 1 → 2 ────────────────────────────────────────────────────
      //
      // Version 1 was a bare ARRAY of rows. Version 2 is `{ schema, intents }`,
      // and the thing it records is that every non-terminal `{kind:"repo"}` row
      // in the file has been re-read as `{kind:"repo", fresh:true}` — every work
      // item that was queued for its repo's ONE shared backlog session now opens
      // a session of its own instead. `cleanTarget` is what performs the
      // conversion (one normalisation, on the one path every row enters
      // through); this is what says it happened, so a host that finds `schema:2`
      // never writes the `.bak` a second time.
      //
      // The `.bak` is the same posture every other conversion here takes: the
      // words were the user's and a conversion nobody can check is a conversion
      // nobody can trust. It is also the rollback — an older host reads only the
      // array form, and the copy beside the file is that array.
      const arr = Array.isArray(parsed) ? parsed
        : Array.isArray((parsed as { intents?: unknown })?.intents) ? (parsed as { intents: unknown[] }).intents
          : null;
      if (!arr) return;
      legacy = Array.isArray(parsed);
      // Which reading the file on disk was written under, remembered for the
      // one conversion that has to happen ONCE EVER rather than once per boot.
      const stamped = Number((parsed as { schema?: unknown })?.schema);
      this.loadedSchema = legacy ? 1 : Number.isFinite(stamped) && stamped > 0 ? stamped : 1;
      // A file from a NEWER host: read what we can, write nothing (`readOnly`).
      if (this.loadedSchema > STORE_SCHEMA) {
        this.bootProblem = { kind: "newer", schema: this.loadedSchema };
        console.error(`${logTag} ${this.readOnly()}`);
      }
      const now = Date.now();
      this.core.setRows(arr
        .map((v: unknown) => cleanIntentRow(v, now))
        .filter((r): r is Intent => !!r)
        .map((r) => {
          // `blocked` is a fact about right now and is recomputed every tick —
          // never trusted from disk.
          //
          // A session id used to be dropped here for the same reason, on the
          // rule that it is per-boot. That rule is right about a session this
          // daemon spawned into a plain PTY and WRONG under the TMUX knob at 1,
          // which is the substrate this project runs on: the `claude` processes
          // live in a private tmux server, they outlive the restart, and
          // `sessions.rediscover()` re-adopts them by the same id. Clearing
          // unconditionally therefore threw away a live handle — and
          // `fanout.followUp()` re-drives EXISTING sessions and never spawns,
          // so a completed sweep could not be followed up after a restart: the
          // twelve agents were sitting right there and the run had forgotten
          // their names.
          //
          // So the id is kept here and reconciled in `reconcile()`, which runs
          // AFTER `rediscover()` and can therefore ask the only question worth
          // asking — is that session actually still there? Where it is not, the
          // id is dropped exactly as before; the fact replaces the guess.
          if (r.state === "blocked") return { ...r, state: "queued" as const, blockReason: undefined, blockDetail: undefined };
          // Two shapes the OLD lifecycle could write, corrected on the way in
          // rather than left to say something untrue on every screen for ever:
          //  • a terminal one-off still carrying a `nextAt` (see `settle`), which
          //    renders as a countdown to a fire that cannot happen;
          //  • a `done` one-off whose occurrence was never spent and is still
          //    ahead of us — the fingerprint of a hand `runNow` (see `fire`),
          //    whose schedule is supposed to still be armed.
          if (r.trigger.kind === "at" && r.trigger.rule.kind === "once" && r.nextAt != null && isTerminal(r)) {
            if (r.state === "done" && r.lastOccurrence == null && r.nextAt > now) {
              return { ...r, state: "queued" as const, startedAt: undefined, settledAt: undefined };
            }
            return { ...r, nextAt: null };
          }
          return r;
        }));
    } catch { /* a row shape this code cannot map → no intents, same as a fresh host */ }
    if (!legacy) return;
    // The copy first, the new file second: a crash between them leaves the
    // rollback on disk and the original untouched, which is the only ordering
    // where nothing is lost.
    try { copyFileSync(this.path, `${this.path}.bak`); } catch { /* best effort — see below */ }
    try {
      this.persist();
      console.log(`${logTag} intents.json converted to schema ${STORE_SCHEMA} (a session per work item); the previous file is at ${this.path}.bak`);
    } catch { /* the in-memory rows are already right; the next write re-tries */ }
  }

  /**
   * Import what the old per-subsystem files were holding, once.
   *
   * Renaming each source to `*.migrated` rather than deleting it is the same
   * posture the rest of this store takes: the words were the user's, and a
   * conversion nobody can check is a conversion nobody can trust. A row whose
   * id is already here is skipped, so re-importing a restored backup cannot
   * duplicate work.
   */
  migrateLegacy(convert: {
    launches(raw: unknown[], now: number): IntentDraft[];
    schedules(raw: unknown[], now: number): IntentDraft[];
  }): void {
    // Read-only: an import renames its source `.migrated`, and the rows it
    // brought would never reach the disk — the words would be lost.
    if (this.readOnly()) return;
    for (const [file, fn] of [["launches.json", convert.launches], ["schedules.json", convert.schedules]] as const) {
      // Current name and every legacy one: a root the boot move could not
      // rename still holds them there. A converted file is `.migrated`, so the
      // legacy name that is a symlink to the current dir reads nothing twice.
      const root = this.core.deps.root;
      for (const dir of [this.dir, ...legacyStateDirNames.map((name) => join(root, name))]) {
        this.migrateFile(join(dir, file), file, fn);
      }
    }
    if (this.core.rows().length) this.persist();
  }

  /**
   * The same import, for a file that lives inside a REPO.
   *
   * `<repoDir>/<state dir>/backlog.json` is per-repo, so there is one of these per
   * discovered worktree rather than one at the root — and it is read at the
   * moment the repo list is known, which is also why it cannot ride along with
   * `migrateLegacy` above (that runs before any git command has been issued).
   *
   * Non-destructive in exactly the same way: a row whose id is already here is
   * skipped, and the source is RENAMED rather than deleted, because a conversion
   * nobody can check is a conversion nobody can trust.
   */
  migrateFileAt(src: string, label: string, convert: (raw: unknown, now: number) => IntentDraft[]): void {
    if (!existsSync(src) || this.readOnly()) return;
    this.migrateFile(src, label, convert, true);
    this.persist();
  }

  private migrateFile(src: string, label: string, fn: (raw: any, now: number) => IntentDraft[], raw = false): void {
    if (!existsSync(src)) return;
    const now = Date.now();
    let imported = 0;
    try {
      const parsed = JSON.parse(readFileSync(src, "utf8"));
      const drafts = raw ? fn(parsed, now) : Array.isArray(parsed) ? fn(parsed, now) : [];
      for (const draft of drafts) {
        if (this.core.rows().some((r) => r.id === draft.id)) continue;
        const row = cleanIntentRow({ ...draft, createdAt: (draft as { createdAt?: number }).createdAt ?? now }, now);
        if (!row) continue;
        if (row.trigger.kind === "at" && row.nextAt !== null) {
          row.nextAt = this.core.armFrom(row, row.lastOccurrence ?? row.createdAt - 1, now);
        }
        this.core.rows().push(row);
        imported++;
      }
    } catch { /* unreadable legacy file → nothing to import, and it is renamed
                 anyway: a file that cannot be parsed will not parse next boot
                 either, and leaving it would retry the same failure forever */ }
    try { renameSync(src, `${src}.migrated`); } catch { /* best effort */ }
    if (imported) console.log(`${logTag} migrated ${imported} row${imported === 1 ? "" : "s"} from ${label} into the intent store`);
  }

  /** Does this repo-relative path exist under the worktree? The containment
   *  check is repeated here (`cleanIntentRow` already ran) because this is the
   *  call that touches the filesystem, and a guard at the point of use is the
   *  one a row that got onto disk some other way cannot bypass. */
  present(cwd: string, rel: string): boolean {
    if (!safeRel(rel)) return false;
    try { return existsSync(join(cwd, rel)); } catch { return false; }
  }

  /**
   * The four facts an `after` row reads, built once per pass.
   *
   * They are four rather than one because the four questions a chain asks
   * have four different wrong answers (`IntentFacts` says which). This is the
   * host half of that: `settled` is how the finished rows finished,
   * `knownIntents` is everything this store can still SEE — which is what tells
   * "not finished yet" from "gone" — `chainWaits` is the edge list a cycle
   * shows up in, and `neverSettles` is the rows that never end at all, which is
   * a third way of never being in `settled` and the only one that is a property
   * of the predecessor's own SHAPE rather than of what has happened to it.
   *
   * All four are supplied together and always, never one at a time. An absent
   * fact means "nobody said" and makes every chain wait, so a pass that built
   * `settled` and skipped `knownIntents` would strand a row whose predecessor
   * had been cancelled instead of failing it — the one thing the second fact
   * exists to prevent.
   *
   * The live rows come first and the archive tail is merged UNDER them: a row
   * that is in both is the live one (it was archived and re-posted under the
   * same id, which `post()`'s upsert allows), and the live copy is the one this
   * store is still keeping promises about.
   */
  chainFacts(): Pick<IntentFacts, "settled" | "knownIntents" | "chainWaits" | "neverSettles"> {
    const archived = this.readArchiveTail();
    const settled = new Map<string, IntentSettlement>(archived);
    // Known = live, plus the archived rows that were FINISHED when they left.
    // A row `remove()`d while it was still queued is in the archive too, and it
    // is deliberately not known: it is never going to finish, so counting it
    // would leave the chain behind it waiting politely for ever under a
    // perfectly reasonable sentence — the one shape `knownIntents` exists to
    // turn into a failure somebody can read.
    const knownIntents = new Set<string>(archived.keys());
    const chainWaits = new Map<string, string>();
    // The rows that can never answer "finished", because they never stop:
    // `isRecurring` is already the one reading of recurrence in this file, and
    // its own note says it — a standing rule is never terminal and never
    // evicted. A chain hung off one would otherwise read "not yet" for ever.
    // Archived rows are not candidates: leaving the store IS terminating.
    const neverSettles = new Set<string>();
    for (const r of this.core.rows()) {
      knownIntents.add(r.id);
      if (isRecurring(r)) neverSettles.add(r.id);
      if (r.trigger.kind === "after") chainWaits.set(r.id, r.trigger.id);
      if (!isTerminal(r)) { settled.delete(r.id); continue; }
      // `settledAt` is what `settle()` stamps, and the two fallbacks are for
      // rows written by an older build: a terminal row with no stamp is still
      // over, and a chain behind it must not wait on a missing timestamp. `ok`
      // is the RESULT's, never the state's, except where there is no result at
      // all — `done` with nothing recorded is the only reading left.
      settled.set(r.id, { ok: r.result ? r.result.ok : r.state === "done", at: r.settledAt ?? r.result?.at ?? r.createdAt });
    }
    return { settled, knownIntents, chainWaits, neverSettles };
  }

  /**
   * The last `ARCHIVE_TAIL_BYTES` of the archive, as settlements.
   *
   * The first line of the slice is DROPPED unless the slice starts at byte 0:
   * a byte offset lands mid-row, and half a JSON object parses as nothing —
   * which would be harmless — or, worse, would have to be guessed at. Dropping
   * it costs one archived row at the far end of a bound that is already a
   * cut-off, and see `ARCHIVE_TAIL_BYTES` for what that cut-off means.
   *
   * Every failure answers an EMPTY map, never a throw: a chain whose facts
   * could not be read waits, which is the direction that cannot do damage, and
   * losing the archive must never take the tick with it.
   */
  private readArchiveTail(): ReadonlyMap<string, IntentSettlement> {
    let stamp: string;
    let size: number;
    try {
      const st = statSync(this.archivePath);
      size = st.size;
      stamp = `${st.size}:${st.mtimeMs}`;
    } catch {
      // No archive is not a failure — it is a host that has never compacted.
      // Cached as its own stamp so the `stat` is the whole cost per tick.
      if (this.archiveTail?.stamp !== "none") this.archiveTail = { settled: new Map(), stamp: "none" };
      return this.archiveTail.settled;
    }
    if (this.archiveTail?.stamp === stamp) return this.archiveTail.settled;
    const settled = new Map<string, IntentSettlement>();
    try {
      const from = Math.max(0, size - ARCHIVE_TAIL_BYTES);
      const buf = Buffer.alloc(size - from);
      const fd = openSync(this.archivePath, "r");
      try { readSync(fd, buf, 0, buf.length, from); } finally { closeSync(fd); }
      const lines = buf.toString("utf8").split("\n");
      if (from > 0) lines.shift();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as Partial<Intent>;
          if (typeof r?.id !== "string" || !r.id) continue;
          // Only what went TERMINAL is a settlement. The archive holds nothing
          // else today (`compact()` evicts settled rows only), and reading it
          // as if it might is what keeps that an invariant of `compact()`
          // rather than an assumption made in two files.
          if (r.state !== "done" && r.state !== "failed" && r.state !== "canceled") continue;
          settled.set(r.id, { ok: r.result ? r.result.ok === true : r.state === "done", at: r.settledAt ?? r.result?.at ?? r.createdAt ?? 0 });
        } catch { /* one unreadable line is one row, not a dead tail */ }
      }
    } catch { /* unreadable archive ⇒ no settlements ⇒ chains wait */ }
    this.archiveTail = { settled, stamp };
    return settled;
  }

  /**
   * Bound the live file WITHOUT deleting anything un-run.
   *
   * Never evicted: `queued`, `blocked`, `starting`, `running`, and every
   * recurring `at` rule (standing policy). May leave: `done`, `canceled`, and
   * `failed` only once it has been dismissed — "a terminal state the user has
   * seen", made mechanical. What leaves is APPENDED to the archive first, which
   * is what keeps "where did my words go" answerable.
   */
  private compact(serialized: string): boolean {
    const evictable = (i: Intent): boolean =>
      !isRecurring(i) && (i.state === "done" || i.state === "canceled" || (i.state === "failed" && !!i.dismissedAt));
    const settled = this.core.rows().filter(evictable).sort((a, b) => (a.settledAt ?? a.createdAt) - (b.settledAt ?? b.createdAt));
    let over = Math.max(0, settled.length - SETTLED_KEEP);
    if (Buffer.byteLength(serialized) > FILE_MAX_BYTES) over = Math.max(over, Math.ceil(settled.length / 2));
    if (!over) return false;
    const victims = settled.slice(0, over);
    this.archive(victims);
    const gone = new Set(victims);
    this.core.setRows(this.core.rows().filter((r) => !gone.has(r)));
    return true;
  }

  archive(rows: readonly Intent[]): void {
    if (!rows.length || this.readOnly()) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.archivePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    } catch { /* best-effort: losing the archive must never block the live write */ }
  }

  /**
   * Why the last write to `intents.json` failed, or null once one landed.
   *
   * A failed write used to be swallowed whole, and `post()`'s promise — *`ok`
   * means on DISK* — rested on it anyway: a full disk or a read-only state dir
   * acked rows that were never written, and after a restart a retry inside the
   * ack TTL ran the prompt again. Now `persist()` answers whether it wrote and
   * this keeps the reason, for the callers that can still refuse in words
   * (`write.ts`'s `post`/`upsert`, `fire.ts`'s `starting`). Every caller that
   * cannot take its write back (a settle, a tick's re-arm) keeps the old
   * posture: the in-memory rows still work for this boot.
   */
  private writeError: { at: number; message: string } | null = null;
  /** When the failure was last LOGGED: once per failing streak, then at most every `WRITE_ERROR_LOG_MS`. */
  private writeErrorLoggedAt = 0;
  /** When a person was last TOLD (`onWriteError`): once per streak, and never twice within `WRITE_ERROR_NOTICE_MS`. */
  private writeErrorToldAt = 0;

  /** The reason the last write failed, or null when the last write landed (or none was tried). */
  lastWriteError(): string | null { return this.writeError?.message ?? null; }

  /**
   * The ONE write to `intents.json`. `true` when the rows are on disk; `false`
   * when nothing was written — read-only this boot (`readOnly()` says why) or
   * the write failed (`lastWriteError()` says why). Never throws.
   */
  persist(): boolean {
    // Never downgrade a newer host's file (see `bootProblem`).
    if (this.readOnly()) return false;
    try {
      mkdirSync(this.dir, { recursive: true });
      // `{ schema, intents }` rather than the bare array v1 wrote — see `load()`
      // for what the number records and why the `.bak` beside it is the rollback.
      const envelope = (): string => JSON.stringify({ schema: STORE_SCHEMA, intents: this.core.rows() }, null, 2);
      let body = envelope();
      if (this.compact(body)) body = envelope();
      if (this.core.deps.files) this.core.deps.files.writeText(this.path, body);
      else { const tmp = this.path + ".tmp"; writeFileSync(tmp, body); renameSync(tmp, this.path); }
    } catch (e) {
      this.noteWriteFailed(String((e as Error)?.message ?? e));
      return false;
    }
    if (this.writeError) {
      console.log(`${logTag} intents.json is being written again (it had failed since ${new Date(this.writeError.at).toISOString()}: ${this.writeError.message})`);
      this.writeError = null;
      this.writeErrorLoggedAt = 0;
    }
    return true;
  }

  private noteWriteFailed(message: string): void {
    const now = Date.now();
    const first = !this.writeError;
    this.writeError = { at: this.writeError?.at ?? now, message };
    if (first || now - this.writeErrorLoggedAt >= WRITE_ERROR_LOG_MS) {
      this.writeErrorLoggedAt = now;
      console.error(`${logTag} could not write ${this.path} (${message}); new work is refused and nothing new starts until it can`);
    }
    // A person is told once per failing streak, never once per tick — and a
    // streak that starts again within the floor (a flapping disk) is not news.
    // Guarded: this can run inside the constructor's boot conversions, before
    // the daemon's notify is wired, and telling must never break a write path.
    if (first && (this.writeErrorToldAt === 0 || now - this.writeErrorToldAt >= WRITE_ERROR_NOTICE_MS)) {
      this.writeErrorToldAt = now;
      try { this.core.deps.onWriteError?.(message); } catch { /* the log line above stands */ }
    }
  }

  /** Write now, whatever a debounce would have said. Called on SIGTERM. */
  flush(): void { this.persist(); }

  /** The read a unit fake without `deps.files` gets: absent or unparseable ⇒ null, nothing moved. */
  private plainRead(): ReturnType<NonNullable<IntentCore["deps"]["files"]>["readGuarded"]> {
    try { return { value: JSON.parse(readFileSync(this.path, "utf8")) }; } catch { return { value: null }; }
  }
}
