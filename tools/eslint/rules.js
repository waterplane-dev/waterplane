/**
 * Repo-specific lint rules.
 *
 * These are not style. Each one is an invariant that `CLAUDE.md` states in
 * prose and that has already cost a real bug once — the kind a future session
 * only obeys if it happened to read the right paragraph. The project's own
 * stated preference is a rule enforced by patching a global rather than a
 * helper every call site must remember (`settings.ts`, `hostUrl.ts`,
 * `hints.ts`); this is the build-time half of the same argument.
 */

import { noSilentSend } from "./silentsend.js";
import {
  FEATURE_DENY, featureBoundary, featureBoundaryRule, hostBoundary, hostBoundaryRule,
  extensionBoundary, coreExtensionImport, extensionBoundaryRule,
} from "./boundaries.js";

/** The pure deciders, for the tests that call them without ESLint. */
export { FEATURE_DENY, featureBoundary, hostBoundary, extensionBoundary, coreExtensionImport };

/** @type {import("eslint").Rule.RuleModule} */
const noCorsWildcard = {
  meta: {
    type: "problem",
    docs: { description: "never reintroduce `access-control-allow-origin: *`" },
    schema: [],
    messages: {
      wildcard:
        "`access-control-allow-origin: *` lets any web page drive the daemon. " +
        "Origin/Host are the browser half of the security boundary (origin.ts) — " +
        "reflect one allowed origin, never `*`.",
    },
  },
  create(ctx) {
    const isAcao = (n) =>
      (n.type === "Literal" && typeof n.value === "string" && /access-control-allow-origin/i.test(n.value)) ||
      (n.type === "Identifier" && /accessControlAllowOrigin/i.test(n.name));
    const isStar = (n) => n.type === "Literal" && n.value === "*";
    return {
      Property(node) {
        if (isAcao(node.key) && isStar(node.value)) ctx.report({ node, messageId: "wildcard" });
      },
      CallExpression(node) {
        // res.setHeader("access-control-allow-origin", "*")
        if (node.arguments.length >= 2 && isAcao(node.arguments[0]) && isStar(node.arguments[1])) {
          ctx.report({ node, messageId: "wildcard" });
        }
      },
    };
  },
};

/** @type {import("eslint").Rule.RuleModule} */
const noFunctionalSetOutbox = {
  meta: {
    type: "problem",
    docs: { description: "the send queue is ref-authoritative; never a functional updater" },
    schema: [],
    messages: {
      functional:
        "The send queue is ref-authoritative: `writeOutbox()` sets ref + localStorage + state, " +
        "and the flusher runs synchronously right after — a functional `setOutbox` updater " +
        "reads a queue the flusher has already moved past. Call `writeOutbox()` with the next value.",
    },
  },
  create(ctx) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "setOutbox") return;
        const a = node.arguments[0];
        if (a && (a.type === "ArrowFunctionExpression" || a.type === "FunctionExpression")) {
          ctx.report({ node, messageId: "functional" });
        }
      },
    };
  },
};

/** @type {import("eslint").Rule.RuleModule} */
const noSecondSocket = {
  meta: {
    type: "problem",
    docs: { description: "one WebSocket per tab; ws.ts owns it" },
    schema: [],
    messages: {
      second:
        "One WebSocket per tab carries everything (see the wire invariants). " +
        "Go through `ws.ts`'s single `HostConnection` — a second socket has its own " +
        "attach state, its own seq, and its own idea of when the link died.",
    },
  },
  create(ctx) {
    return {
      NewExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "WebSocket") {
          ctx.report({ node, messageId: "second" });
        }
      },
    };
  },
};

/** @type {import("eslint").Rule.RuleModule} */
const noStorageKeyLiteral = {
  meta: {
    type: "problem",
    docs: { description: "localStorage keys come from the registry in storage.ts (and its storage/keys*.ts slices)" },
    // `prefixes`: every storage prefix the app has had, current AND legacy
    // (`eslint.config.js` derives them from the brand words), so a key literal
    // under an old prefix is refused as firmly as one under the new.
    schema: [{ type: "object", properties: { prefixes: { type: "array", items: { type: "string" } } }, additionalProperties: false }],
    messages: {
      literal:
        "`{{key}}` is a storage key literal. Keys live in `storage.ts`'s `LS` registry (declared in `storage/keys*.ts`) — " +
        "that is where a key's name, its group, and whether it follows the USER or the " +
        "DEVICE are stated together, and it is what stops a rename leaving the old " +
        "literal behind in the one file nobody grepped.",
    },
  },
  create(ctx) {
    const prefixes = (ctx.options[0] && ctx.options[0].prefixes) || [];
    const keyed = (v) => typeof v === "string" && prefixes.some((p) => v.startsWith(p));
    return {
      Literal(node) {
        if (keyed(node.value)) ctx.report({ node, messageId: "literal", data: { key: node.value } });
      },
      TemplateElement(node) {
        // `<prefix>trSeen.${sid}` — a built key is still a key.
        if (keyed(node.value.cooked)) ctx.report({ node, messageId: "literal", data: { key: node.value.cooked } });
      },
    };
  },
};

/**
 * A product name spelled in code instead of read from `shared/src/brand.ts`.
 *
 * Every brand-bearing value is a field of `BRAND` (or of `LEGACY`, for what an
 * old install still has on disk), so the next rename edits one file. A string
 * literal, template chunk or JSX text that contains one of the `words` (the
 * current names AND every legacy word, case-insensitive) is a value that rename
 * would miss. Import/export SOURCES are skipped — the workspace scope is a
 * package name, renamed by its own sweep, not a value. `brand.ts` is exempted
 * in `eslint.config.js`; `tools/brand.test.mjs` pins the `words` option to the
 * built `BRAND`/`LEGACY`.
 */
const noBrandLiteral = {
  meta: {
    type: "problem",
    docs: { description: "brand-bearing values come from shared/src/brand.ts" },
    schema: [
      {
        type: "object",
        properties: { words: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    messages: {
      literal:
        "`{{text}}` spells the product name (`{{word}}`). Read it from `BRAND`/`LEGACY` " +
        "in `shared/src/brand.ts` (`lsKey`, `envName`, `env()`, `logTag`, …), so the next " +
        "rename is one file and not a grep.",
    },
  },
  create(ctx) {
    const words = ((ctx.options[0] && ctx.options[0].words) || []).map((w) => w.toLowerCase()).filter(Boolean);
    if (words.length === 0) return {};
    const isSource = (node) => {
      const p = node.parent;
      if (!p) return false;
      if ((p.type === "ImportDeclaration" || p.type === "ExportNamedDeclaration" ||
           p.type === "ExportAllDeclaration" || p.type === "ImportExpression") && p.source === node) return true;
      if (p.type === "TSExternalModuleReference") return true;
      if (p.type === "TSModuleDeclaration" && p.id === node) return true;
      if (p.type === "TSImportType") return true;
      return false;
    };
    const check = (node, text) => {
      if (typeof text !== "string" || !text) return;
      const lower = text.toLowerCase();
      const word = words.find((w) => lower.includes(w));
      if (!word) return;
      const shown = text.length > 60 ? `${text.slice(0, 57)}...` : text;
      ctx.report({ node, messageId: "literal", data: { text: shown.replace(/\s+/g, " "), word } });
    };
    return {
      Literal(node) { if (!isSource(node)) check(node, node.value); },
      TemplateElement(node) { check(node, node.value.cooked); },
      JSXText(node) { check(node, node.value); },
    };
  },
};

/**
 * The three `BackendInfo.caps` flags that are OPTIONAL on the wire, where
 * `undefined` means INHERIT and not "no".
 *
 * `fork ?? transcript`, `resumePick ?? transcript`, `contextSeries ??
 * contextMeter` (`shared/wire/backend.ts`, `web/backendCaps.ts`). They went on
 * the wire optional precisely so a desktop one version behind keeps its
 * controls: its descriptor answers `undefined`, which read raw is FALSY, which
 * silently deletes *fork from here* / *pick an older conversation* / the
 * context graph from a working claude session on that host.
 *
 * This was a paragraph in `docs/notes/web.md` claiming `backendCaps.test.mjs`
 * would catch a raw read. It could not: that test exercises `backendCaps.ts`,
 * and a `b.caps.fork` written into `App.tsx` passes every test in the repo.
 * The rule is the enforcement the paragraph promised.
 */
const OPT_CAPS = new Set(["fork", "resumePick", "contextSeries"]);
const OPT_CAP_FALLBACK = { fork: "transcript", resumePick: "transcript", contextSeries: "contextMeter" };

/** The name a property node reads as, or null when it is computed from a
 *  value (`caps[cap]`) — which is how `backendCaps.ts` itself reads them. */
function propName(node, computed) {
  if (!computed && node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}
const isCapsObject = (n) => n && n.type === "MemberExpression" && propName(n.property, n.computed) === "caps";

/** @type {import("eslint").Rule.RuleModule} */
const noRawOptionalCap = {
  meta: {
    type: "problem",
    docs: { description: "optional capability flags resolve through hasCap/capReason, never raw" },
    schema: [],
    messages: {
      raw:
        "`caps.{{cap}}` is OPTIONAL on the wire and absent means INHERIT `{{fallback}}`, not “no”. " +
        "Read raw it is `undefined` on every desktop whose descriptor predates the field — falsy — " +
        "so this removes a control that works there, with no sentence anywhere on the path. " +
        "Ask `hasCap(backends, id, \"{{cap}}\")`, or `capReason`/`sessionCants` for the sentence " +
        "that stands where the control would have been. That resolution lives in `backendCaps.ts` " +
        "and nowhere else, which is the only reason there is one answer to it.",
    },
  },
  create(ctx) {
    return {
      // `b.caps.fork`, `info?.caps?.fork`, `b.caps["fork"]`.
      MemberExpression(node) {
        const cap = propName(node.property, node.computed);
        if (!cap || !OPT_CAPS.has(cap) || !isCapsObject(node.object)) return;
        ctx.report({ node, messageId: "raw", data: { cap, fallback: OPT_CAP_FALLBACK[cap] } });
      },
      // `const { fork } = b.caps` — a destructured read is still a read, and is
      // the shape somebody reaches for to avoid repeating the member chain.
      VariableDeclarator(node) {
        if (!isCapsObject(node.init) || node.id.type !== "ObjectPattern") return;
        for (const p of node.id.properties) {
          if (p.type !== "Property") continue;
          const cap = propName(p.key, p.computed);
          if (cap && OPT_CAPS.has(cap)) {
            ctx.report({ node: p, messageId: "raw", data: { cap, fallback: OPT_CAP_FALLBACK[cap] } });
          }
        }
      },
    };
  },
};

/**
 * A `<a download>` of a host URL, or a hand-rolled anchor click, is DEAD IN THE
 * APK.
 *
 * In a browser tab it is the browser's own download; inside the Capacitor
 * WebView the click does nothing at all — no download listener, no error, no
 * file — so the button looked like it worked and the file existed nowhere a file
 * manager could reach (`web/nativeSave.ts` documents the same hole from the save
 * side). Every download in this app goes through `web/download.ts`, which files
 * the ask in the resumable queue and hands the bytes over natively.
 *
 * `pull.ts` (now `pull/pullSave.ts`) is exempt: it IS the fallback, and the only place allowed to click
 * an anchor, from a blob it already holds.
 */
/** Walk up the scope chain for a variable by name. */
function findVar(scope, name) {
  for (let s = scope; s; s = s.upper) {
    const hit = s.variables.find((v) => v.name === name);
    if (hit) return hit;
  }
  return null;
}

/** @type {import("eslint").Rule.RuleModule} */
const noAnchorDownload = {
  meta: {
    type: "problem",
    docs: { description: "downloads go through download.ts, never a hand-rolled anchor" },
    schema: [],
    messages: {
      anchor:
        "An `<a download>` (or an anchor click) is the browser's download in a tab " +
        "and does NOTHING AT ALL in the Capacitor WebView — no listener, no error, " +
        "no file. Use `startDownload`/`downloadTap` from `download.ts`: one queue, " +
        "one Downloads sheet, resumable, and handed to the phone through " +
        "`ShellSavePlugin`. `pull.ts` owns the one legitimate anchor.",
    },
  },
  create(ctx) {
    const file = ctx.filename ?? ctx.getFilename();
    if (/(^|\/)pull\.ts$|(^|\/)pull\/pullSave\.ts$/.test(file)) return {};
    // Deliberately not airtight: `a.setAttribute("download", …)`,
    // `Object.assign(a, { download })` and a spread of props all slip past. It
    // catches the shape people actually write, which is the point of a rule
    // that exists because this exact line keeps being re-typed.
    return {
      // <a download …> — on an `a` element only, so a future component prop
      // that happens to be called `download` is not flagged.
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "download") return;
        const el = node.parent;
        const nameNode = el && el.type === "JSXOpeningElement" ? el.name : null;
        if (nameNode && nameNode.type === "JSXIdentifier" && nameNode.name === "a") {
          ctx.report({ node, messageId: "anchor" });
        }
      },
      // a.download = "…" on an element the code just made. Narrowed to a
      // variable that was assigned a `createElement("a")`, so an unrelated
      // `cfg.download = true` is left alone.
      AssignmentExpression(node) {
        const l = node.left;
        if (l.type !== "MemberExpression" || l.computed) return;
        if (l.property.type !== "Identifier" || l.property.name !== "download") return;
        if (l.object.type !== "Identifier") return;
        const scope = ctx.sourceCode.getScope(node);
        const variable = findVar(scope, l.object.name);
        const madeAnchor = (variable?.defs ?? []).some((d) => {
          const init = d.node?.init;
          return init?.type === "CallExpression"
            && init.callee?.type === "MemberExpression"
            && init.callee.property?.name === "createElement"
            && init.arguments?.[0]?.value === "a";
        });
        if (madeAnchor) ctx.report({ node, messageId: "anchor" });
      },
    };
  },
};

/** @type {import("eslint").Rule.RuleModule} */
const noDraftClobber = {
  meta: {
    type: "problem",
    docs: { description: "seed a sheet draft through `seedSheetDraft`, so typed words are never silently replaced" },
    schema: [],
    messages: {
      clobber:
        "`saveSheetDraft` here replaces whatever is in that slot. A draft is left behind whenever " +
        "anything breaks the one route back to the sheet that wrote it (a routing bug, a reload, an " +
        "OTA bundle swap, a killed tab), and this store has no listing of its own — so the overwrite " +
        "is the last copy going. Use `seedSheetDraft` (keeps it where the pad can offer it back) or " +
        "`clearSheetDraft` for a deliberate discard. The sheet that OWNS the draft may still call " +
        "`saveSheetDraft` per keystroke — that is what the eslint.config scope is for.",
    },
  },
  create(ctx) {
    return {
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "saveSheetDraft") {
          ctx.report({ node, messageId: "clobber" });
        }
      },
    };
  },
};

export default {
  rules: {
    "host-boundary": hostBoundaryRule,
    "no-anchor-download": noAnchorDownload,
    "no-brand-literal": noBrandLiteral,
    "no-cors-wildcard": noCorsWildcard,
    "no-draft-clobber": noDraftClobber,
    "feature-boundary": featureBoundaryRule,
    "extension-boundary": extensionBoundaryRule,
    "no-silent-send": noSilentSend,
    "no-functional-setoutbox": noFunctionalSetOutbox,
    "no-raw-optional-cap": noRawOptionalCap,
    "no-second-socket": noSecondSocket,
    "no-storage-key-literal": noStorageKeyLiteral,
  },
};
