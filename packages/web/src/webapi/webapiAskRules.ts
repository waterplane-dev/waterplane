import type { AskRule, AskRulesPut, AskRulesReply } from "@waterplane/shared";
import { nfetch } from "./webapiFetch";

/**
 * The ask rules (docs/plans/agent-authority.md §2), desktop-wide. Both calls THROW with the host's
 * own `error` sentence on a refusal (403 no browser Origin, 400, 500, 503), so the screen can say
 * it verbatim. A PUT replaces the whole list; a running session keeps the rules it launched with.
 * One slice of `api` (see api.ts), spread in through `rootApi`.
 */
export const askRulesApi = {
  askRules: () => nfetch("/api/askrules").then(askRulesReply),
  setAskRules: (rules: AskRule[], from: { rev: string; confirm: string }) =>
    nfetch("/api/askrules", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rules, rev: from.rev, confirm: from.confirm } satisfies AskRulesPut),
    }).then(askRulesReply),
};

/** A refusal the phone answers by re-reading the list: it changed elsewhere, or the confirm lapsed. */
export class AskRulesRefusal extends Error {
  constructor(message: string, readonly reread: boolean) { super(message); }
}

async function askRulesReply(r: Response): Promise<AskRulesReply> {
  let j: { ok?: boolean; error?: unknown } | null = null;
  try { j = (await r.json()) as { ok?: boolean; error?: unknown }; } catch { /* no body */ }
  if (r.ok && j?.ok) return j as unknown as AskRulesReply;
  throw new AskRulesRefusal(typeof j?.error === "string" ? j.error : `${r.status} /api/askrules`, r.status === 409 || r.status === 403);
}
