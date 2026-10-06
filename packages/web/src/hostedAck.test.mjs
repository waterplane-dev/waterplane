/**
 * The hosted-launch gate, pinned without a browser.
 *
 *     node --test packages/web/src/hostedAck.test.mjs
 *
 * `hostedAck.ts` has no DOM in it, so it runs the way `backendCaps.test.mjs`
 * runs — `node --test` straight over the TypeScript.
 *
 * One rule here is load-bearing above all the others and every case below is
 * an instance of it: **unknown is never folded into hosted.** The gate fires
 * only on an explicit `models.where[model] === "hosted"`. Defaulting the other
 * way would put a notice about sending source code to somebody else's servers
 * in front of a LOCAL launch — waterplane asserting, in its own voice, something
 * untrue about where a private repo went. That is precisely the failure
 * `HOSTED_DISCLAIMER` is worded to avoid, reached from the other side.
 *
 * The corollary is the second thing pinned here: a claude launch and a local
 * launch can never reach the sheet STRUCTURALLY, not by anybody remembering to
 * skip them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HOSTED_ACK_VERSION, needsHostedAck } from "./hostedAck.ts";
import { PERSISTED_OVERLAYS } from "./routing.ts";

const caps = {
  contextMeter: true, usageLimits: true, transcript: true, slash: true,
  promptBoxes: true, hooks: true, effort: true, remoteControl: true,
  permissionModes: ["default", "plan"],
};

/** claude as the host really describes it: a catalogue it names NO models in
 *  (the table lives in `backendCaps.ts`) and therefore no `where` map. */
const CLAUDE = { id: "claude", label: "Claude Code", caps, models: { aliases: [], ids: [] } };

/** A second binary with a mixed catalogue — the only shape that can gate. */
const OC = {
  id: "othercli", label: "othercli", caps,
  models: {
    aliases: [],
    ids: ["ollama/qwen3-coder:30b", "some/hosted-model", "some/odd-model", "some/mystery-model"],
    where: {
      "ollama/qwen3-coder:30b": "local",
      "some/hosted-model": "hosted",
      "some/odd-model": "orbital", // a value a NEWER host invented
      // "some/mystery-model" is deliberately absent from the map.
    },
    zeroCost: ["some/hosted-model"],
  },
};

const LIST = [CLAUDE, OC];
const ACKED = { at: 1, v: HOSTED_ACK_VERSION };

test("an acknowledgement at THIS version stops the gate, whatever is launching", () => {
  assert.equal(needsHostedAck(LIST, { backend: "othercli", model: "some/hosted-model" }, ACKED), false);
});

test("an acknowledgement at another version re-asks rather than inheriting", () => {
  const hosted = { backend: "othercli", model: "some/hosted-model" };
  // Older text: the words agreed to are not the words that would be shown.
  assert.equal(needsHostedAck(LIST, hosted, { at: 1, v: HOSTED_ACK_VERSION - 1 }), true);
  // A record a NEWER bundle wrote. Same answer: this build cannot claim the
  // person agreed to text it does not have.
  assert.equal(needsHostedAck(LIST, hosted, { at: 1, v: HOSTED_ACK_VERSION + 1 }), true);
  assert.equal(needsHostedAck(LIST, hosted, null), true);
  assert.equal(needsHostedAck(LIST, hosted, undefined), true);
});

test("ONLY an explicit \"hosted\" gates — every other shape is false", () => {
  const no = (launch, why) => assert.equal(needsHostedAck(LIST, launch, null), false, why);
  // No list at all: a desktop that predates backends. Every launch on it is
  // claude, and a notice on every one of them is the folded-unknown failure.
  no({ model: "opus" }, "no backends frame");
  assert.equal(needsHostedAck(null, { backend: "othercli", model: "some/hosted-model" }, null), false,
    "a host that described nothing cannot be read as describing a hosted model");
  // claude: a descriptor with no `where` map at all.
  no({ backend: "claude", model: "opus" }, "claude names no locality");
  no({ model: "claude-opus-5" }, "an absent backend IS claude");
  // The backend's own unnamed default — the KNOWN RESIDUAL, declined on
  // purpose rather than closed with a guess (`ModelField` covers that surface).
  no({ backend: "othercli" }, "no model in the launch");
  no({ backend: "othercli", model: "" }, "an empty model is not a hosted one");
  // Present in the map, and local.
  no({ backend: "othercli", model: "ollama/qwen3-coder:30b" }, "a local model");
  // Named by the catalogue, absent from the map.
  no({ backend: "othercli", model: "some/mystery-model" }, "unknown is not hosted");
  // A value this build cannot read, from a later host.
  no({ backend: "othercli", model: "some/odd-model" }, "a value a newer host invented");
  // An id nothing has ever heard of.
  no({ backend: "othercli", model: "who/knows" }, "an id the map does not name");
  // A backend this host does not describe at all (a launch synced from another
  // desktop). No descriptor ⇒ no map ⇒ no gate; the HOST refuses that create in
  // words (`launchFor`'s note), which is not this module's job.
  no({ backend: "cline", model: "some/hosted-model" }, "an undescribed backend");
  // …and the one that DOES gate, so the row above is a real distinction.
  assert.equal(needsHostedAck(LIST, { backend: "othercli", model: "some/hosted-model" }, null), true);
});

test("a missing launch is not a hosted launch", () => {
  assert.equal(needsHostedAck(LIST, null, null), false);
  assert.equal(needsHostedAck(LIST, undefined, null), false);
  assert.equal(needsHostedAck(LIST, {}, null), false);
});

/**
 * The transient-overlay rule, which is `LaunchAskSheet`'s and is load-bearing
 * for the same reason: this sheet stands between a tap and a `session.create`,
 * NOTHING IS QUEUED while it is up, and the launch it would resume lives in
 * memory. A route restored from a URL would paint an "I understand — start …"
 * button with nothing to start, and a reload is an answer of "not now".
 */
test("hostedack is never reload-restored", () => {
  assert.equal(PERSISTED_OVERLAYS.has("hostedack"), false,
    "hostedack is in PERSISTED_OVERLAYS — a reload would repaint a consent sheet with no launch behind it");
  assert.equal(PERSISTED_OVERLAYS.has("launchask"), false, "the rule this one follows has moved");
});

/**
 * No new policy prose, and no vendor named — the same rule
 * `backendCaps.test.mjs` puts on the exported constants, applied to the sheet
 * that shows them. The sheet reuses `HOSTED_DISCLAIMER` / `ZERO_COST_DISCLAIMER`
 * and adds none of its own, because a second wording of a data-transmission
 * warning is a second thing that can become untrue on its own schedule.
 */
const SHEET = readFileSync(fileURLToPath(new URL("./HostedAckSheet.tsx", import.meta.url)), "utf8");
/** The same file with its prose removed, for the two checks that are about what
 *  the component DOES — a doc comment naming the rule it obeys is not a
 *  violation of it. */
const CODE = SHEET.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the sheet reuses the shared disclaimer strings rather than writing prose", () => {
  assert.match(SHEET, /HOSTED_DISCLAIMER/, "the sheet no longer shows the one hosted disclaimer");
  assert.match(SHEET, /ZERO_COST_DISCLAIMER/, "the free-tier line is not the sheet's to reword");
  assert.match(SHEET, /isZeroCost\(/,
    "free must be MEASURED (`models.zeroCost`), never inferred from a `-free` in the name");
});

test("the sheet names no vendor and asks nothing native", () => {
  for (const vendor of ["Anthropic", "OpenAI", "Google", "Gemini", "Mistral", "Cohere", "Ollama", "Groq", "OpenRouter", "DeepSeek", "xAI"]) {
    assert.ok(!new RegExp(`\\b${vendor}\\b`).test(SHEET),
      `HostedAckSheet names ${vendor}. waterplane must not restate a third party's data policy — those ` +
      "terms change, and the app would be asserting something untrue about code already sent.");
  }
  assert.ok(!/window\.confirm\s*\(/.test(CODE),
    "a native modal blocks the WebView's event loop — this is a full overlay sheet (`Confirm.tsx`)");
  assert.ok(!/\bdisabled\b/.test(CODE),
    "nothing on this sheet is greyed out: before acceptance the launch simply has not been sent");
});
