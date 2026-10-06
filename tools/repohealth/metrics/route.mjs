/**
 * Which active pack can read a given file, and what a metric says when none
 * of them can.
 *
 * ── Why this is one module and not three copies of a loop ──────────────────
 *
 * Three metrics need a BEHAVIOUR from a language rather than a fact about it:
 * `dups` and `deadexports` need a parser, `untested` needs the language's
 * rule for how a test names a module. Each one therefore has to answer the
 * same two questions before it can measure anything — which active pack owns
 * this file's extension, and what to report when the pack that owns it cannot
 * do the thing being asked. Written three times, those answers drift: one
 * metric skips an unreadable file, the next counts it as evidence, and the
 * row then says "untested" about a language nothing could open.
 *
 * `census.mjs` already decided WHICH packs are active and unioned their data
 * (extensions, test globs, hatch kinds). This is the other half of consuming
 * a pack — dispatch — and it lives here because the metrics are its only
 * callers and because it must stay a consumer of the published pack contract:
 * `exts`, `mentions`, `keysFor`, `analyzer()`, `analyzerReason`. Nothing below
 * names a language. A pack that lands tomorrow is routed by the same code as
 * the two that are here today, and a pack that declines a capability is
 * reported by the same sentence.
 *
 * ── Why a file is routed to ONE pack ───────────────────────────────────────
 *
 * A file's extension decides which language's rules apply to it, so a `.ts`
 * file is read by the TypeScript pack's parser and by no other. First match
 * in `PACKS` order wins, which is a decision only if two packs claim one
 * extension — `packs/index.mjs` fixes that order by hand and `census.mjs`
 * hashes it into the version string, so a collision is at least visible in a
 * diff. It is not refused the way a duplicate hatch kind is, because two packs
 * reading the same extension is a merge with a defensible answer (the first
 * one asked) while two packs counting the same hatch kind is a number that
 * belongs to neither.
 *
 * ── Why an unreadable file is skipped and never counted ────────────────────
 *
 * A file whose pack has no parser is not a file with no duplicates in it; a
 * file whose language has no import syntax here is not a module no test
 * names. Both are files nothing read. So a metric measures the files it can
 * read, and when that set is EMPTY the metric is absent with a reason naming
 * the packs that declined — never a confident zero over a tree nothing
 * opened. That rule is the whole reason the packs exist, and
 * `reasonFor()` below is the one place its sentence is written.
 */

/**
 * The active packs that claim at least one file extension.
 *
 * `common` is excluded by this rule rather than by name: it claims no
 * extensions, so it owns no file, so it can never be the reason a file went
 * unread. Naming it in an absence sentence would tell a reader to go and add
 * a parser to the pack that deliberately has none.
 *
 * @param {import("../types.mjs").EffectivePrereg} prereg
 * @returns {import("../types.mjs").ActivePack[]}
 */
export function sourcePacks(prereg) {
  return (prereg.PACKS ?? []).filter((p) => (p.pack?.exts?.length ?? 0) > 0);
}

/**
 * The active pack that owns this path's extension, or `null` when none does.
 *
 * `null` is reachable in a measured tree even though `isSource` agreed the
 * file is source: the union of extensions in `SRC.exts` is what made it
 * source, and this asks which single pack contributed the one it ends with.
 * The two answers only differ if a pack is dropped from the registry between
 * the config being built and a metric running, which cannot happen in one
 * process — but the caller still has to handle it, because a skipped file is
 * always safer than a file handed to the wrong language's parser.
 *
 * @param {string} path
 * @param {import("../types.mjs").EffectivePrereg} prereg
 * @returns {import("../types.mjs").ActivePack|null}
 */
export function packFor(path, prereg) {
  for (const p of prereg.PACKS ?? []) {
    if (p.pack?.exts?.some((e) => path.endsWith(e))) return p;
  }
  return null;
}

/**
 * The source packs that supply one capability — `mentions`, `keysFor`, an
 * `analyzer`. A pack declares a capability it does not have as an explicit
 * `null` (see `packs/common.mjs`), so "is this a function" is the whole test.
 *
 * @param {import("../types.mjs").EffectivePrereg} prereg
 * @param {string} cap
 */
export function packsWith(prereg, cap) {
  return sourcePacks(prereg).filter((p) => typeof p.pack?.[cap] === "function");
}

/**
 * Why a metric could read nothing, in the packs' own words.
 *
 * One sentence per source pack that declined, joined — a mixed tree can have
 * one pack that answers and one that does not, and the reader needs to know
 * which half of their repo the absence is about. `files` travels with each
 * name because that is the denominator that says whether the silence covers
 * the project or a handful of build scripts.
 *
 * With no source pack active at all the sentence names the whole pack list
 * instead: that is a repo written in something this engine has never heard
 * of, and "the common pack has no parser" would point at the wrong thing.
 *
 * @param {import("../types.mjs").EffectivePrereg} prereg
 * @param {(active: import("../types.mjs").ActivePack) => string|null} why  The
 *   sentence for one pack that cannot do the thing, or `null` when it can.
 */
export function reasonFor(prereg, why) {
  const packs = sourcePacks(prereg);
  if (packs.length === 0) {
    const names = (prereg.PACKS ?? []).map((p) => p.name).join(", ");
    return `no active pack reads this tree's source (active: ${names || "none"})`;
  }
  const lines = [];
  for (const p of packs) {
    const sentence = why(p);
    if (sentence) lines.push(`${sentence} (${p.name}, ${p.files} files at HEAD)`);
  }
  return lines.join("; ");
}

/**
 * The parsers the active packs can supply, by pack name, and the sentence for
 * the ones that cannot.
 *
 * `analyzer()` is called once per pack per call rather than per file: it is
 * the pack's chance to load a compiler, and the two metrics that use it walk
 * every file in the tree. A pack whose `analyzer()` returns `null` — the
 * TypeScript pack where `typescript` is not installed — is not an error and
 * not an empty parser; it is an absence that carries `analyzerReason`, which
 * is the sentence the row prints instead of a zero.
 *
 * The reason is built whether or not any analyzer loaded, because a mixed
 * tree needs it beside a value as much as instead of one.
 *
 * @param {import("../types.mjs").EffectivePrereg} prereg
 * @returns {{byPack: Map<string, {blocks: Function, idents: Function}>, reason: string}}
 */
export function analyzers(prereg) {
  const byPack = new Map();
  for (const p of packsWith(prereg, "analyzer")) {
    const a = p.pack.analyzer();
    if (a) byPack.set(p.name, a);
  }
  const reason = reasonFor(prereg, (p) => {
    if (typeof p.pack.analyzer !== "function") return "no analyzer for this language";
    // Asked of the map rather than by calling `analyzer()` a second time: one
    // call per pack per run, and the sentence can never disagree with the set
    // of parsers the caller was actually handed.
    return byPack.has(p.name) ? null : (p.pack.analyzerReason ?? "the analyzer did not load");
  });
  return { byPack, reason };
}
