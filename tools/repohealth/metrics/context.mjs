/**
 * What an agent carries before it has read a single line of the code.
 *
 * ── Why this disagrees with CLAUDE.md on purpose ────────────────────────────
 *
 * CLAUDE.md's own framing is that it is the always-on document and that skill
 * BODIES are on-demand and therefore free: "skill BODIES are on-demand and
 * never count against you". That is true of a skill nobody loads. It is not
 * true of these skills. `web`'s description says "Load BEFORE reading or
 * editing anything under packages/web"; CLAUDE.md's routing table says the
 * same thing as an instruction. So for any task that touches `packages/web`,
 * that body is not on-demand — it is a prerequisite, loaded every time, by
 * rule.
 *
 * This matters because the obvious metric says the problem is solved. CLAUDE.md
 * went from 148k chars to 11.7k and `claudemd.test.mjs` holds it there. Read
 * `claudeMdChars` alone and the line falls off a cliff and stays down. Read
 * `areas` and you can see whether the weight LEFT or merely MOVED into the
 * thing that is loaded immediately afterwards. A budget you can satisfy by
 * relocating is not a budget, and this row is what would show that.
 *
 * ── Why one number per area stopped being enough ───────────────────────────
 *
 * The first version of this metric read, per area, CLAUDE.md + every
 * description + THAT area's one skill body, because the routing table sent a
 * task to exactly one skill. Then `web` (109k) became a ~7.7k ROUTER plus
 * seven sub-skills, and `host` (77k) a ~3.4k router plus five, with nine
 * of its bullets folded into `heuristics`. Not one character of that
 * prose was deleted. A metric that reads the router alone would have printed a
 * ~90% fall for the week — this row committing, against itself, the exact
 * relocation-is-not-a-reduction failure the paragraph above says it exists to
 * catch.
 *
 * `MAX(sub body)` was the obvious repair and is wrong for the same reason one
 * level down: it pays for fragmentation. Split one 24k sub-skill into three 8k
 * ones and the MAX falls by two thirds while the sum is unchanged and the
 * agent loads the same prose. Any aggregator that reads ONE body can be
 * satisfied by moving bytes into another body.
 *
 * So an area reports two numbers that cannot both be moved by re-partitioning:
 *
 *   `expected`  the MEDIAN, over this repo's own non-batch commits, of
 *               CLAUDE.md + every description + the router + the bodies of the
 *               sub-skills that commit's own files would have made you load.
 *               What a real change in this area costs before it starts.
 *   `ceiling`   CLAUDE.md + every description + the router + the SUM of every
 *               sub-skill body in the area. What the area weighs in total, and
 *               what a task that has to cross it pays.
 *
 * Splitting a skill in two lowers `expected` and leaves `ceiling` flat, which
 * is precisely the distinction the row exists to draw: a split is a routing
 * improvement, not a deletion. Deleting or compressing prose moves both. A
 * fold into a skill the router still points at (the `heuristics` case)
 * moves neither, because the router's `also` keeps that skill inside the area
 * — see `Snapshot.areas`, which `snapshot.mjs` derives from each commit's own
 * tree.
 *
 * ── Which sub-skills a commit would have made you load ─────────────────────
 *
 * Ownership is not typed here and is not typed anywhere: a module belongs to
 * the skill whose bullet HEAD names it, `tools/skillmap.mjs` is the one
 * implementation of that rule, and `snapshot.mjs` runs it over each SKILL.md
 * at snapshot time into `SkillFile.headModules`. The router's own map is
 * generated from the same function and `claudemd.test.mjs` fails when it
 * drifts, so the map the agent reads and the map this metric costs are the
 * same map by construction.
 *
 * A commit is a task in an area when it touched a file in that area's source
 * GROUP. `src` names a group as `Snapshot.groups` spells it, so the test is
 * `groupOf(path, groups) === src` and not a prefix match: a group is a name,
 * `packages/web` is not a prefix of `packages/websocket` under `groupOf`, and
 * a repo whose groups are one segment deep would have matched half its tree
 * on a `startsWith`. Its modules are matched by BASENAME, which is how the
 * bullets name them; confusion across packages (`screenlog.ts` exists in host
 * and in web) cannot bite, because the candidate skills are only ever the one
 * area's.
 *
 * An area whose router names no group — `src: null`, which `snapshot.mjs`
 * reports when the description names none or two equally specific ones — can
 * have no commit attributed to it at all. Its `expected`, `p90` and `commits`
 * are then absent with a reason, and its `ceiling` still reports, because a
 * ceiling is a fact about the tree and does not need a history to be true.
 *
 * Two sub-skills claiming the same module (`sessions.ts`, in core and in
 * ledgers) count BOTH. The router says so in as many words — "a module on two
 * lines has rules in both" — and where it is genuinely ambiguous, the
 * direction to be wrong in is the expensive one: this row's whole job is to
 * refuse a discount nobody earned. A module no sub-skill claims costs the
 * router alone, which is what actually happens: you read the map, it names
 * nothing, you read the code.
 *
 * ── Why the median of all history, and why the denominator travels ─────────
 *
 * The median asks what a TYPICAL change loads; a mean would let one sprawling
 * commit that touched six slices define the number for an area normally edited
 * one file at a time. `p90` is carried next to it because the two together say
 * whether an area has a fat tail — an `expected` near the `ceiling` at p90 is
 * an area whose split is not doing any work.
 *
 * The sample is every non-batch commit at or before this one — no window, so
 * no threshold had to be chosen after seeing the plot it would produce. Batch
 * commits are excluded exactly as `cochange.mjs` excludes them and for the
 * same reason: this is a shared working tree, and a 160-file `git add` is a
 * day of unrelated work, not a task. The flag is read as the commit recorded
 * it, never recomputed.
 *
 * `commits` travels with `expected` the way `touches` travels with the
 * re-touch rate: a median over 4 commits and one over 300 are different
 * claims, and the number alone cannot tell them apart.
 *
 * ── Why the skill COUNT is here and is never ranked ───────────────────────
 *
 * `skillCount` is how many skills the always-on descriptions are the
 * descriptions OF, counted over the same filtered set (`COUNT_GENERATED_SKILLS`
 * decides both), so the two numbers can never describe different populations —
 * "10,160 chars" and "18 skills" have to be the same eighteen.
 *
 * It is plotted and it is NOT read against its own past. In a young repo a
 * rising skill count beside a shrinking CLAUDE.md is reference leaving the
 * always-on file on purpose, which is the thing this row was built to show; in
 * an old one the same rise can be the split being over-done. The number is the
 * same either way, and a percentile printed under it would answer a question
 * nobody measured. `readings.mjs` marks the series `plain` for exactly this,
 * and a plain series is drawn with the tool's reason where its rank would be.
 *
 * ── Why `visual-check` is counted here and exempt there ─────────────────────
 *
 * `packages/host/src/visualskill.ts` writes `.claude/skills/visual-check/` at
 * runtime, and `claudemd.test.mjs` skips it on its `generated-by:` frontmatter.
 * That test asks *who authored this file* — a machine-written preset is not
 * something CLAUDE.md's routing table should have to name. This metric asks
 * *what is loaded*, and a generated skill's description is listed to the agent
 * exactly like a hand-written one. Same file, two questions, two answers.
 * `PREREG.COUNT_GENERATED_SKILLS` records which one this is and is honoured
 * below rather than assumed, so flipping it is a visible change to a constant.
 *
 * ── Absence ─────────────────────────────────────────────────────────────────
 *
 * `skills: []` makes `descChars` and `skillCount` `null` with a reason, not a
 * row of zeros: before `.claude/skills` existed there was no split between
 * always-on and on-demand to measure, and plotting 0 there would draw a
 * fictional improvement across the exact commit that invented the thing being
 * measured. The two go absent together because they describe one population —
 * "10,160 chars" and "18 skills" have to be the same eighteen — so a measured
 * count beside an unmeasured total would be two different claims about the
 * same set.
 *
 * `claudeMdChars` is NOT covered by that argument and is measured whenever
 * the file exists. The sentence above is about a SPLIT, and a CLAUDE.md's
 * size is not a statement about one: it is the length of a file that is in
 * the tree, read every turn, with or without a `.claude/skills` directory
 * beside it. Making it wait for skills is what made this row absent in eight
 * of the thirteen repos on this desktop that HAVE a CLAUDE.md — `drive-coach`,
 * `Tiptoi`, `TalkingPictures`, `child-paint`, `Bluetooth-wlaki-talki`,
 * `realestatecalc`, `todolist`, `webcam` — each of them reporting "no
 * .claude/skills at this commit" against a series whose card promises "the
 * size of this repo's CLAUDE.md". An absence has to be about the thing that
 * is absent. A tree with no CLAUDE.md is still `null` with a reason, and the
 * reason is that one.
 *
 * An area whose ROUTER is not among the skills counted here
 * is omitted from `areas` rather than reported as CLAUDE.md + descriptions:
 * that sum is a real number for a file that does not exist. An area whose
 * router IS there but which no commit has touched yet reports its `ceiling` —
 * a fact about the tree — with `expected: null` and `commits: 0`, never an
 * `expected` of 0, which would read as a free area.
 *
 * And an EMPTY `areas` object carries a reason of its own, in `areasReason`.
 * This repo's history is the argument: the first sha with a `<router>-*`
 * skill is commit 156 of 170, so `areas: {}` is the honest state of almost
 * every row in it — and on a chart `{}` is indistinguishable from "this repo
 * does not work that way", which is the other thing it means, in every repo
 * with no router convention at all. Both are absences and this tool's rule is
 * that an absence carries a reason. The alternative — reading the empty
 * object and inferring which of the two it is — is the reader doing the
 * measurement's job from the outside.
 *
 * ── Purity ─────────────────────────────────────────────────────────────────
 *
 * Snapshot and history in, numbers out. No git, no filesystem, no model, and
 * nothing past `index` is read: a row recomputed years later is the same row.
 */
// Which group a path is in is decided once, per snapshot — see snapshot.mjs.
import { groupOf } from "../snapshot.mjs";

/**
 * The batch flag as the commit recorded it — see the header. `history.batch`
 * is the authority; the copy on the commit is the fallback so a hand-built
 * literal in a test can carry either one and mean the same thing.
 */
function isBatch(history, commit) {
  return history?.batch?.has(commit.sha) ?? commit.batch ?? false;
}

/**
 * The module BASENAMES a commit touched inside one area, or `null` when the
 * commit is not a task in that area at all.
 *
 * `null` and an empty set are different: a commit that touched nothing in
 * `packages/web` is not a cheap web change, it is not a web change.
 *
 * Membership is `groupOf(path, groups) === src` and never `startsWith`. `src`
 * is a group NAME with no trailing slash, so a prefix test would put
 * `packages/websocket/…` inside `packages/web` and, in a repo whose groups
 * are one segment deep, would put most of the tree inside the first area that
 * matched a letter.
 */
function touchedModules(history, commit, src, groups) {
  const paths = history?.touches?.get(commit.sha) ?? commit.filesTouched ?? [];
  const mods = new Set();
  let inArea = false;
  for (const path of paths) {
    if (groupOf(path, groups) !== src) continue;
    inArea = true;
    mods.add(path.slice(path.lastIndexOf("/") + 1));
  }
  return inArea ? mods : null;
}

/**
 * The sub-skills of an area: every skill named `<router>-*`, plus the ones
 * the area's `also` names — the skills the router routes to that are not
 * under its prefix. Sorted by name, because `snapshot.skills` is.
 *
 * @param {import("../types.mjs").Area} cfg
 */
function subSkillsOf(cfg, skills) {
  const prefix = cfg.router + "-";
  const also = new Set(cfg.also ?? []);
  return skills.filter((s) => s.name !== cfg.router && (s.name.startsWith(prefix) || also.has(s.name)));
}

/** basename -> the sub-skills whose bullet heads name it, in name order. */
function ownersByModule(subs) {
  const owners = new Map();
  for (const s of subs) {
    for (const mod of s.headModules ?? []) {
      let list = owners.get(mod);
      if (!list) owners.set(mod, (list = []));
      list.push(s);
    }
  }
  return owners;
}

/** Median of a non-empty list; the mean of the middle two when even. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Nearest-rank p90: the smallest observed value at or above the 90th
 * percentile. An interpolated percentile would invent a load no commit ever
 * had, which for a sum of whole skill bodies is a number that cannot exist.
 */
function p90(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.9 * sorted.length) - 1)];
}

/**
 * @param {import("../types.mjs").Snapshot} snapshot
 * @param {import("../types.mjs").History} history
 * @param {number} index
 * @param {import("../types.mjs").EffectivePrereg} prereg
 * @returns {import("../types.mjs").Measured<{claudeMdChars: number, descChars: number|null, skillCount: number|null, skillsReason?: string, areas: Record<string, {ceiling: number, commits: number|null, expected: number|null, p90: number|null, subs: number, reason?: string}>, areasReason?: string}>}
 */
export function measureContext(snapshot, history, index, prereg) {
  // The whole row is absent only when the always-on FILE is absent. The
  // skills are asked about second and cost their own two numbers, never this
  // one — see "Absence".
  const claudeMdChars = snapshot.claudeMdChars;
  if (claudeMdChars == null) return { value: null, reason: "no CLAUDE.md at this commit" };

  const all = snapshot.skills ?? [];
  const skills = prereg.COUNT_GENERATED_SKILLS ? all : all.filter((s) => !s.generated);
  const counted = skills.length > 0;

  // The always-on half: every description is listed to the agent whether or
  // not the skill is ever loaded, so they sum unconditionally. With no
  // counted skill the sum is an empty one and is NOT published — `counted`
  // decides that at the bottom, where the absence gets its reason.
  let descChars = 0;
  // The on-demand half, beside the always-on half: every counted skill's BODY.
  // Never in the index (a body costs only when invoked, which is the point of
  // the split), but a split that moves prose out of CLAUDE.md into bodies
  // should be visible as a move, not as a disappearance.
  let skillBodyChars = 0;
  for (const s of skills) {
    descChars += s.descriptionChars;
    skillBodyChars += s.bodyChars ?? 0;
  }

  const byName = new Map(skills.map((s) => [s.name, s]));
  // Read only inside the area loop below, which cannot run without a router
  // in `byName` — so it is never the empty sum above wearing a real number's
  // clothes.
  const base = claudeMdChars + descChars;
  const commits = history?.commits ?? [];
  const groups = snapshot.groups ?? [];

  /** @type {Record<string, {ceiling: number, commits: number|null, expected: number|null, p90: number|null, subs: number, reason?: string}>} */
  const areas = {};
  // `snapshot.areas` is already sorted by router, and the router name IS the
  // key: `web` would have to be cut off `web` by a rule that is this
  // repo's naming convention and nothing else's.
  for (const cfg of snapshot.areas ?? []) {
    const router = byName.get(cfg.router);
    // See "Absence" above: omitted, not floored. Reachable even though the
    // areas were derived from this same tree, because `COUNT_GENERATED_SKILLS`
    // can filter a router out of the set being costed after the area was
    // derived over all of them.
    if (!router) continue;

    const subs = subSkillsOf(cfg, skills);
    const owners = ownersByModule(subs);
    const floor = base + router.bodyChars;

    let ceiling = floor;
    for (const s of subs) ceiling += s.bodyChars;

    // No source group, no attribution. The ceiling is still a fact about the
    // tree — the prose exists and an agent entering this area loads it — so it
    // reports; the per-commit reading cannot, and says why rather than
    // printing a 0 that would read as an area nothing has ever cost.
    if (cfg.src === null) {
      areas[cfg.router] = {
        ceiling,
        commits: null,
        expected: null,
        p90: null,
        subs: subs.length,
        reason: `the ${cfg.router} description names no source group, so no commit can be attributed to it`,
      };
      continue;
    }

    // What each past change in this area would have made an agent load.
    const loads = [];
    for (let i = 0; i <= index && i < commits.length; i++) {
      const commit = commits[i];
      if (isBatch(history, commit)) continue;
      const mods = touchedModules(history, commit, cfg.src, groups);
      if (!mods) continue;
      const load = new Set();
      for (const mod of mods) for (const s of owners.get(mod) ?? []) load.add(s);
      let chars = floor;
      for (const s of load) chars += s.bodyChars;
      loads.push(chars);
    }

    areas[cfg.router] = {
      ceiling,
      commits: loads.length,
      expected: loads.length ? median(loads) : null,
      p90: loads.length ? p90(loads) : null,
      subs: subs.length,
    };
  }

  // `skills`, not `all`: the count and the character total describe the same
  // set, whichever way `COUNT_GENERATED_SKILLS` is set — and when there is no
  // such set they go absent together, for the same reason.
  return {
    value: {
      claudeMdChars,
      ...(counted
        ? { descChars, skillCount: skills.length, skillBodyChars }
        : { descChars: null, skillCount: null, skillsReason: skillsAbsent(all, prereg) }),
      areas,
      // Present only when there is nothing to read — see "Absence" above on
      // why `{}` alone is two different claims wearing one shape.
      ...(Object.keys(areas).length === 0 ? { areasReason: areasAbsent(snapshot) } : {}),
    },
  };
}

/**
 * Why `descChars` and `skillCount` came back absent: no skills in the tree, or
 * skills that this configuration does not count.
 *
 * Two facts and two sentences, because they are acted on differently. The
 * first is a repo with no `.claude/skills` — most of this fleet — and there is
 * nothing to fix. The second is a tree whose only skills are machine-written
 * and `PREREG.COUNT_GENERATED_SKILLS` is off, where the number is missing
 * because of a constant in this engine and not because of anything in the
 * repo. The old single sentence said "no .claude/skills at this commit" in
 * both cases, which is false in the second.
 */
function skillsAbsent(all, prereg) {
  if (all.length === 0) return "no .claude/skills at this commit";
  const n = all.length;
  return (
    `every skill in this tree is generated (${n}), and PREREG.COUNT_GENERATED_SKILLS ` +
    `is ${prereg.COUNT_GENERATED_SKILLS} — so none is counted as always-on here`
  );
}

/**
 * Why an `areas` object came back empty: no router in this tree, or routers
 * this measurement could not cost. Two different facts, and the difference is
 * what a reader would otherwise have to guess at from a flat line.
 */
function areasAbsent(snapshot) {
  const n = (snapshot.areas ?? []).length;
  return n === 0
    ? "no skill in this tree routes to another (no `<router>-*` convention)"
    : `none of the ${n} router${n === 1 ? "" : "s"} in this tree is among the skills counted here`;
}
