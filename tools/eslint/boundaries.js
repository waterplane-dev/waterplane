/**
 * The three import-boundary rules — web feature folders, host layers, the
 * extension seam — and the pure deciders their tests call. Split out of
 * `rules.js` by subject. It imports nothing, not even `node:path`.
 */

/**
 * `packages/web/src/features/<name>/` is a folder a change can stay inside.
 *
 * The web client was one 17k-line `App.tsx` that every feature edited, so every
 * change conflicted with every other. Features now live in folders, and the
 * point of a folder is lost the first time one reaches into another — so the
 * import graph is the boundary, checked here on the import's PATH alone
 * (docs/notes/web-architecture.md):
 *
 *  - a file under `features/<a>/` may import its own folder, the SDK's index
 *    (`sdk`), any top-level `src/*` module, and packages — never another
 *    feature, never `core/`, never `App`, never the registry;
 *  - `sdk/` never imports a feature. The registry is read only by the four
 *    core runners that call INTO features (`core/dispatch.ts`, `sheets.ts`,
 *    `settingsRows.ts`, `toolbarItems.ts`);
 *  - anything else reaches a feature only through its `index`, and only
 *    `App.tsx`, `core/**` (a core screen reads a feature's hook rather than
 *    having thirty verbs re-plumbed through props) and the registry may do
 *    so: a top-level module that imports a feature makes that feature's
 *    change a change there too;
 *  - a feature never takes a VALUE import of `ws`, `outbox`, `routing`, `App`
 *    or `main` — the socket, the send queue and the route stack are App's, and
 *    reached through `core()`. `import type` is fine: a type is not a coupling
 *    at run time, and re-declaring `Overlay` in a feature would be the drift.
 */
/** Top-level modules a feature may not import a VALUE from, and why. */
export const FEATURE_DENY = {
  ws: "the socket is the core's — `core().conn`",
  outbox: "the send queue is the core's — `core().queue`",
  routing: "the route stack is the core's — `core().nav`",
  App: "a feature never imports App — ask through `core()`",
  main: "main.tsx is the entry point, never a library",
};
/** Who may import `features/<x>` (its index) besides the feature itself. */
/** Besides these, every `core/**` module may import a feature — by its index. */
const FEATURE_IMPORTERS = new Set(["App", "features/registry"]);
/** The core modules that call INTO features at run time, and so read the list. */
const REGISTRY_READERS = new Set(["core/dispatch", "core/sheets", "core/settingsRows", "core/toolbarItems", "core/extensionPoints"]);
const WEB_SRC = /(^|\/)packages\/web\/src\//;
/** `a/b/index.ts` → `a/b`; `a/b.tsx` → `a/b`. */
const bareSpec = (p) => p.replace(/\.(tsx?|mjs|js)$/, "").replace(/\/index$/, "");
/** POSIX normalise without `node:path`, so this file stays import-free. */
function normalise(parts) {
  const out = [];
  for (const s of parts) {
    if (!s || s === ".") continue;
    if (s === "..") { if (!out.length) return null; out.pop(); } else out.push(s);
  }
  return out.join("/");
}
/** Where an import lands, relative to `src/`, or null when it leaves `src/`
 *  (a package, or a path out of the web tree — not this rule's business). */
function srcTarget(fromRel, source) {
  if (!source.startsWith(".")) return null;
  const dir = fromRel.split("/").slice(0, -1);
  const t = normalise([...dir, ...source.split("/")]);
  return t === null ? null : bareSpec(t);
}
/** Why `fromRel` may not import `to` (both relative to `src/`), or null. */
export function featureBoundary(fromRel, to, typeOnly = false) {
  const from = bareSpec(fromRel);
  const fromFeat = /^features\/([^/]+)\//.exec(fromRel)?.[1];
  const toFeat = /^features\/([^/]+)(\/|$)/.exec(to)?.[1];
  if (fromFeat) {
    if (toFeat === fromFeat) return null;
    if (to === "features/registry") return "a feature is LISTED by the registry and never reads it";
    if (toFeat) return `features/${fromFeat} imports features/${toFeat} — features never import each other; move what both need to sdk/ or a top-level module`;
    if (to === "sdk") return null;
    if (to.startsWith("sdk/")) return "import the SDK by its index (`sdk`) — that index IS the contract";
    if (to === "core" || to.startsWith("core/")) return "core/ is App's side of the contract — a feature reaches it through `core()` from `sdk`";
    if (Object.hasOwn(FEATURE_DENY, to)) return typeOnly ? null : `value import of \`${to}\`: ${FEATURE_DENY[to]} (\`import type\` is fine)`;
    if (!to.includes("/")) return null;
    return `\`${to}\` is not a top-level module, the SDK or this feature's own folder`;
  }
  if (!toFeat && to !== "features/registry") return null;
  if (to === "features/registry") {
    return REGISTRY_READERS.has(from) ? null
      : "only core/dispatch, core/sheets, core/settingsRows, core/toolbarItems and core/extensionPoints read the registry";
  }
  if (/^sdk\//.test(fromRel)) return "sdk/ never imports a feature — the feature imports it";
  if (to !== `features/${toFeat}`) return `reach features/${toFeat} through its index, not \`${to}\``;
  return FEATURE_IMPORTERS.has(from) || from.startsWith("core/") ? null
    : `only App.tsx and core/ import a feature — \`${from}\` would make features/${toFeat}'s change its change too; reach it through App or core()`;
}

/** @type {import("eslint").Rule.RuleModule} */
export const featureBoundaryRule = {
  meta: {
    type: "problem",
    docs: { description: "a change in features/<x> stays in features/<x>" },
    schema: [],
    messages: {
      boundary: "A change in features/<x> stays in features/<x>: {{why}}. See docs/notes/web-architecture.md.",
    },
  },
  create(ctx) {
    const file = (ctx.filename ?? ctx.getFilename()).replace(/\\/g, "/");
    const m = WEB_SRC.exec(file);
    if (!m) return {};
    const fromRel = file.slice(m.index + m[0].length);
    const check = (node, src, typeOnly = false) => {
      if (!src || src.type !== "Literal" || typeof src.value !== "string") return;
      const to = srcTarget(fromRel, src.value);
      if (to === null) return;
      const why = featureBoundary(fromRel, to, typeOnly);
      if (why) ctx.report({ node: src, messageId: "boundary", data: { why } });
    };
    // `import type {…}`, or `import { type A, type B }` — erased at build, so
    // no run-time edge. A side-effect import (`import "./ws"`) is a VALUE one.
    const allType = (node, kind, specKind) => node[kind] === "type"
      || (node.specifiers.length > 0 && node.specifiers.every((s) => s[specKind] === "type"));
    return {
      ImportDeclaration(node) { check(node, node.source, allType(node, "importKind", "importKind")); },
      ExportNamedDeclaration(node) { check(node, node.source, node.source ? allType(node, "exportKind", "exportKind") : false); },
      ExportAllDeclaration(node) { check(node, node.source, node.exportKind === "type"); },
      ImportExpression(node) { check(node, node.source); },
    };
  },
};

/**
 * `packages/host/src/`: the three big files become facades over sliced folders.
 *
 * `sessions.ts`, `intents/manager.ts` and `main.ts` held 11.5k lines between
 * them and every daemon change conflicted in one; the fix is folders a change
 * can stay inside (`sessions/`, `intents/`, `server/`), and the folders only
 * stay that while the edges between them are held. The table and the reason
 * for every refusal: docs/notes/host-architecture.md, "The layers, and what
 * may import what". In short:
 *
 *  - a slice (`sessions/<x>`, `intents/<x>`) never imports its facade (the
 *    cycle Node half-loads) nor another slice — it asks its core;
 *  - everything outside reaches `sessions/` through `sessions` and `intents/`
 *    through `intents/manager` / `intents/adapters` (`import type` of an inner
 *    file is the one relaxation, for flat modules, routes and server files);
 *  - `main` is imported by nobody; `server/` by nobody but `main` and itself;
 *    `routes/` not by a flat module; `intents/manager` is a leaf;
 *  - `backends/` and `capture/` are leaves over flat modules.
 */
const HOST_SRC = /(^|\/)packages\/host\/src\//;
const isUnder = (to, dir) => to === dir || to.startsWith(dir + "/");
const WHY_H = {
  main: "the entry point is never a library — nothing imports `main`",
  sessInner: "reach sessions through its facade `sessions`, not an inner `sessions/` file (`import type` is fine)",
  intInner: "reach the intent store through `intents/manager` (or `intents/adapters`), not an inner file (`import type` is fine)",
  server: "a route or module is called by the server and never reaches back into `server/`",
  routes: "a flat module is called BY a route and never imports `routes/`",
  apiRouter: "`api` is the HTTP router over the `routes/api*` tables — a table never imports its router (that is the cycle)",
  sliceFacade: "a slice never imports its facade — that is the cycle; ask `core`",
  sliceSlice: "a slice reaches another slice through `core`, never by import",
};

/** Why `fromRel` may not import `to` (both relative to host `src/`, bare), or null. */
export function hostBoundary(fromRel, to, typeOnly = false) {
  // Extension stripped but NOT index-folded: `routes/index.ts` is a route and
  // `sessions/index.ts` would be a slice — only `sessions.ts` is the facade.
  const from = fromRel.replace(/\.(tsx?|mjs|js)$/, "");
  // `deliver/` is the ONE delivery implementation cut into halves behind `deliver.ts`
  // (host-architecture.md, "The deliver slices"): nothing else — main included — may
  // reach a half, or there are two ways to type into a session.
  if (to.startsWith("deliver/") && from !== "deliver" && !from.startsWith("deliver/")) {
    return `\`${from}\` imports \`${to}\`: delivery is reached only through the facade \`deliver\` — never fork deliver.ts`;
  }
  if (from.startsWith("deliver/") && to === "deliver") return `\`${from}\` imports \`deliver\`: a slice never imports its facade — that is the cycle; what a half needs is passed in`;
  if (from === "main") return null;
  const intOuter = to === "intents/manager" || to === "intents/adapters";

  // The two facades and the intent store's own folder first.
  if (from === "sessions") {
    if (to === "main") return WHY_H.main;
    if (isUnder(to, "server")) return "the sessions facade never reaches into `server/` — the server calls it";
    if (isUnder(to, "routes")) return "the sessions facade never imports `routes/` — a route calls it";
    if (isUnder(to, "intents")) return "the sessions facade never imports `intents/` — what it needs of the store is passed in";
    return null;
  }
  if (from.startsWith("sessions/")) {
    if (to === "sessions/core" || to === "sessions/knobs") return null;
    if (to === "sessions") return `\`${from}\` imports \`sessions\`: ${WHY_H.sliceFacade}`;
    if (to.startsWith("sessions/")) return `\`${from}\` imports \`${to}\`: ${WHY_H.sliceSlice}`;
    if (to === "main") return WHY_H.main;
    if (isUnder(to, "server")) return "a sessions slice never reaches into `server/`";
    if (isUnder(to, "routes")) return "a sessions slice never imports `routes/`";
    if (isUnder(to, "intents")) return "a sessions slice never imports `intents/` — the store is not the session's";
    return null;
  }
  if (from === "intents/manager") {
    if (to.startsWith("intents/")) return null;
    return `\`intents/manager\` imports \`${to}\`: the intent store is a leaf; what it needs is injected as \`IntentDeps\``;
  }
  if (from === "intents/adapters") {
    if (to === "intents/manager") return null;
    return `\`intents/adapters\` imports \`${to}\`: adapters reads the store's constants from \`intents/manager\` and nothing else in the package`;
  }
  if (from.startsWith("intents/")) {
    if (to === "intents/contract") return null;
    if (to === "intents/manager") return `\`${from}\` imports \`intents/manager\`: ${WHY_H.sliceFacade} (\`IntentCore\` in \`intents/contract\`)`;
    if (to.startsWith("intents/")) return `\`${from}\` imports \`${to}\`: ${WHY_H.sliceSlice} (\`IntentCore\` in \`intents/contract\`)`;
    return `\`${from}\` imports \`${to}\`: an intents slice reaches only \`intents/contract\` — the store is a leaf; what it needs is injected`;
  }
  if (from.startsWith("backends/") || from.startsWith("capture/")) {
    const leaf = from.split("/")[0];
    if (to === "main") return WHY_H.main;
    if (to === "sessions" || isUnder(to, "sessions") || isUnder(to, "intents") || isUnder(to, "routes") || isUnder(to, "server")) {
      return `\`${leaf}/\` is a leaf: it imports flat modules only, never \`${to}\` — that module calls it`;
    }
    return null;
  }

  // The outer layers: server/, routes/, flat modules.
  const inServer = from.startsWith("server/");
  // `api.ts` is the HTTP twin of `routes/index.ts`: it dispatches over the
  // `routes/api*` tables, so it has a route's rights (host-architecture.md,
  // "api.ts — the HTTP routes as tables"). Every other flat module keeps the refusal.
  const isApi = from === "api";
  const inRoutes = from.startsWith("routes/") || isApi;
  // A `deliver/` half has its facade's rights: it is `deliver.ts`, moved.
  const flat = !from.includes("/") || from.startsWith("deliver/");
  if (!inServer && !inRoutes && !flat) return null; // no other folder exists; the shape test names new ones
  if (to === "main") return WHY_H.main;
  if (to.startsWith("sessions/")) return typeOnly ? null : `\`${to}\`: ${WHY_H.sessInner}`;
  if (isUnder(to, "intents") && !intOuter) return typeOnly ? null : `\`${to}\`: ${WHY_H.intInner}`;
  if (inServer) return null;
  if (isUnder(to, "server")) return `\`${from}\` imports \`${to}\`: ${WHY_H.server}`;
  if (inRoutes && !isApi && to === "api") return `\`${from}\` imports \`api\`: ${WHY_H.apiRouter}`;
  if (inRoutes) return null;
  if (isUnder(to, "routes")) return `\`${from}\` imports \`${to}\`: ${WHY_H.routes}`;
  return null;
}

/** @type {import("eslint").Rule.RuleModule} */
export const hostBoundaryRule = {
  meta: {
    type: "problem",
    docs: { description: "host slices reach shared state through their core; facades are the only way in" },
    schema: [],
    messages: {
      boundary: "Host layering: {{why}}. See docs/notes/host-architecture.md.",
    },
  },
  create(ctx) {
    const file = (ctx.filename ?? ctx.getFilename()).replace(/\\/g, "/");
    const m = HOST_SRC.exec(file);
    if (!m) return {};
    const fromRel = file.slice(m.index + m[0].length);
    const check = (node, src, typeOnly = false) => {
      if (!src || src.type !== "Literal" || typeof src.value !== "string") return;
      const to = srcTarget(fromRel, src.value);
      if (to === null) return;
      const why = hostBoundary(fromRel, to, typeOnly);
      if (why) ctx.report({ node: src, messageId: "boundary", data: { why } });
    };
    const allType = (node, kind, specKind) => node[kind] === "type"
      || (node.specifiers.length > 0 && node.specifiers.every((s) => s[specKind] === "type"));
    return {
      ImportDeclaration(node) { check(node, node.source, allType(node, "importKind", "importKind")); },
      ExportNamedDeclaration(node) { check(node, node.source, node.source ? allType(node, "exportKind", "exportKind") : false); },
      ExportAllDeclaration(node) { check(node, node.source, node.exportKind === "type"); },
      ImportExpression(node) { check(node, node.source); },
    };
  },
};

/**
 * `packages/extensions/<id>/`: an in-repo extension sees core only through the
 * SDK, the kit and `@waterplane/shared`, and core sees an extension only through its
 * entry. docs/notes/web-architecture.md ("Extension points") and plugins.md
 * ("In-repo extensions"); pinned by tools/extensionboundary.test.mjs.
 */
const EXT_FILE = /(^|\/)packages\/extensions\/([^/]+)\/(web|host|shared)\//;
const CORE_FILE = /(^|\/)packages\/(web|host)\/src\//;
const WEB_PKGS = new Set(["@waterplane/sdk", "@waterplane/kit", "@waterplane/shared", "react", "react-dom", "lucide-react"]);
const isBuiltin = (s) => s.startsWith("node:") || /^(fs|path|os|url|child_process|crypto|http|https|net|stream|util|events|buffer|zlib|readline|assert)(\/|$)/.test(s);
/** Why an import in `packages/extensions/<id>/<zone>/` is refused, or null. `fromPath` is repo-relative. */
export function extensionBoundary(fromPath, source) {
  const m = /^packages\/extensions\/([^/]+)\/(web|host|shared)\//.exec(fromPath);
  if (!m) return null;
  const [, id, zone] = m;
  if (source.startsWith(".")) {
    const t = normalise([...fromPath.split("/").slice(0, -1), ...source.split("/")]);
    if (t !== null && t.startsWith(`packages/extensions/${id}/`)) return null;
    return `\`${source}\` leaves packages/extensions/${id}/ — an extension imports only its own folder; reach core through \`@waterplane/sdk\` (and \`@waterplane/kit\` for shared widgets), never a path into packages/web/src, packages/host/src or another extension`;
  }
  if (zone === "web") {
    if (WEB_PKGS.has(source) || source.startsWith("react-dom/")) return null;
    if (isBuiltin(source)) return `\`${source}\` is a node builtin — the web half runs on the phone; do host work in host/ and call it with \`pluginClient\` from \`@waterplane/sdk\``;
    return `\`${source}\` is not allowed in an extension's web half — import \`@waterplane/sdk\`, \`@waterplane/kit\`, \`@waterplane/shared\`, \`react\`, \`react-dom\` or \`lucide-react\``;
  }
  if (zone === "host") {
    if (source === "@waterplane/shared" || isBuiltin(source)) return null;
    return `\`${source}\` is not allowed in an extension's host half — import \`@waterplane/shared\` or a \`node:*\` builtin; everything else from the daemon arrives as the \`HostPluginApi\` handed to \`activate\``;
  }
  if (source === "@waterplane/shared") return null;
  return `\`${source}\` is not allowed in an extension's shared/ folder (both halves import it) — only \`@waterplane/shared\` and relative paths inside the extension`;
}
/** Why core (`packages/web/src`, `packages/host/src`) may not import `target` (repo-relative), or null. */
export function coreExtensionImport(fromPath, target) {
  if (!/^packages\/extensions\//.test(target)) return null;
  if (fromPath === "packages/web/src/features/registry.ts" && /^packages\/extensions\/[^/]+\/web\/index\.ts$/.test(target)) return null;
  if (fromPath === "packages/host/src/plugins/builtin.ts" && /^packages\/extensions\/[^/]+\/host\/index\.m?[tj]s$/.test(target)) return null;
  return `core never imports an extension's internals (\`${target}\`) — the only edges are features/registry.ts → <id>/web/index.ts and plugins/builtin.ts → <id>/host/index; everything else goes over \`plugin.call\``;
}

/** @type {import("eslint").Rule.RuleModule} */
export const extensionBoundaryRule = {
  meta: {
    type: "problem",
    docs: { description: "extensions import only the SDK and the kit; core never reaches into an extension" },
    schema: [],
    messages: { boundary: "Extension boundary: {{why}}. See docs/notes/web-architecture.md and plugins.md." },
  },
  create(ctx) {
    const file = (ctx.filename ?? ctx.getFilename()).replace(/\\/g, "/");
    const em = EXT_FILE.exec(file);
    const cm = CORE_FILE.exec(file);
    if (!em && !cm) return {};
    const hit = em ?? cm;
    const rel = file.slice(hit.index + (hit[1] ? 1 : 0));
    const check = (src) => {
      if (!src || src.type !== "Literal" || typeof src.value !== "string") return;
      let why = null;
      if (em) why = extensionBoundary(rel, src.value);
      else if (src.value.startsWith(".")) {
        const t = normalise([...rel.split("/").slice(0, -1), ...src.value.split("/")]);
        if (t !== null) why = coreExtensionImport(rel, t);
      }
      if (why) ctx.report({ node: src, messageId: "boundary", data: { why } });
    };
    return {
      ImportDeclaration(n) { check(n.source); },
      ExportNamedDeclaration(n) { check(n.source); },
      ExportAllDeclaration(n) { check(n.source); },
      ImportExpression(n) { check(n.source); },
    };
  },
};
