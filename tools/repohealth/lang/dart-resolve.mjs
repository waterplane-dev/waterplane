/**
 * Dart directives -> tree paths: the import graph's half of the Dart pack.
 *
 * A directive's URI is one of
 *   - `dart:core`, `dart:io` ...          the SDK: external, no edge;
 *   - `package:NAME/p/x.dart`             this project's own code when NAME is a
 *                                         `pubspec.yaml` `name:` found in the
 *                                         tree, mapped to `<that dir>/lib/p/x.dart`;
 *                                         any other NAME is a dependency: external;
 *   - `../a/x.dart`, `x.dart`             relative to the importing file;
 *   - any other scheme (`file:`, `http:`) not code of this tree.
 *
 * `import`, `export` and `part` are all edges. `part of` is not: a part is the
 * same library as the file that lists it, and an edge back would draw a cycle
 * of length two out of every `part`/`part of` pair. The library lists its
 * parts, so the library reaches them; a part's own directives are none (Dart
 * forbids them), so the imports its code needs are attributed to the library.
 *
 * A URI ending in a generated suffix (`.g.dart`, `.freezed.dart` ...) names a
 * file the pack excludes from the tree, so it is not an edge and not a miss.
 */

/** Suffixes of generated Dart; the pack's `excludeSuffixes` reads this list. */
export const GENERATED_SUFFIXES = Object.freeze([".g.dart", ".freezed.dart", ".mocks.dart", ".gr.dart"]);

/** The pubspec `name:` of one file, or null. Top-level key only (column 0). */
export function pubspecName(text) {
  const m = /^name:[ \t]*['"]?([A-Za-z0-9_]+)['"]?[ \t]*(?:#.*)?$/m.exec(text);
  return m ? m[1] : null;
}

/**
 * The resolver's data for one tree: package name -> its directory ("" = root).
 * @param {{path: string}[]} entries  every `pubspec.yaml` of the tree
 * @param {(e: object) => string} textOf
 * @returns {{packages: Map<string, string>}}
 */
export function buildContext(entries, textOf) {
  const packages = new Map();
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const name = pubspecName(textOf(e));
    if (!name || packages.has(name)) continue;
    const slash = e.path.lastIndexOf("/");
    packages.set(name, slash === -1 ? "" : e.path.slice(0, slash));
  }
  return { packages };
}

/** `a/b/../c` -> `a/c`; climbing above the root clamps. */
function normalize(parts) {
  const out = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

/**
 * The tree path a URI names, or null when it names no code of this tree.
 * @param {string} uri
 * @param {string} from  repo-relative path of the file that wrote it
 * @param {{packages: Map<string, string>} | null} ctx
 */
export function resolveUri(uri, from, ctx) {
  if (GENERATED_SUFFIXES.some((s) => uri.endsWith(s))) return null;
  const pkg = /^package:([^/]+)\/(.+)$/.exec(uri);
  if (pkg) {
    const dir = ctx?.packages.get(pkg[1]);
    if (dir === undefined) return null;
    return normalize([...dir.split("/"), "lib", ...pkg[2].split("/")]);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri)) return null;
  const dir = from.split("/");
  dir.pop();
  return normalize([...dir, ...uri.split("/")]);
}

/** Every path a file's import/export/part directives name, in order, deduplicated. */
export function targetsOf(directives, from, ctx) {
  const out = [];
  const seen = new Set();
  for (const d of directives) {
    if (d.kind === "partof") continue;
    for (const uri of d.uris) {
      const p = resolveUri(uri, from, ctx);
      if (p && !seen.has(p)) {
        seen.add(p);
        out.push({ spec: uri, path: p });
      }
    }
  }
  return out;
}
