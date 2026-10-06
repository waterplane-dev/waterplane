/**
 * **What colour a repo is** — the ring the hue comes from, the hash that picks
 * one, and the answer a person may pin over it.
 *
 * The colour is load-bearing rather than decorative: it is what tells the
 * launcher's group headers apart mid-scroll, what the session rows carry as a
 * left stripe, and — since the tab strip — what identifies a tab at ~85 px,
 * where the label is one word and an ellipsis. So it is the one part of the
 * palette a person is allowed to overrule, and the one that has to be picked
 * rather than hashed.
 *
 * **Why a RING and not the whole circle.** The first version was
 * `hash * 137.508 % 360` — a golden-angle spread, which spreads CONSECUTIVE
 * inputs and does nothing at all for arbitrary ones: two repo names hash to two
 * arbitrary numbers, and two arbitrary numbers land 3° apart about as often as
 * they land 100° apart. Measured on this machine, `myapp` and one worktree came
 * out 9° apart — two greens nobody could tell from each other in a strip 30 px
 * tall. A palette of hues chosen to be SEPARATE removes that failure by
 * construction: two repos are either the same colour or they are 28° apart, and
 * "the same" is a state the UI can see and offer to fix, while "nearly the
 * same" is one it cannot.
 *
 * **Only the HUE is a fact about the repo.** How light and how saturated that
 * hue has to be is a fact about the THEME and lives in `styles.css`
 * (`--repo-sat` / `--repo-lit`, swept over all 360 hues by `theme.test.mjs`).
 * That split is what lets this module hand out a number, and what keeps a
 * user-picked colour readable in both themes without them having to check.
 *
 * Everything here is pure and node-tested (`repocolor.test.mjs`): a colour that
 * changes under you is worse than one you dislike, so the hash, the ring order
 * and the override resolution are all pinned.
 */

/** One ring of hues a repo colour may be drawn from. */
export interface RepoPalette {
  /** Stored id. Never re-used for a different ring — that would re-colour every repo. */
  id: string;
  /** What the chips say. */
  label: string;
  /** One line on what this ring is FOR — the sheet prints it under the chips. */
  note: string;
  /**
   * The hues, in degrees. ORDER IS THE ASSIGNMENT: `hash % hues.length` indexes
   * this array, so inserting a hue in the middle re-colours every repo after
   * it. Append, or make a new palette.
   */
  hues: number[];
}

/**
 * The rings.
 *
 * `spectrum` is twelve hues at 28°–38° spacing — even round most of the circle
 * and wider through the greens, where HSL's hue axis is perceptually
 * compressed and 28° of it reads as one colour. Twelve because that is about
 * as many identities as a person keeps apart at a glance, and because more of
 * them means less space between them, which is the problem this exists to
 * solve.
 *
 * `cool` and `warm` are for somebody who wants the whole app to sit in one half
 * of the circle. They are SMALLER rings on purpose, and `warm` is smaller again
 * (six): the warm half is the narrower one, and eight hues in it measured 18°
 * apart — under the floor this module exists to hold.
 *
 * `cvd` is six hues that survive simulated protanopia, deuteranopia and
 * tritanopia — no red/green pair anywhere in it, which is what costs it the
 * other six. A hue GAP cannot say that (12° of hue and 40° of hue are the same
 * colour to a deuteranope), so the ring is measured where the sat and lit it is
 * drawn at are known: `web/theme.test.mjs`, beside the chart palettes, under
 * the same CIEDE2000-after-simulation code.
 */
export const REPO_PALETTES: readonly RepoPalette[] = [
  {
    id: "spectrum",
    label: "Spectrum",
    note: "Twelve hues round the whole circle, at least 28° apart.",
    hues: [200, 228, 256, 284, 312, 340, 8, 36, 64, 92, 130, 168],
  },
  {
    id: "cool",
    label: "Cool",
    note: "Green through violet — eight hues, nothing warmer than a jade.",
    hues: [100, 128, 156, 184, 208, 232, 260, 288],
  },
  {
    id: "warm",
    label: "Warm",
    note: "Magenta through amber — six hues, nothing colder than a gold.",
    hues: [300, 330, 356, 20, 46, 76],
  },
  {
    id: "cvd",
    label: "Colour-blind safe",
    note: "Six hues that survive simulated colour blindness — fewer colours, none confusable.",
    hues: [204, 30, 178, 348, 60, 248],
  },
];

/** The ring a device that has never been told anything uses. */
export const DEFAULT_PALETTE = "spectrum";

/** Palette by id, falling back to the default — an unknown id is an older or a
 *  newer client's, never a reason to draw nothing. */
export function paletteById(id: string | undefined): RepoPalette {
  return REPO_PALETTES.find((p) => p.id === id) ?? REPO_PALETTES[0];
}

/**
 * What this device knows about repo colour: which ring, and every hue a person
 * pinned by hand.
 *
 * `by` is keyed on the repo NAME rather than its id, because that is what every
 * drawing site already has (`repoAccentStyle(t.repo)`) and because a repo
 * re-cloned into another directory is the same repo to the person looking at
 * it.
 */
export interface RepoColors {
  palette: string;
  /** name → hue in degrees. A hue a person CHOSE; never a cached hash. */
  by: Record<string, number>;
}

export const NO_REPO_COLORS: RepoColors = { palette: DEFAULT_PALETTE, by: {} };

/** A hue as a number 0–359, or null for anything that is not one. */
function cleanHue(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const h = ((Math.round(v) % 360) + 360) % 360;
  return h;
}

/**
 * Read the stored value, tolerating every shape it has ever had and every shape
 * a hand-edit can produce. A junk entry is DROPPED, never drawn: the fallback
 * is the hash, which is always available and always readable.
 */
export function cleanRepoColors(raw: unknown): RepoColors {
  const src = (raw && typeof raw === "object" ? raw : {}) as Partial<RepoColors>;
  const palette = paletteById(typeof src.palette === "string" ? src.palette : undefined).id;
  const by: Record<string, number> = {};
  const rawBy = src.by && typeof src.by === "object" ? src.by as Record<string, unknown> : {};
  for (const [name, v] of Object.entries(rawBy)) {
    if (!name) continue;
    const h = cleanHue(v);
    if (h != null) by[name] = h;
  }
  return { palette, by };
}

/**
 * The name hash. FNV-ish, and deliberately the same arithmetic `format.ts`'s
 * `repoHue` shipped with — what changed is what the number is used FOR (an
 * index into a ring, not an angle), so a repo keeps a stable identity across
 * the change instead of every colour in the app moving at once.
 */
export function repoNameHash(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

/** The hue this ring gives that name with nobody having said otherwise. */
export function autoHue(name: string, palette: RepoPalette): number {
  return palette.hues[repoNameHash(name) % palette.hues.length];
}

/** The hue a repo is drawn in: what a person pinned, else what the ring says. */
export function repoHueIn(name: string, cfg: RepoColors): number {
  const pinned = cfg.by[name];
  if (typeof pinned === "number") return pinned;
  return autoHue(name, paletteById(cfg.palette));
}

/** Is this repo's colour a person's answer, or the ring's? */
export function isPinned(name: string, cfg: RepoColors): boolean {
  return typeof cfg.by[name] === "number";
}

/** Pin a hue (or clear one with `null`), returning a NEW config. */
export function setRepoColor(cfg: RepoColors, name: string, hue: number | null): RepoColors {
  const by = { ...cfg.by };
  if (hue == null) delete by[name];
  else {
    const h = cleanHue(hue);
    if (h == null) return cfg;
    by[name] = h;
  }
  return { ...cfg, by };
}

/** Switch rings. Pinned answers SURVIVE — a person who picked a colour picked
 *  that colour, not "slot 4 of whatever ring is current". */
export function setPalette(cfg: RepoColors, id: string): RepoColors {
  return { ...cfg, palette: paletteById(id).id };
}

/** Circular distance between two hues, in degrees (0–180). */
export function hueGap(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return Math.min(d, 360 - d);
}

/**
 * Repos that end up wearing the SAME colour, grouped.
 *
 * This is the one thing a ring cannot prevent and a person cannot be expected
 * to notice from two screens away: with twelve hues and fourteen repos, two of
 * them collide, and the collision is invisible until the two headers happen to
 * be on screen together. Named, it becomes a thing the sheet can offer to fix.
 *
 * Groups of ONE are not returned — a colour worn by one repo is not a clash.
 * `names` is taken in the caller's order and the groups come back in the order
 * their first member appears, so the list does not shuffle between renders.
 */
export function repoColorClashes(names: readonly string[], cfg: RepoColors): string[][] {
  const seen = new Map<number, string[]>();
  const order: number[] = [];
  for (const n of names) {
    const h = repoHueIn(n, cfg);
    const g = seen.get(h);
    if (g) g.push(n);
    else { seen.set(h, [n]); order.push(h); }
  }
  return order.map((h) => seen.get(h)!).filter((g) => g.length > 1);
}

/**
 * The hue in this ring the fewest of these repos already wear, ties broken by
 * ring order — what "give me a different colour" means when there is no
 * different colour left unused.
 *
 * `except` is the repo being re-coloured: its own current hue must not count
 * against the ring, or re-rolling a repo that is alone on its colour would keep
 * suggesting the colour it already has.
 */
export function freeHue(names: readonly string[], cfg: RepoColors, except?: string): number {
  const ring = paletteById(cfg.palette).hues;
  const used = new Map<number, number>();
  for (const n of names) {
    if (n === except) continue;
    const h = repoHueIn(n, cfg);
    used.set(h, (used.get(h) ?? 0) + 1);
  }
  let best = ring[0], bestN = Infinity;
  for (const h of ring) {
    const n = used.get(h) ?? 0;
    if (n < bestN) { best = h; bestN = n; }
  }
  return best;
}

/**
 * Give every one of these repos a colour of its own, as far as the ring allows.
 *
 * The rules, in order, because this OVERWRITES what people can see:
 *
 *  - **A pinned colour is never moved.** Somebody chose it; a tidy-up that
 *    silently un-chooses it is the draft-clobber rule wearing a different hat.
 *  - **A repo already alone on its hue keeps it**, pinned or not, so the tap
 *    changes as little as possible and the repos you already recognise stay
 *    recognisable.
 *  - Everything left takes the least-used hue at the time it is reached, in the
 *    caller's order — so the result is deterministic and the same list run
 *    twice is a no-op the second time.
 *
 * With more repos than hues it does what the ring allows and no more: the
 * remainder double up, which the caller still sees through `repoColorClashes`.
 */
export function spreadRepoColors(names: readonly string[], cfg: RepoColors): RepoColors {
  let out = cfg;
  const count = new Map<number, number>();
  for (const n of names) {
    const h = repoHueIn(n, out);
    count.set(h, (count.get(h) ?? 0) + 1);
  }
  for (const n of names) {
    if (isPinned(n, cfg)) continue;
    const h = repoHueIn(n, out);
    if ((count.get(h) ?? 0) <= 1) continue;
    const next = freeHue(names, out, n);
    if (next === h) continue;
    count.set(h, (count.get(h) ?? 1) - 1);
    count.set(next, (count.get(next) ?? 0) + 1);
    out = setRepoColor(out, n, next);
  }
  return out;
}

/** How many repos this ring can colour before two of them must share. */
export const paletteSize = (id: string): number => paletteById(id).hues.length;
