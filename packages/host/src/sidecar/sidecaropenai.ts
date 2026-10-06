/**
 * The openai slice of `sidecar.ts` — see that file's header for the seam's rules.
 */
import { env } from "../env.js";
import { sayOnce } from "./sidecarroute.js";
import type { OpenAIRoute } from "./sidecarroute.js";

/**
 * How long a local completion may take.
 *
 * Deliberately generous, and not a guess: ollama UNLOADS an idle model, so the
 * first call after a quiet spell pays a cold load before it generates a token
 * (~15 s measured here for a small model on this desktop; a larger one on a
 * busy machine is worse). A tight timeout would make the local engine look
 * broken exactly when it is doing the thing it was configured to do, and the
 * cost of waiting is nothing: this call is advisory, runs off a turn boundary,
 * and blocks no session.
 */
const SIDECAR_TIMEOUT_MS = Number(env("SIDECAR_TIMEOUT_MS") || 120_000);

/**
 * Completion budget for the local engine.
 *
 * Far more than a two-sentence summary needs, on purpose — see the
 * reasoning-model trap in the header. Tokens on a local model are free; an
 * empty `content` because the budget went on thinking is a summary nobody gets.
 */
const SIDECAR_MAX_TOKENS = Number(env("SIDECAR_MAX_TOKENS") || 2048);

/** Optional bearer for servers that want one. Ollama does not. */
const sidecarApiKey = (): string => env("SIDECAR_API_KEY") || "";

// ── The openai-compat engine ───────────────────────────────────────────────

/**
 * The assistant's text out of a `/chat/completions` body — thinking removed.
 *
 * Exported because this is the part that a local model can break in four
 * different ways, and the assertions belong on a pure function rather than on a
 * live server. Anything it cannot read is "", which every caller here already
 * treats as "no answer".
 */
export function completionText(body: unknown): string {
  const choices = (body as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown } | undefined;
  // `reasoning_content` / `reasoning` / `thinking` are deliberately NOT read:
  // they are the model talking to itself, never the answer.
  let content: unknown = first?.message?.content;
  if (content === undefined && typeof first?.text === "string") content = first.text; // legacy /completions shape
  if (Array.isArray(content)) {
    content = content
      .map((p) => (typeof p === "string" ? p : (p as { type?: string; text?: string })?.type === "text" ? ((p as { text?: string }).text ?? "") : ""))
      .join("");
  }
  if (typeof content !== "string") return "";
  return stripThinking(content).trim();
}

/**
 * Drop an inline thinking block.
 *
 * Some servers put the reasoning in `content` between `<think>` tags instead of
 * in its own field. An UNCLOSED block is the response that ran out of budget
 * mid-thought: everything from the tag on is thinking, so it all goes, and what
 * is left is usually nothing — which is the correct answer, not a bug.
 */
function stripThinking(text: string): string {
  const closed = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");
  const open = closed.search(/<think(?:ing)?>/i);
  return open >= 0 ? closed.slice(0, open) : closed;
}

export interface ChatRequest {
  readonly prompt: string;
  readonly system?: string;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
}

/**
 * One completion against an OpenAI-compatible server. No tools, ever.
 *
 * Every failure — transport, timeout, non-2xx, unparseable body, empty content
 * — is "". The caller cannot tell them apart and must not need to: there is one
 * correct response to all of them, which is to leave what is on screen alone.
 */
export async function chatCompletion(route: OpenAIRoute, req: ChatRequest): Promise<string> {
  const url = `${route.baseURL}/chat/completions`;
  const messages = [
    ...(req.system ? [{ role: "system", content: req.system }] : []),
    { role: "user", content: req.prompt },
  ];
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = sidecarApiKey();
  if (key) headers.authorization = `Bearer ${key}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: route.model,
        messages,
        stream: false,
        max_tokens: req.maxTokens ?? SIDECAR_MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(req.timeoutMs ?? SIDECAR_TIMEOUT_MS),
    });
    if (!res.ok) {
      sayOnce(`${url} answered ${res.status} — nothing was summarised by the local engine.`);
      return "";
    }
    const text = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return ""; }
    return completionText(parsed);
  } catch (e) {
    sayOnce(`${url} could not be reached (${(e as Error)?.message ?? "no detail"}) — the local engine produced nothing.`);
    return "";
  }
}
