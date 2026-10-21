/**
 * `no-silent-send`: a tap that sends must also say something. Split out of
 * `rules.js` by subject; the rule and its walk are unchanged.
 */

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
export const noSilentSend = {
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
