/**
 * The model wheel's pure half: which models are spokes, which efforts are
 * rings, where a finger lands, and what picking a point DOES.
 *
 * A spiderweb chart turned into a control — one spoke per model, efforts from
 * the centre (lowest) out to the rim (highest). One point on it is one launch,
 * so "sonnet at high" is a single tap instead of two trips through a list.
 *
 * Split from `core/session/ModelWheel.tsx` so the rules are pinned without a
 * browser (`modelWheel.test.mjs`): a hit test that picks the neighbouring ring
 * is a relaunch on an effort nobody chose, and nothing about that throws.
 *
 * The catalogue is the BACKEND's (`modelChoices`), never one invented here.
 */
import { CACHE_READ_MULT, CACHE_WRITE_1H_MULT, fmtTok, fmtUsd, rateFor, type Effort } from "@waterplane/shared";

/** More than this and the inner ring's wedges get narrower than a fingertip. */
export const MAX_SPOKES = 9;

/** Every model the wheel COULD carry: the backend's aliases (short and few —
 *  what a wheel can hold), else its versioned ids. What the model chips under
 *  the wheel list, hidden or not. */
export function wheelCandidates(cat: { aliases: string[]; ids: string[] }): string[] {
  return cat.aliases.length > 0 ? cat.aliases : cat.ids;
}

/**
 * The spokes, in catalogue order: `wheelCandidates` minus the ones the person
 * took off the wheel (`hidden`), capped at `MAX_SPOKES`. The CURRENT model is
 * always one of them — appended when the catalogue does not name it, kept when
 * it is hidden — so the wheel can show where the session is before anything is
 * picked. Empty when the backend names no models at all — the wheel then has
 * nothing to draw.
 */
export function wheelSpokes(cat: { aliases: string[]; ids: string[] }, current?: string, hidden: readonly string[] = []): string[] {
  const base = wheelCandidates(cat).filter((m) => m === current || !hidden.includes(m));
  const room = current && !base.slice(0, MAX_SPOKES).includes(current) ? MAX_SPOKES - 1 : MAX_SPOKES;
  const out = base.slice(0, room);
  if (current && !out.includes(current)) out.push(current);
  return out;
}

/** Spoke label: the window suffix as a word a phone has room for, and no
 *  `claude-` prefix — a full id on the left spoke ran out of the drawing. */
export function spokeLabel(model: string): string {
  return model.replace(/^claude-/i, "").replace(/\[1m\]$/i, " 1M");
}

/**
 * Where the floating wheel's top goes, in viewport px: just under the button
 * that opened it while the whole popover fits below, slid up until it does
 * when not (a short phone, the chrome showing), never above `margin`. Past a
 * full viewport the CSS max-height caps it and it scrolls.
 */
export function wheelTop(anchorBottom: number, popH: number, viewH: number, margin = 8): number {
  return Math.max(margin, Math.min(anchorBottom + 6, viewH - popH - margin));
}

export interface WheelGeom {
  spokes: number;
  rings: number;
  /** Radius of the innermost ring and of the rim. */
  rIn: number;
  rOut: number;
}

/** Angle of spoke `i`, the first pointing straight up, going clockwise. */
export function spokeAngle(i: number, spokes: number): number {
  return -Math.PI / 2 + (i * 2 * Math.PI) / spokes;
}

export function ringRadius(ring: number, g: WheelGeom): number {
  return g.rings <= 1 ? g.rOut : g.rIn + (ring * (g.rOut - g.rIn)) / (g.rings - 1);
}

export function nodeXY(spoke: number, ring: number, g: WheelGeom): { x: number; y: number } {
  const a = spokeAngle(spoke, g.spokes);
  const r = ringRadius(ring, g);
  return { x: r * Math.cos(a), y: r * Math.sin(a) };
}

/**
 * Which point a finger at (x, y) — relative to the centre — means: the nearest
 * spoke by ANGLE and the nearest ring by RADIUS. So every point owns a whole
 * wedge, not a dot: the rings are a fingertip apart radially, and a target the
 * size of the drawn circle would miss more than it hits.
 *
 * Null near the centre (where every spoke meets and the angle means nothing)
 * and well outside the rim, so a tap there is not a pick.
 */
export function nodeAt(x: number, y: number, g: WheelGeom): { spoke: number; ring: number } | null {
  const r = Math.hypot(x, y);
  const step = g.rings > 1 ? (g.rOut - g.rIn) / (g.rings - 1) : g.rOut - g.rIn;
  if (r < Math.min(g.rIn * 0.45, g.rIn - step / 2) || r > g.rOut + Math.max(step, 18)) return null;
  const turn = 2 * Math.PI;
  const a = (((Math.atan2(y, x) + Math.PI / 2) % turn) + turn) % turn;
  const spoke = Math.round(a / (turn / g.spokes)) % g.spokes;
  const ring = g.rings <= 1 ? 0 : Math.max(0, Math.min(g.rings - 1, Math.round((r - g.rIn) / step)));
  return { spoke, ring };
}

export type WheelPlan =
  | { kind: "none" }
  /** Typed into the live session, in order. */
  | { kind: "live"; commands: string[]; model?: string; effort?: Effort }
  /** A launch flag: kill and relaunch this session on `patch`. */
  | { kind: "relaunch"; patch: { model?: string; effort?: Effort } };

/**
 * What picking (model, effort) does to a session running (cur.model, cur.effort).
 *
 * Both are LIVE where the CLI has the command: `/model <id>` and, for claude,
 * `/effort <level>` (read off the installed binary: "Usage: /effort <level>").
 * Model first, so an effort the new model caps is the CLI's to downgrade
 * rather than a stale one re-applied after it.
 *
 * A relaunch only where a change has no live command — no slash at all, or an
 * effort change on a backend without `/effort` — and then as ONE relaunch
 * carrying both fields, never a `/model` followed by a restart.
 * A null effort is "this backend has none".
 */
export function planPick(
  cur: { model?: string; effort?: Effort },
  pick: { model: string; effort: Effort | null },
  live: { slash: boolean; effort: boolean },
): WheelPlan {
  const modelChanged = pick.model !== cur.model;
  const effortChanged = pick.effort != null && pick.effort !== cur.effort;
  if (!modelChanged && !effortChanged) return { kind: "none" };
  const effortLive = live.slash && live.effort;
  if (!live.slash || (effortChanged && !effortLive)) {
    return { kind: "relaunch", patch: { ...(modelChanged ? { model: pick.model } : {}), ...(effortChanged ? { effort: pick.effort! } : {}) } };
  }
  const commands: string[] = [];
  if (modelChanged) commands.push(`/model ${pick.model}`);
  if (effortChanged) commands.push(`/effort ${pick.effort}`);
  return { kind: "live", commands, ...(modelChanged ? { model: pick.model } : {}), ...(effortChanged ? { effort: pick.effort! } : {}) };
}

/**
 * The list-priced model id an alias stands for, or null when that cannot be
 * said. An id prices as itself; a family alias (`opus`, `haiku[1m]`) as the
 * NEWEST id of that family in the backend's catalogue (newest first), which is
 * what the CLI's alias points at. `opusplan` runs two models and a custom name
 * runs who knows what — null, never a guess.
 */
export function pricedId(model: string | undefined, ids: string[]): string | null {
  const id = aliasTarget(model, ids);
  return id && rateFor(id) ? id : null;
}

/** `pricedId` without the price: the versioned id a model name stands for
 *  (an id as itself, a family alias as the newest id of that family), window
 *  suffix dropped, or null when that cannot be said. */
function aliasTarget(model: string | undefined, ids: string[]): string | null {
  if (!model) return null;
  const m = model.replace(/\[1m\]$/i, "");
  if (m.startsWith("claude-")) return m;
  if (!/^(opus|sonnet|haiku|fable)$/.test(m)) return null;
  return ids.map((i) => i.replace(/\[1m\]$/i, "")).find((i) => i.startsWith(`claude-${m}-`)) ?? null;
}

/**
 * Where the session IS, for the wheel: what its newest turn ran on
 * (`turnModel`/`turnEffort`, off the conversation log), else the launch flags.
 * A `/model` typed since launch moves the first and never the second — read
 * from the launch flags alone, the wheel offered the same switch again after
 * it had already landed, and it was sent five times.
 *
 * The log names a full id; the spokes are aliases. So the id goes back on the
 * spoke that stands for it: the launch model when it resolves to that id (which
 * keeps `opus[1m]`, a window the log does not record), else the catalogue's
 * alias that does, else the id itself. `from` says which source answered.
 */
export function wheelNow(
  cur: { model?: string; effort?: Effort; turnModel?: string; turnEffort?: Effort },
  cat: { aliases: string[]; ids: string[] },
): { model?: string; effort?: Effort; from: "turn" | "launch" } {
  if (!cur.turnModel) return { model: cur.model, effort: cur.effort, from: "launch" };
  const t = cur.turnModel;
  const spoke = aliasTarget(cur.model, cat.ids) === t ? cur.model
    : cat.aliases.find((a) => !/\[1m\]$/i.test(a) && aliasTarget(a, cat.ids) === t) ?? t;
  return { model: spoke, effort: cur.turnEffort ?? cur.effort, from: "turn" };
}

/**
 * Whether a switch sent from the wheel shows in the log yet: the newest turn
 * ran on the picked model (same string, or both resolve to one id) and at the
 * picked effort. Only a TURN reading can say so — the launch flags never move.
 */
export function wheelLanded(
  sent: { model?: string; effort?: Effort },
  now: { model?: string; effort?: Effort; from: "turn" | "launch" },
  ids: string[],
): boolean {
  if (now.from !== "turn") return false;
  const modelOk = !sent.model || sent.model === now.model
    || (aliasTarget(sent.model, ids) != null && aliasTarget(sent.model, ids) === aliasTarget(now.model, ids));
  return modelOk && (!sent.effort || sent.effort === now.effort);
}

export interface SwitchCostIn {
  /** The session's model and effort as launched, and the pick. */
  from: { model?: string; effort?: Effort };
  to: { model: string; effort: Effort | null };
  /** The backend catalogue's versioned ids, newest first. */
  ids: string[];
  /** Context the last turn carried, and the session's first reading — the
   *  tools-and-system preamble a messages-only reset keeps. Null = unmeasured. */
  tok: number | null;
  baseTok: number | null;
  /** `cacheLikelyCold`'s answer: true = the cache has very likely expired anyway. */
  cold: boolean | null;
}

/**
 * What a switch costs ON TOP of the work, as one sentence — or null when the
 * pick changes nothing.
 *
 * The prompt cache is per MODEL, so a model switch makes the next turn
 * re-WRITE the whole context into the new model's cache instead of re-reading
 * it from the old one. An effort change resets the conversation part of the
 * cache (the CLI sends effort as a request-level setting; the tools-and-system
 * preamble stays cached). Writes are priced at the 1-hour tier, the one every
 * main conversation on this desktop measured (`breakEvenTurns`' note), reads at
 * the model's own read rate. List prices, said so; a price that cannot be
 * sourced drops the money and keeps the fact.
 */
export function switchCostText(x: SwitchCostIn): string | null {
  const modelChanged = x.to.model !== x.from.model;
  const effortChanged = x.to.effort != null && x.to.effort !== x.from.effort;
  if (!modelChanged && !effortChanged) return null;
  if (x.cold === true) {
    return "Nothing has run here for over an hour and a half, so the cache has very likely expired already — the next turn re-writes the context whatever you pick, and switching adds nothing to that.";
  }
  if (modelChanged) {
    const head = "The prompt cache belongs to one model, so the next turn re-writes";
    if (x.tok == null || x.tok <= 0) return `${head} the whole context into the new model's cache instead of re-reading it.`;
    const toId = pricedId(x.to.model, x.ids);
    const fromId = pricedId(x.from.model, x.ids);
    const toRate = toId ? rateFor(toId) : null;
    const fromRate = fromId ? rateFor(fromId) : null;
    const tokText = `all ${fmtTok(x.tok)} tokens of context`;
    if (!toRate) return `${head} ${tokText} instead of re-reading them. No list price for ${x.to.model}, so no figure.`;
    const write = (x.tok * toRate.input * CACHE_WRITE_1H_MULT) / 1e6;
    const stay = fromRate ? (x.tok * (fromRate.cacheRead ?? fromRate.input * CACHE_READ_MULT)) / 1e6 : null;
    return `${head} ${tokText}: ≈ ${fmtUsd(write)} at list prices (as ${toId})${stay != null ? `, where staying re-reads it for ≈ ${fmtUsd(stay)}` : ""}. Turns after that run at the new model's rates.`;
  }
  const head = "Changing effort resets the conversation part of the cache, so the next turn re-writes";
  const msgs = x.tok != null && x.baseTok != null ? Math.max(0, x.tok - x.baseTok) : null;
  if (msgs == null || msgs <= 0) return `${head} the conversation instead of re-reading it.`;
  const id = pricedId(x.from.model, x.ids);
  const r = id ? rateFor(id) : null;
  if (!r) return `${head} about ${fmtTok(msgs)} tokens instead of re-reading them.`;
  const write = (msgs * r.input * CACHE_WRITE_1H_MULT) / 1e6;
  const stay = (msgs * (r.cacheRead ?? r.input * CACHE_READ_MULT)) / 1e6;
  return `${head} about ${fmtTok(msgs)} tokens: ≈ ${fmtUsd(write)} at list prices, where re-reading them costs ≈ ${fmtUsd(stay)}.`;
}
