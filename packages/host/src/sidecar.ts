/**
 * The one place an UNATTENDED completion is bought.
 *
 * Four things in this daemon spend tokens with nobody watching: the per-turn
 * tab name (`sessions/record.ts`), the assessment (`assess.ts`), the two
 * reviewers (`review.ts`) and the naming pass (`runNameTask`, and `naming.ts`
 * for what it is for; the commit message shares its argv). Two of the four
 * are TOOLLESS by contract and may take the local engine; the two that
 * read a repo refuse it in words. Each grew its own `execFile(claude, ["-p", …])`, and
 * the most expensive one by far was the per-turn session summary (one call per
 * turn-end per session, retired — the tab name, once per session off the first
 * prompt, is the only call of its kind left and the precedent for the rest).
 *
 * This module is the engine axis for those calls, and nothing else. It does not
 * decide WHEN anything runs, it does not decide what a result MEANS, and it
 * never writes anything — the callers keep their own contracts (`assess.ts`'s
 * file-both-ways, `review.ts`'s verdict JSON, `nameTab`'s once-ever gate and
 * persistence). All that moves here is HOW the completion is obtained.
 *
 * ── Two engines ─────────────────────────────────────────────────────────────
 *
 *  • `claude-p` — today's behaviour, MOVED, not rewritten. Same argv, same
 *    timeouts, same `--output-format json` envelope, same headless usage-limit
 *    read. It is the default for every task, so a host with no new environment
 *    variables set behaves exactly as it did before this file existed.
 *  • `openai-compat` — one `POST {baseURL}/chat/completions` against a local
 *    OpenAI-compatible server (ollama, llama.cpp, vLLM …), **with no tools**.
 *
 * ── Why `openai-compat` is not offered to everything ────────────────────────
 *
 * A completion with no tools can only answer from what is in its prompt. That
 * is a perfect fit for the summary, whose contract ALREADY forbids tools — it
 * runs `--tools ""` today and carries the transcript in the prompt, precisely
 * because there is nothing for it to go and read. It is a category error for
 * the assessment and the reviewers, which exist to read a repo and write two
 * files. So a task that needs tools REFUSES the local engine in words
 * (`sidecarPlan()`), rather than running it and reporting a judgement made
 * without looking at the code. Nothing quietly falls back to claude either: a
 * person who routed a task at a local model to stop spending Anthropic tokens
 * is not served by silently spending them.
 *
 * ── What a failure is allowed to be ─────────────────────────────────────────
 *
 * The same thing it is today: NOTHING. Every failure path here — a refused
 * route, a dead server, a non-2xx, unparseable JSON, an empty completion —
 * returns the empty result the existing callers already treat as "no summary /
 * no verdict". This app's standing rule is that a heuristic degrades to null or
 * absent and never to a wrong number, and a summary is a sentence a person
 * reads about a session they are not looking at: a made-up one is worse than
 * none, and there is no way to tell them apart afterwards.
 *
 * ── The reasoning-model trap (measured) ─────────────────────────────────────
 *
 * A local reasoning model asked for a one-sentence summary spent 421 of 451
 * tokens on `reasoning_content` and returned an EMPTY `content`. Two
 * consequences, both load-bearing:
 *   • `max_tokens` is generous (`SIDECAR_MAX_TOKENS`) — a tight budget is spent
 *     entirely on thinking and produces nothing at all.
 *   • The thinking is never read. `reasoning_content` / `reasoning` / `thinking`
 *     are not looked at, and an inline `<think>…</think>` block is stripped out
 *     of `content`. An empty `content` after that is "no summary", never a
 *     paragraph of a model reasoning about a terminal screen persisted onto a
 *     session's row.
 *
 * ── No phrase matching for the local engine ─────────────────────────────────
 *
 * `detectHeadlessLimit` reads an ACCOUNT-level block out of a `claude -p`
 * envelope. A local model has no account and no such block; running the
 * detector over its prose could only ever produce a false positive on a model
 * that happened to paraphrase one. It runs on the claude engine only.
 */

export { SIDECAR_ENV, parseSidecarSpec, resetSidecarWarnings, sidecarPlan } from "./sidecar/sidecarroute.js";
export type { ClaudeRoute, OpenAIRoute, RefusedRoute, SidecarEngine, SidecarPlan, SidecarTask } from "./sidecar/sidecarroute.js";
export { envelopeUsage, runHeadlessClaude, runToolTask } from "./sidecar/sidecarclaude.js";
export type { EnvelopeUsage, HeadlessRequest, HeadlessRun, ToolTaskRun } from "./sidecar/sidecarclaude.js";
export { claudeConfigPath, trustRefusal, workspaceTrust } from "./sidecar/sidecartrust.js";
export { chatCompletion, completionText } from "./sidecar/sidecaropenai.js";
export type { ChatRequest } from "./sidecar/sidecaropenai.js";
export { runSummaryTask } from "./sidecar/sidecartasks.js";
export type { SummaryRequest } from "./sidecar/sidecartasks.js";
export { runCommitTask, runExplainTask, runNameTask } from "./sidecar/sidecarname.js";
export type { NameRequest, NameRun } from "./sidecar/sidecarname.js";
