// e2e fixture plugin (scripts/e2e-plugin.mjs): on every choice box, suggest
// option 1 and log a decision row; "ping" answers "pong"; "answer" asks the
// core's gate to answer the session's current box with option 1 and reports
// the gate's verdict in words.
// Generic plugin.call methods (scripts/e2e-plugin.mjs): echo, a counter, and a push.
let counter = 0;
export function activate(api) {
  api.handle("echo", (a) => ({ echoed: a }));
  api.handle("count", () => ++counter);
  api.handle("shout", () => { api.push("shouted", { n: counter }); return "ok"; });
  // An HTTP route of its own (api.route, 1.2): behind the core's origin and token gates.
  api.route("GET", "ping", (req) => ({ body: { pong: true, q: req.query.q ?? null } }));
  api.setStatus({ tone: "ok", text: "listening" });
  api.on("prompt", (e) => {
    api.suggest(e.sessionId, { choice: 1, confidence: 0.9, rationale: "fixture always picks 1" });
    api.decision({ sessionId: e.sessionId, question: e.question, options: e.options, outcome: "suggested", choice: 1, rationale: e.blocked ? "blocked box" : "fixture" });
  });
  api.on("action", async (e) => {
    if (e.action === "ping") return { ok: true, message: `pong (cap ${api.settings().cap})` };
    if (e.action === "answer") {
      const r = await api.answer(e.sessionId, 1, "fixture answer");
      return { ok: r.ok, message: r.ok ? "answered" : r.reason };
    }
    return { ok: false, message: "unknown" };
  });
}

