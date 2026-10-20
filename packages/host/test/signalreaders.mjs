/**
 * Per clihealth signal: does a captured input read as its thing? The one
 * answer both `harvested.test.mjs` (asserting a fixture's role) and
 * `tools/harvestfixtures.mjs` (choosing it) use, so a fixture filed as a
 * `match` is exactly one the test can hold to that.
 *
 * `true` = the reader finds its thing, `false` = it does not, `null` = this
 * signal has no fixture reader. A fixture is DECODED first
 * (`decodeFixture`: `limit.reset`'s is stored ROT13'd). A `shape`
 * signal's capture is a skeleton (`shared`'s `skeletonOf`), so its reader asks
 * for the KEYS the host's parser reads, never a value: "the CLI renamed a
 * field" is the drift a skeleton can show.
 *
 * Needs `packages/host/dist` (`npm run build`).
 */
import { detectPrompt } from "../dist/prompt.js";
import { navToSubmit } from "../dist/promptnav.js";
import { detectContext } from "../dist/context.js";
import { isLocalCommand, startsNoTurn } from "../dist/slash.js";
import { composerEcho } from "../dist/echo.js";
import { detectLimitText } from "../dist/limit.js";
import { ECHO_SPLIT, decodeFixture } from "@waterplane/shared";

const json = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
const has = (o, ...keys) => !!o && typeof o === "object" && keys.every((k) => k in o);
/** A name the skeleton kept, rather than a value it hid. */
const named = (v) => typeof v === "string" && !v.startsWith("<");

/** `askbox.ts`'s `pendingIn`/`parseAsk`: content[] → tool_use AskUserQuestion → input.questions[].{question, options[].label}. */
function askRecord(rec) {
  const content = rec?.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b?.type === "tool_use" && b?.name === "AskUserQuestion" && has(b, "id", "input")
    && Array.isArray(b.input?.questions) && b.input.questions.some((q) => has(q, "question", "options")
      && Array.isArray(q.options) && q.options.some((o) => has(o, "label"))));
}

/** `transcript/` reads `type`, `uuid`, `timestamp` and `message.content` off both sides of a turn. */
function turnRecord(rec, type) {
  return rec?.type === type && has(rec, "uuid", "timestamp", "message") && has(rec.message, "content");
}

export const READERS = {
  "prompt.box": (t) => detectPrompt(t) != null,
  "prompt.submit": (t) => navToSubmit(t) != null,
  "context.meter": (t) => { const c = detectContext(t); return c.leftPct != null || c.usedTok != null; },
  "slash.local": (t) => {
    const [cmd, ...rest] = t.split("\n");
    return isLocalCommand(cmd) && startsNoTurn(cmd) && detectPrompt(rest.join("\n")) == null;
  },
  "askbox.enrich": (t) => askRecord(json(t)),
  // `claude-sources.ts` switches on `hook_event_name` and reads `session_id` / `transcript_path`.
  "hook.pipe": (t) => { const p = json(t); return named(p?.hook_event_name) && has(p, "session_id"); },
  // `deliverreturn.ts`'s prompt-hook proof: a `UserPromptSubmit` naming the session and the prompt.
  "deliver.submit": (t) => { const p = json(t); return p?.hook_event_name === "UserPromptSubmit" && has(p, "session_id", "prompt"); },
  // The masked prompt is found in the masked composer by the delivery's own rule.
  "deliver.echo": (t) => {
    const at = t.split("\n").indexOf(ECHO_SPLIT);
    if (at < 0) return false;
    const rows = t.split("\n");
    return composerEcho(rows.slice(at + 1), rows.slice(0, at).join("\n")) !== "none";
  },
  // The block and an instant to resume at — the instant is what this signal measures.
  "limit.reset": (t) => { const d = detectLimitText(t, Date.UTC(2026, 9, 20, 12)); return d.blocked && d.resetAt != null; },
  "transcript.jsonl": (t) => {
    const recs = json(t);
    return Array.isArray(recs) && recs.some((r) => turnRecord(r, "user")) && recs.some((r) => turnRecord(r, "assistant"));
  },
};

export function readSignal(id, text) {
  const r = READERS[id];
  return r ? !!r(decodeFixture(id, text)) : null;
}
