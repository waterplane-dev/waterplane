/**
 * The import graph between a tree's own modules: which files sit in an import
 * cycle, and how many modules one file loads.
 *
 * ── The question this answers that the other readings cannot ───────────────
 *
 * Size reads one file at a time; co-change reads what commits touched
 * together. Neither sees the STRUCTURE a change has to get through: a barrel
 * re-exporting a folder that imports the barrel back, a component that loads
 * sixty modules. Those are the shapes a codebase grown by accretion takes —
 * every new feature is one more import of the nearest thing that works — and
 * they are the shapes that make the next change expensive for a person and
 * for an agent alike, because touching one file of a cycle means
 * understanding all of it.
 *
 * Two readings, both from one pass, both language-neutral once a pack has
 * said what a file imports:
 *
 *   - **Cycles.** Strongly connected components of more than one module
 *     (Tarjan, iterative). `cycleFiles` is how many modules sit in one, and
 *     `cycles` lists the largest few with a sample of their members, so a
 *     number on the phone comes with the files to open. A self-import is not
 *     a cycle.
 *   - **Fan-out.** How many distinct modules of this tree each file imports;
 *     the nearest-rank p95 (`size.mjs`'s definition, imported, never a
 *     second one) and the max with its path. Packages from outside the tree
 *     are not edges: depending on `react` is not coupling between this
 *     project's files.
 *
 * ── Why the reading goes absent rather than low ────────────────────────────
 *
 * Every other metric here errs in a direction a reader can live with. This
 * one would not: an import the reader could not follow is a DELETED edge, and
 * a deleted edge removes cycles and lowers fan-outs — the tree a reader
 * understood least would score cleanest. So the pack says, for every
 * specifier, whether it names this project's code (`internal`), and the
 * share of those that reached a module is carried on the row as
 * `resolved`/`internal`. Below `PREREG.GRAPH_MIN_RESOLVED` the value is
 * `null` and the reason names the specifiers that did not resolve, which is
 * what a person needs to fix it (usually: declare the alias in `tsconfig`).
 *
 * A language whose pack has no import-graph rule is skipped, never counted
 * as a module with no imports; a tree where no pack has one is absent with
 * the packs' names, as every other pack-dependent metric reports.
 *
 * ── What is deliberately not here ──────────────────────────────────────────
 *
 * No layer rules ("web may not import host"): they need a declaration, and
 * this engine reads no repo's opinion of its own architecture. No reach or
 * depth yet: the two readings above are the ones that point at a file to
 * open. Dynamic `import()` IS an edge — it is how a lazy route loads a
 * module, and a cycle through one is still a cycle a reader has to hold.
 */

import { packFor, packsWith, reasonFor } from "./route.mjs";
import { nearestRankP95 } from "./size.mjs";

/** How many cycles the row lists, and how many members of each. */
const CYCLES_LISTED = 5;
const MEMBERS_LISTED = 6;
/** How many unresolved specifiers an absence names. */
const MISSES_NAMED = 5;

/**
 * Strongly connected components, iteratively — a recursive Tarjan overflows
 * the stack on a long import chain, and a history backfill meets one.
 *
 * @param {number} n
 * @param {number[][]} adj
 * @returns {number[][]} components of more than one node
 */
export function cyclesOf(n, adj) {
  const index = new Array(n).fill(-1);
  const low = new Array(n).fill(0);
  const onStack = new Array(n).fill(false);
  const stack = [];
  const out = [];
  let next = 0;
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    const work = [[root, 0]];
    index[root] = low[root] = next++;
    stack.push(root);
    onStack[root] = true;
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, i] = frame;
      if (i < adj[v].length) {
        frame[1]++;
        const w = adj[v][i];
        if (index[w] === -1) {
          index[w] = low[w] = next++;
          stack.push(w);
          onStack[w] = true;
          work.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
        continue;
      }
      work.pop();
      if (work.length) {
        const u = work[work.length - 1][0];
        low[u] = Math.min(low[u], low[v]);
      }
      if (low[v] === index[v]) {
        const comp = [];
        let w;
        do {
          w = stack.pop();
          onStack[w] = false;
          comp.push(w);
        } while (w !== v);
        if (comp.length > 1) out.push(comp);
      }
    }
  }
  return out;
}

/**
 * @param {import("../types.mjs").Snapshot} snapshot
 * @param {import("../types.mjs").History} _history
 * @param {number} _index
 * @param {import("../types.mjs").EffectivePrereg} prereg
 */
export function measureGraph(snapshot, _history, _index, prereg) {
  const files = snapshot.files ?? [];
  if (files.length === 0) return { value: null, reason: "no source files in this tree" };

  const speakers = packsWith(prereg, "graphImports").filter((p) => typeof p.pack.keysFor === "function");
  const noRule = (p) =>
    typeof p.pack.graphImports === "function" && typeof p.pack.keysFor === "function" ? null : "no import-graph rule for this language";
  if (speakers.length === 0) return { value: null, reason: reasonFor(prereg, noRule) };
  const speaks = new Set(speakers.map((p) => p.name));

  const readable = [];
  for (const f of files) {
    const owner = packFor(f.path, prereg);
    if (owner && speaks.has(owner.name)) readable.push({ f, owner });
  }
  if (readable.length === 0) {
    return { value: null, reason: reasonFor(prereg, noRule) || "no file in this tree belongs to a pack with an import-graph rule" };
  }

  // key -> every module answering to it. Two modules on one key (`x.ts` and
  // `x.tsx`, which no build accepts) are both edges, as in `untested`.
  const byKey = new Map();
  readable.forEach((r, i) => {
    for (const k of r.owner.pack.keysFor(r.f.path)) {
      const list = byKey.get(k);
      if (list) list.push(i);
      else byKey.set(k, [i]);
    }
  });

  const contexts = snapshot.graphContexts ?? {};
  const adj = readable.map(() => []);
  let internal = 0;
  let resolved = 0;
  const misses = new Map();
  readable.forEach((r, i) => {
    const out = new Set();
    for (const imp of r.owner.pack.graphImports(r.f, contexts[r.owner.name] ?? null)) {
      let hit = null;
      for (const key of imp.candidates) {
        if (byKey.has(key)) {
          hit = byKey.get(key);
          break;
        }
      }
      if (hit) {
        internal++;
        resolved++;
        for (const j of hit) if (j !== i) out.add(j);
      } else if (imp.internal) {
        internal++;
        misses.set(imp.spec, (misses.get(imp.spec) ?? 0) + 1);
      }
    }
    adj[i] = [...out].sort((a, b) => a - b);
  });

  if (internal > 0 && resolved / internal < prereg.GRAPH_MIN_RESOLVED) {
    const named = [...misses.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, MISSES_NAMED)
      .map(([spec, n]) => `\`${spec}\`${n > 1 ? ` ×${n}` : ""}`)
      .join(", ");
    return {
      value: null,
      reason:
        `only ${resolved} of ${internal} imports of this tree's own code resolved to a module ` +
        `(needs ${Math.round(prereg.GRAPH_MIN_RESOLVED * 100)}%); unresolved: ${named} — ` +
        `an alias the bundler knows and tsconfig "paths" does not declare reads like this`,
      internal,
      resolved,
    };
  }

  const comps = cyclesOf(readable.length, adj)
    .map((c) => c.map((i) => readable[i].f.path).sort())
    .sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
  const fan = adj.map((a) => a.length);
  let maxAt = 0;
  for (let i = 1; i < fan.length; i++) if (fan[i] > fan[maxAt]) maxAt = i;
  const edges = fan.reduce((s, n) => s + n, 0);

  return {
    value: {
      files: readable.length,
      edges,
      internal,
      resolved,
      cycleFiles: comps.reduce((s, c) => s + c.length, 0),
      cycleCount: comps.length,
      largestCycle: comps.length ? comps[0].length : 0,
      cycles: comps.slice(0, CYCLES_LISTED).map((c) => ({ size: c.length, files: c.slice(0, MEMBERS_LISTED) })),
      fanOutP95: nearestRankP95([...fan].sort((a, b) => a - b)),
      fanOutMax: fan[maxAt],
      fanOutMaxPath: readable[maxAt].f.path,
    },
  };
}
