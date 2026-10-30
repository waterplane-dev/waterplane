/**
 * A word for a value that crossed the wire.
 *
 * A `Record<Union, string>` table is total only for the build that compiled
 * it: a value a newer host (or a newer phone) adds is not a key here, and
 * `T[k]` reads `undefined` into a sentence. `wordOf` is the read that says
 * what an unknown key reads as. Own keys only, so `"constructor"` is unknown
 * too. Any value type: an icon table drawn as a component needs it most — an
 * `undefined` component is not a blank, it throws and takes the sheet down. Lint: `local/total-wire-words` (tools/eslint/totalwords.js).
 */
export function wordOf<K extends string, V = string>(table: Readonly<Record<K, V>>, k: string, fallback: V): V {
  return Object.prototype.hasOwnProperty.call(table, k) ? table[k as K] : fallback;
}
