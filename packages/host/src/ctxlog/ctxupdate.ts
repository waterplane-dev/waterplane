/** Advance a cursor over what the CLI appended: updateContextLog. Moved from ctxlog.ts. */
import { statSync } from "node:fs";
import type { TokenTotals } from "@waterplane/shared";
import { addCost, addTotals, costOf, isColdRebuild, normalizeModel, tokenTotal, zeroCost, zeroTotals } from "@waterplane/shared";
import { localDay, stamp, toMs } from "../convlog.js";
import { opensTurn } from "../transcript/transcriptlog.js";
import { RAW_CAP, EVENT_CAP, readRange, num, blankCold, blankCompaction, addSaved, remember, blank, skillLoadOf, pushSkill } from "./ctxcursor.js";
import type { SeriesCursor } from "./ctxcursor.js";

/**
 * Advance a cursor over whatever the CLI has appended since it was last read
 * — or build one from scratch.
 *
 * Null only when the file is not there. An empty or unreadable log yields an
 * empty cursor, because "the CLI has not written anything yet" and "the format
 * moved under us" are both states the caller has to be able to say out loud,
 * and neither is an error.
 */
export function updateContextLog(path: string, prev?: SeriesCursor | null): SeriesCursor | null {
  // A file that shrank, went backwards in time, or is a different path is a
  // different conversation as far as this is concerned — a fork writes a new
  // log under a new id, and a rewritten one cannot be appended to.
  const reusable = prev && prev.path === path && prev.size > 0;
  const cur = reusable ? prev : blank(path);
  // A stat, not a read: this runs on every poll, and a probe that READ the
  // file re-read up to MAX_READ of a big log each time only to learn its size.
  let st;
  try { st = statSync(path); } catch { return null; }
  const rewound = reusable && (st.size < cur.size || st.mtimeMs < cur.mtime);
  const from = reusable && !rewound ? cur.consumed : 0;
  // FORWARD, to the end, never a tail: a tail-read log started its totals,
  // its compactions and its chart in the middle and printed them as whole.
  // Incremental after the first pass, so the whole-file read happens once.
  let read = readRange(path, from);
  if (!read) return null;
  if (from === 0 && cur !== prev) { /* fresh cursor, nothing to reset */ }
  else if (from === 0) {
    cur.consumed = 0; cur.samples = []; cur.events = []; cur.turns = 0; cur.usageTok = 0;
    cur.split = zeroTotals();
    cur.cost = zeroCost(); cur.unpriced = 0;
    cur.models = []; cur.modelTok = []; cur.cum = zeroTotals();
    cur.compaction = blankCompaction(); cur.shedAuto = 0; cur.shedManual = 0;
    cur.pendingRebuild = null;
    cur.prevTok = 0; cur.prevAt = 0; cur.cold = blankCold();
    cur.autoCompactTok = null; cur.model = null; cur.effort = null; cur.skills = []; cur.truncated = false;
    cur.seen.clear(); cur.seenOrder.length = 0;
  }

  let added = 0;
  for (;;) {
  for (const line of read.lines) {
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
    // Cheap pre-filter: three quarters of a conversation log is tool results,
    // and `JSON.parse` on 20 MB of them is the whole cost of this function.
    //
    // The turn count needs the USER records too, and they carry no `usage`. The
    // bulk of them are tool results, so those are excluded by the one byte
    // sequence that cannot be forged from prose: inside a JSON string every
    // quote is escaped, so the unescaped `"type":"tool_result"` only ever
    // appears as real structure — a prompt that talks ABOUT tool results is
    // written `\"type\":\"tool_result\"` and still gets through.
    const maybeTurn = line.includes('"type":"user"') && !line.includes('"type":"tool_result"');
    if (!maybeTurn
      && !line.includes('"usage"') && !line.includes('"compactMetadata"') && !line.includes('"quotaLimits"')) continue;

    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    // A subagent's records are a different conversation's context, and on this
    // CLI they are not in this file at all — measured on this desktop: 0 of
    // 7,761 logs carry an `isSidechain` row, because a Task agent writes
    // `<conversation>/subagents/agent-*.jsonl` instead. The guard stays for the
    // older shape, and what those agents SPENT is added by `agentUsage()` off
    // that directory — counting the inline form here as well would double it on
    // any CLI that writes both.
    if (row.isSidechain === true) continue;
    if (maybeTurn) {
      if (opensTurn(row)) cur.turns++;
      // A skill body is a meta user record — never a turn, but the one
      // moment the log says a skill's text entered this window.
      const sk = skillLoadOf(row, stamp(row));
      if (sk) pushSkill(cur.skills, sk);
      // A user record is never a reading, a compaction or a wall — nothing
      // below this line can match one, and the stamp it lacks would drop it.
      continue;
    }
    const t = stamp(row);
    if (t == null) continue;

    const meta = row.compactMetadata as
      { trigger?: unknown; preTokens?: unknown; postTokens?: unknown } | undefined;
    if (meta && typeof meta === "object") {
      const trigger = meta.trigger === "auto" ? "auto" : meta.trigger === "manual" ? "manual" : undefined;
      const preTok = num(meta.preTokens);
      const postTok = num(meta.postTokens);
      cur.events.push({
        kind: "compact", t,
        ...(trigger ? { trigger } : {}),
        ...(preTok ? { preTok } : {}),
        ...(postTok ? { postTok } : {}),
      });
      // Newest wins: the threshold is a property of the CLI version and the
      // model in force, and both can change inside one conversation.
      if (trigger === "auto" && preTok) cur.autoCompactTok = preTok;
      // …and into the ledger. A boundary the log did not date with BOTH ends,
      // or did not say who asked for, is counted in `unmeasured` and enters no
      // figure: attributing it to the wrong trigger would answer "was typing
      // /compact worth it" with the CLI's own decisions folded in.
      if (trigger && preTok > 0 && postTok > 0 && preTok > postTok) {
        cur.compaction[trigger].count++;
        cur.compaction[trigger].shedTok += preTok - postTok;
        if (trigger === "auto") cur.shedAuto += preTok - postTok;
        else cur.shedManual += preTok - postTok;
        cur.pendingRebuild = trigger;
      } else cur.compaction.unmeasured++;
      continue;
    }

    const quota = row.quotaLimits as { status?: unknown; resetsAt?: unknown; rateLimitType?: unknown } | undefined;
    if (quota && typeof quota === "object" && quota.status === "rejected") {
      const resetAt = toMs(quota.resetsAt);
      const weekly = typeof quota.rateLimitType === "string" && quota.rateLimitType !== "five_hour";
      cur.events.push({ kind: "limit", t, ...(resetAt != null ? { resetAt } : {}), ...(weekly ? { weekly } : {}) });
      continue;
    }

    if (row.type !== "assistant") continue;
    const msg = row.message as { id?: unknown; model?: unknown; usage?: Record<string, unknown> } | undefined;
    if (!msg || typeof msg !== "object") continue;
    // The rejection above is written as an assistant turn too, with
    // `<synthetic>` for a model and a usage block of zeros. Plotting it would
    // put a hard drop to zero on the graph at every usage wall — the opposite
    // of what happened.
    if (msg.model === "<synthetic>") continue;
    const usage = msg.usage;
    if (!usage || typeof usage !== "object") continue;
    if (typeof msg.model === "string") cur.model = msg.model; // newest wins
    // Off the same record, so the pair always names one turn: a record with
    // no effort clears it rather than leaving the previous turn's beside it.
    cur.effort = typeof row.effort === "string" ? row.effort : null;
    if (typeof msg.id === "string" && !remember(cur, msg.id)) continue;
    const tok = num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
    // What the request sent AND what it wrote back. Counted before the `tok`
    // guard below on purpose: a turn that carried nothing readable still spent
    // its output, and dropping it would make the total quietly low.
    cur.usageTok += tok + num(usage.output_tokens);
    // The same tokens by kind, off the same record and behind the same guards,
    // so the split cannot come out disagreeing with the total beside it. The
    // 1-hour cache-write tier is READ (`tokenstats.ts` measured it at 84% of
    // all writes and present on every record carrying one) because it is what
    // the payback ratio in `cacheReading` is blended over; absent simply
    // prices at the cheaper tier, which is the conservative direction.
    const out = num(usage.output_tokens);
    // A record whose four counters are all zero is not a request that ran, and
    // `tokenstats.ts` drops it before its own turn counter. Dropped here too:
    // the totals are unaffected either way (it adds nothing), but the two
    // screens divide context BY these turns, and a denominator that counted
    // something on one screen and not the other is a per-turn figure that
    // disagrees with itself.
    const cc = usage.cache_creation as Record<string, unknown> | undefined;
    const bag: TokenTotals = {
      input: num(usage.input_tokens),
      output: out,
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
      cacheWrite1h: cc && typeof cc === "object" ? num(cc.ephemeral_1h_input_tokens) : 0,
      // A REQUEST, not a turn — see the field.
      turns: 1,
    };
    // The model's slot in this conversation's table, claimed on first sight.
    // Linear, over a list that is one or two entries long in every real log.
    //
    // Keyed by the ALIAS, not by the logged id. The log records dated snapshots
    // and the long-context marker beside the plain id — the same model at the
    // same price — and banded by raw id they are two slots, two colours and two
    // legend entries reading `opus-5` and `opus-5`. Measured on a real
    // conversation here: a parent and its own subagent took separate slots and
    // the bar came out a different colour from the band above it while both
    // sentences named one model. `pricing.ts` still prices the RAW id, which is
    // where the dated snapshot belongs.
    const raw = typeof msg.model === "string" ? msg.model : null;
    const mid = raw ? normalizeModel(raw) ?? raw : null;
    let mi = mid ? cur.models.indexOf(mid) : -1;
    if (mid && mi < 0) { mi = cur.models.length; cur.models.push(mid); cur.modelTok.push(0); }
    if (mi >= 0) cur.modelTok[mi] += tok + out;
    if (tok > 0 || out > 0) {
      addTotals(cur.split, bag);
      addTotals(cur.cum, bag);
      // …and what it cost, on THIS record's own model and day. One bag, two
      // accumulators, so the money and the tokens cannot come from different
      // sets of records; `cur.model` is deliberately not used here (it is the
      // newest one, and it would charge the whole conversation at whatever ran
      // last). An unpriced model adds to `unpriced` and to no cost line — see
      // the field.
      const c = costOf(bag, raw, localDay(t));
      if (c) addCost(cur.cost, c);
      else cur.unpriced += tokenTotal(bag);
    }
    if (tok <= 0) continue;
    // ── Did this request come back to an expired cache? ──────────────────
    //
    // Asked HERE, before `pendingRebuild` is consumed, because the request
    // after a compaction boundary is the one case that looks exactly like a
    // rebuild and is not: the window was thrown away on purpose, its rebuild
    // is charged to the compaction ledger three lines down, and counting it
    // here too would bill compacting twice.
    //
    // The event carries the GAP as well as the tokens, because "this turn
    // wrote 172k" is only alarming once you know the conversation had been
    // asleep for fourteen hours — and the curve cannot show it: the window
    // does not move, so the shape of the graph says nothing at all about the
    // turn that cost twenty times the one before it.
    if (isColdRebuild(cur.prevTok, bag, { afterCompaction: cur.pendingRebuild != null })) {
      const gapMs = cur.prevAt > 0 ? t - cur.prevAt : 0;
      cur.cold.count++;
      cur.cold.tok += bag.cacheWrite;
      cur.cold.lastAt = t;
      cur.cold.lastTok = bag.cacheWrite;
      // Priced on THIS record's own model and day, like everything else here.
      // Two figures: what the writes cost, and what they cost ABOVE reading
      // the same tokens back — the second is the money the clock spent rather
      // than the work, and it is the one the sentence leads with.
      const wrote = costOf(
        { input: 0, output: 0, cacheRead: 0, cacheWrite: bag.cacheWrite, cacheWrite1h: bag.cacheWrite1h },
        raw, localDay(t),
      );
      const asRead = costOf(
        { input: 0, output: 0, cacheRead: bag.cacheWrite, cacheWrite: 0, cacheWrite1h: 0 },
        raw, localDay(t),
      );
      if (wrote) {
        cur.cold.usd += wrote.total;
        if (asRead) cur.cold.premiumUsd += Math.max(0, wrote.total - asRead.total);
      }
      cur.events.push({ kind: "rebuild", t, wroteTok: bag.cacheWrite, prevTok: cur.prevTok, ...(gapMs > 0 ? { gapMs } : {}) });
    }
    cur.prevTok = tok;
    cur.prevAt = t;
    // What the compactions have saved by the time of THIS request, and what
    // the first one after a boundary paid to rebuild the window.
    //
    // Here, on a request that actually carried context, because that is what
    // the saving is about: a request re-sends the window, and every one of
    // them since a boundary re-sent `shed` fewer tokens than it would have.
    // A request that carried nothing re-sent nothing.
    if (cur.shedAuto > 0) addSaved(cur.compaction.auto, cur.shedAuto, raw, t);
    if (cur.shedManual > 0) addSaved(cur.compaction.manual, cur.shedManual, raw, t);
    if (cur.pendingRebuild) {
      const row = cur.compaction[cur.pendingRebuild];
      row.rebuildTok += bag.cacheWrite;
      const c = costOf(
        { input: 0, output: 0, cacheRead: 0, cacheWrite: bag.cacheWrite, cacheWrite1h: bag.cacheWrite1h },
        raw, localDay(t),
      );
      if (c) row.rebuildUsd += c.total;
      cur.pendingRebuild = null;
    }
    // The running total rides ALONG with the reading rather than being folded
    // out of the series later: `usageTok` counts requests the readings skip (a
    // turn that carried nothing readable still spent its output), so a cumsum
    // over `samples` would end somewhere below the total the same parse prints
    // three lines down. Two totals differing by a few percent is the most
    // convincing wrong number this file could produce.
    // The kinds ride ON the sample, not beside it: they are what the stacked
    // chart is drawn from, and a parallel array would have to survive the
    // downsampler's min/max pick — which reorders — to stay index-for-index.
    cur.samples.push({
      t, tok, used: cur.usageTok,
      kinds: [bag.input, bag.output, bag.cacheRead, bag.cacheWrite],
      cum: [cur.cum.input, cur.cum.output, cur.cum.cacheRead, cur.cum.cacheWrite],
      ...(mi >= 0 ? { model: mi } : {}),
    });
    added++;
  }

  const moved = read.consumed > cur.consumed;
  cur.consumed = read.consumed;
  cur.size = read.size;
  cur.mtime = read.mtime;

  if (cur.samples.length > RAW_CAP) {
    cur.samples.splice(0, cur.samples.length - RAW_CAP);
    cur.truncated = true;
  }
  if (!moved || cur.consumed >= cur.size) break;
  const next = readRange(path, cur.consumed);
  if (!next) break;
  read = next;
  }
  if (cur.events.length > EVENT_CAP) cur.events.splice(0, cur.events.length - EVENT_CAP);

  // The log is append-ordered, but a resumed conversation can interleave and a
  // tail read can start anywhere; the graph's x axis has to be monotonic. Only
  // worth doing when something actually arrived.
  if (added) cur.samples.sort((a, b) => a.t - b.t);
  if (added || from === 0) cur.events.sort((a, b) => a.t - b.t);
  return cur;
}

