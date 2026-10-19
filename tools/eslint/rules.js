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
 * Walk a subtree. ESLint's visitor only fires on the nodes it is asked about at
 * the top level, and this rule has to ask a question about the INSIDE of one
 * particular node ("does this handler also say something?"), so it walks by
 * hand. `parent` is skipped or the walk goes back up the tree for ever.
 */
function walk(node, fn) {
  if (!node || typeof node.type !== "string") return;
  fn(node);
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const v = node[key];
    if (Array.isArray(v)) for (const c of v) walk(c, fn);
    else if (v && typeof v.type === "string") walk(v, fn);
  }
}

/**
 * The functions that make a tap NOT silent.
 *
 * Either it ends in a sentence (`showToast`, or the two guards in `App.tsx`
 * that always print one), or it becomes a durable queue entry — which is its
 * own receipt: the row appears in the queue sheet, with a status, and survives
 * a reload.
 */
const SPEAKS = new Set([
  "showToast", "liveSend", "liveAsk",
  "queueOp", "submitInput", "answerPrompt", "addOutbox", "addOutboxFirstInLane",
]);

/**
 * What makes a FEATURE's socket write not silent: `SPEAKS`, plus the SDK's
 * member form of the toast (`c.say.toast`, `core().say.toast`) — a feature has
 * no `showToast` of its own, it reaches the one App binds.
 */
const FEATURE_SPEAKS = new Set([...SPEAKS, "toast"]);
const FEATURE_SRC = /(^|\/)packages\/web\/src\/features\//;
/** Files whose bare `send(…)` is the ONE socket's, by where they live. */
const CORE_SEND_SRC = /(^|\/)packages\/web\/src\/(App\.tsx$|core\/)/;
const isFn = (n) => n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression" || n.type === "FunctionDeclaration";
const keyName = (p) => (p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" ? String(p.key.value) : null);
/** `c.conn.send(…)`, `core().conn.send(…)`, `conn.send(…)` — the SDK's one socket. */
function isConnSend(n) {
  const c = n.callee;
  if (c.type !== "MemberExpression" || c.computed || c.property.type !== "Identifier" || c.property.name !== "send") return false;
  const o = c.object;
  if (o.type === "Identifier") return o.name === "conn";
  return o.type === "MemberExpression" && !o.computed && o.property.type === "Identifier" && o.property.name === "conn";
}
function callsAny(root, names) {
  let hit = false;
  walk(root, (n) => {
    if (hit || n.type !== "CallExpression") return;
    const c = n.callee;
    if (c.type === "Identifier" && names.has(c.name)) hit = true;
    else if (c.type === "MemberExpression" && !c.computed && c.property.type === "Identifier" && names.has(c.property.name)) hit = true;
  });
  return hit;
}

/**
 * Two more receipts a feature's function can carry, besides a spoken one:
 *  - it opens a sheet (`nav.open`) — the sheet on top is what answers, and it
 *    says loading/offline/cached-and-how-old itself (`Empty`, `useRemoteResource`);
 *  - it reads `conn.status` — the offline case was decided explicitly, in code
 *    a reviewer can see (a quiet refresh that skips, a promise that rejects).
 */
function opensOrAsksStatus(root) {
  let hit = false;
  walk(root, (n) => {
    if (hit || n.type !== "MemberExpression" || n.computed || n.property.type !== "Identifier") return;
    const o = n.object;
    const on = o.type === "Identifier" ? o.name
      : o.type === "MemberExpression" && !o.computed && o.property.type === "Identifier" ? o.property.name : null;
    if ((on === "nav" && n.property.name === "open") || (on === "conn" && n.property.name === "status")) hit = true;
  });
  return hit;
}

/** @type {import("eslint").Rule.RuleModule} */
const noSilentSend = {
  meta: {
    type: "problem",
    docs: { description: "no tap may be silent: a socket write in an event handler must say something" },
    schema: [],
    messages: {
      silent:
        "This tap ends in a bare socket write and says nothing. `ws.ts`'s send() " +
        "RAM-QUEUES whatever it cannot deliver — invisibly — and the reconnect " +
        "watchdog's reload throws that buffer away, so with the tunnel down the " +
        "button simply does nothing and never admits it (design brief, decision 6). " +
        "Either make it a durable intent (`queueOp` / `submitInput`), or give it a " +
        "receipt (`liveSend` / `liveAsk` / `showToast`). A genuine exception takes " +
        "an inline `eslint-disable-next-line local/no-silent-send -- reason`.",
      silentFeature:
        "A bare `conn.send` in a feature, in a function that says nothing. The tap " +
        "that reaches it may be in another file (`onScan={() => scanRepo(dir)}`), so " +
        "the receipt has to be where the WRITE is: `conn.liveSend` / `conn.liveAsk`, " +
        "`queue.queueOp`, `say.toast`, a `nav.open` of the sheet that answers, or a " +
        "`conn.status` check, in the same function. Inside a `messages` " +
        "handler or `boot` nobody tapped anything and it is allowed. A genuine " +
        "exception takes an inline `eslint-disable-next-line local/no-silent-send -- reason`.",
    },
  },
  create(ctx) {
    // A bare `send(...)` is only a SOCKET write in a file that binds one off the
    // connection; several sheets have a local `send` that is a callback prop,
    // and flagging those would make the rule noise rather than a rule.
    // App.tsx and core/** get theirs from `useConnection()` — destructured, so
    // the `.bind(` is in core/conn and not in the file doing the writing; they
    // are binding contexts by PATH, or moving the socket into a hook would
    // have quietly switched the rule off for the one file with the most taps.
    const bindsSocket = ctx.sourceCode.getText().includes(".send.bind(")
      || CORE_SEND_SRC.test((ctx.filename ?? ctx.getFilename()).replace(/\\/g, "/"));
    const isSocketSend = (n) => {
      if (n.type !== "CallExpression") return false;
      const c = n.callee;
      if (c.type === "MemberExpression" && !c.computed && c.property.name === "send") return true;
      return bindsSocket && c.type === "Identifier" && c.name === "send";
    };
    const inFeature = FEATURE_SRC.test((ctx.filename ?? ctx.getFilename()).replace(/\\/g, "/"));
    const reported = new Set();
    const report = (node, messageId) => {
      if (reported.has(node)) return;
      reported.add(node);
      ctx.report({ node, messageId });
    };
    return {
      // Feature-action indirection: the JSX half below only sees a send written
      // INSIDE the `on*` attribute, so `onScan={() => scanRepo(dir)}` hid a
      // bare write one file away. In features/ every `conn.send` answers for
      // itself, in the function it is written in.
      CallExpression(node) {
        if (!inFeature || !isConnSend(node)) return;
        let fn = null;
        for (let a = node.parent; a; a = a.parent) {
          // A frame handler or a boot: no person is standing over this write.
          if (a.type === "Property" && ["messages", "boot"].includes(keyName(a))) return;
          if (!fn && isFn(a)) fn = a;
        }
        if (fn && (callsAny(fn.body, FEATURE_SPEAKS) || opensOrAsksStatus(fn.body))) return;
        report(node, "silentFeature");
      },
      JSXAttribute(node) {
        // Event handlers only. This rule is about a TAP, not about every send:
        // an effect, a reconnect sweep and a timer all write to the socket
        // legitimately and have no user standing over them.
        if (node.name.type !== "JSXIdentifier" || !/^on[A-Z]/.test(node.name.name)) return;
        const v = node.value;
        if (!v || v.type !== "JSXExpressionContainer") return;
        const body = v.expression;
        if (body.type !== "ArrowFunctionExpression" && body.type !== "FunctionExpression") return;
        let sends = null;
        let speaks = false;
        walk(body, (n) => {
          if (!sends && isSocketSend(n)) sends = n;
          if (n.type === "CallExpression" && n.callee.type === "Identifier" && SPEAKS.has(n.callee.name)) speaks = true;
          // `showToast` reached through a prop or an object (`p.showToast(…)`),
          // or the SDK's own (`c.say.toast(…)`).
          if (n.type === "CallExpression" && n.callee.type === "MemberExpression"
            && !n.callee.computed && FEATURE_SPEAKS.has(n.callee.property.name)) speaks = true;
        });
        if (sends && !speaks) report(sends, "silent");
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
const featureBoundaryRule = {
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
const hostBoundaryRule = {
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
const extensionBoundaryRule = {
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
