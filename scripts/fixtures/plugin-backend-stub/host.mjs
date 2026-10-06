// e2e fixture plugin (scripts/e2e-pluginbackend.mjs): a BACKEND from outside
// the core, on `api.backend` / `api.hookSink` / `api.onHook`.
//
// `stubcli` runs the claude stub TUI (scripts/claude-stub-tui.mjs) with its
// hooks pointed at this plugin's sink (`STUB_HOOK_URL`) and tagged with the id
// the launch minted (`STUB_SESSION_ID` → `session_id`), which is how one sink
// tells its sessions apart. Posted hooks become the backend's own sources:
//
//   SessionStart        → the channel is up (so the session reads `hooked`)
//   UserPromptSubmit    → a turn started;  Stop → it ended
//   permissionRequest   → a dialog, and the hook's response is HELD: a tap on
//                         the phone (`answerBox` → `answer()`) answers it with
//                         {behavior:"allow"|"deny"}; no tap ⇒ the core answers
//                         `{}` at maxHoldMs and the dialog is withdrawn.
//   rememberRequest     → like permissionRequest, with an option 2 marked
//                         `remember: {key: <command>}`. A PERSON's tap on it makes
//                         the HOST keep a standing rule (answergate.ts); the next
//                         identical request asks `api.ruleAllows` first and is
//                         answered {behavior:"allow", byRule:true} with no box.
//   forgetRules         → `api.forgetRules(<that session>)`, answered {forgot: n}.
//   tuiDialog           → a dialog already in the CLI's own TUI (Copilot past its
//                         hold): `answer()` returns `{ keys: "<digit>" }` and the
//                         HOST types it — no Return — into the session. The
//                         dialog stays open until the "CLI confirms" a beat
//                         later, the way a real source retires it off its log.
//
// The shape a real CLI plugin (Copilot: docs/analysis/backends-design.md §6)
// follows, minus the CLI.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const STUB = fileURLToPath(new URL("../../claude-stub-tui.mjs", import.meta.url));

export function activate(api) {
  /** backendSessionId → what each waterplane session's channel watches. */
  const slots = new Map();
  const slot = (sid) => {
    let s = slots.get(sid);
    if (!s) slots.set(sid, s = { up: false, since: Date.now(), turns: new Set(), dialogs: new Set(), healths: new Set(), pending: new Map() });
    return s;
  };
  const healthOf = (s) => (s.up ? { state: "up", since: s.since } : { state: "down", since: s.since, note: "waiting for the stub's SessionStart" });

  api.onHook((p, hold) => {
    const sid = p && typeof p.session_id === "string" ? p.session_id : null;
    if (!sid) return { ok: false, error: "no session_id" };
    const s = slot(sid);
    switch (p.hook_event_name) {
      case "SessionStart":
        if (!s.up) { s.up = true; s.since = Date.now(); for (const h of s.healths) h(healthOf(s)); }
        for (const t of s.turns) t.ready();
        return {};
      case "UserPromptSubmit":
        for (const t of s.turns) t.started(Date.now());
        return {};
      case "Stop":
        for (const t of s.turns) t.ended(Date.now());
        return {};
      case "permissionRequest": {
        const id = typeof p.toolCallId === "string" && p.toolCallId ? p.toolCallId : randomUUID();
        return new Promise((resolve) => {
          const withdraw = () => { if (s.pending.delete(id)) for (const o of s.dialogs) o.resolved(id); };
          const d = {
            id, kind: "tool",
            question: `Allow ${typeof p.toolName === "string" ? p.toolName : "this tool"}?`,
            options: [{ index: 1, label: "Allow" }, { index: 2, label: "Deny" }],
            answer: async (choice) => {
              if (!s.pending.has(id)) return { ok: false, reason: "that request was already answered or ran out" };
              resolve(choice === 1 ? { behavior: "allow" } : { behavior: "deny", message: "denied from the phone" });
              withdraw();
              return { ok: true };
            },
          };
          s.pending.set(id, d);
          hold.onExpired(withdraw);
          for (const o of s.dialogs) o.asked(d);
        });
      }
      case "rememberRequest": {
        const cmd = typeof p.command === "string" ? p.command : "";
        const id = typeof p.toolCallId === "string" && p.toolCallId ? p.toolCallId : randomUUID();
        if (s.hostId && cmd) {
          const r = api.ruleAllows(s.hostId, cmd, "stub: the same command again");
          if (r.ok) return { behavior: "allow", byRule: true };
        }
        return new Promise((resolve) => {
          const withdraw = () => { if (s.pending.delete(id)) for (const o of s.dialogs) o.resolved(id); };
          const d = {
            id, kind: "tool", question: `Run ${cmd}?`,
            options: [{ index: 1, label: "Allow" }, { index: 2, label: `Allow, and don't ask again for ${cmd}`, remember: { key: cmd, label: cmd } }, { index: 3, label: "Deny" }],
            answer: async (choice) => {
              if (!s.pending.has(id)) return { ok: false, reason: "that request was already answered or ran out" };
              resolve(choice === 3 ? { behavior: "deny", message: "denied from the phone" } : { behavior: "allow" });
              withdraw();
              return { ok: true };
            },
          };
          s.pending.set(id, d);
          hold.onExpired(withdraw);
          for (const o of s.dialogs) o.asked(d);
        });
      }
      case "forgetRules":
        return { forgot: s.hostId ? api.forgetRules(s.hostId) : 0, rules: s.hostId ? api.rules(s.hostId).length : null };
      case "tuiDialog": {
        const id = typeof p.toolCallId === "string" && p.toolCallId ? p.toolCallId : randomUUID();
        let typed = false;
        const d = {
          id, kind: "tool", question: "Run this in the terminal?",
          options: [{ index: 1, label: "Yes" }, { index: 2, label: "No" }],
          answer: async (choice) => {
            if (!s.pending.has(id) || typed) return { ok: false, reason: "that dialog was already answered" };
            typed = true;
            setTimeout(() => { if (s.pending.delete(id)) for (const o of s.dialogs) o.resolved(id); }, 300);
            return { keys: String(choice) };
          },
        };
        s.pending.set(id, d);
        for (const o of s.dialogs) o.asked(d);
        return {};
      }
      default:
        return {};
    }
  }, { maxHoldMs: Number(api.env("STUBCLI_HOLD_MS")) || 4000 });

  api.backend({
    id: "stubcli",
    label: "Stub CLI",
    bin: () => process.execPath,
    launchArgs: (req) => {
      const sid = req.resumeSessionId || randomUUID();
      return {
        args: [STUB],
        backendSessionId: sid,
        env: { STUB_HOOKS: "1", STUB_HOOK_URL: api.hookSink(), STUB_SESSION_ID: sid, ...(api.env("STUB_LOG") ? { STUB_LOG: api.env("STUB_LOG") } : {}) },
      };
    },
    caps: { hooks: "plugin-inject", promptBoxes: false, transcript: "none" },
    models: async () => ({ aliases: [], ids: ["stub-1"] }),
    sources: {
      turns: {
        watch: (ss, on) => {
          const s = slot(ss.backendSessionId ?? "");
          s.hostId = ss.id; // the waterplane session, for `api.ruleAllows`
          s.turns.add(on);
          return () => s.turns.delete(on);
        },
      },
      dialogs: {
        watch: (ss, on) => {
          const s = slot(ss.backendSessionId ?? "");
          s.dialogs.add(on);
          return () => s.dialogs.delete(on);
        },
        pending: async (ss) => [...slot(ss.backendSessionId ?? "").pending.values()],
      },
      attach: async (ss, onHealth) => {
        const s = slot(ss.backendSessionId ?? "");
        s.healths.add(onHealth);
        return { close: async () => { s.healths.delete(onHealth); }, health: () => healthOf(s) };
      },
    },
  });
  api.setStatus({ tone: "ok", text: "stubcli registered" });
}
