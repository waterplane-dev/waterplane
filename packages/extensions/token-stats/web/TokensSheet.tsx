/**
 * The `tokens` overlay: `TokenStatsSheet` wired to the core's `/usage` reading, and the
 * costliest-conversations list's two doors — explain a conversation's cost in a new session, or open
 * the context & cost sheet of one still live.
 */
import type { TokenConvo } from "@waterplane/shared";
import { core, explainCostPrompt, ledgers, useCore } from "@waterplane/sdk";
import { ledgerBackends } from "./backendLedger.ts";
import { TokenStatsSheet } from "./TokenStatsSheet.tsx";

/**
 * The costliest-conversations row's door: a NEW session in the conversation's
 * repo, started with the same prompt the context sheet's *explain the cost*
 * uses — a reading that names what made it expensive and proposes fixes, and
 * implements none of them until asked.
 */
function explainConvoCost(conv: TokenConvo, title: string): void {
  const prompt = explainCostPrompt({ title, cwd: conv.repo, claudeSessionId: conv.id });
  if (!prompt) return;
  const c = core();
  c.say.track("action:tokens.explainCost");
  c.nav.close("tokens");
  c.nav.startSessionWithPrompt(conv.repo, `cost of ${title}`, [prompt]);
}

// Account-wide and session-free, so nothing to guard: it reads every
// conversation log on the desktop, which is why it hangs off Settings
// rather than off a session.
export function TokensSheet() {
  const c = useCore();
  const u = c.world.usage;
  const { sessions, recent } = c.world;
  const live = (id: string) => sessions.find((s) => s.claudeSessionId === id);
  // Ledgers other extensions draw themselves (`LedgerViewDef`): a tab of their own, never a generic one too.
  const views = ledgers.views();
  return <TokenStatsSheet online={c.conn.status === "open"} views={views} backends={c.world.backends}
    ledgerTabs={ledgerBackends(c.world.backends, views.map((v) => v.id))} usage={u} onRefreshUsage={ledgers.refreshUsage}
    onClose={() => c.nav.close("tokens")}
    nameOf={(id) => {
      const s = live(id);
      return s ? c.world.sessionRowTitle(s) : recent.find((r) => r.claudeSessionId === id)?.title || undefined;
    }}
    onExplain={explainConvoCost}
    isLive={(id) => !!live(id)}
    // Attaching then opening the context sheet shows THAT session's context &
    // cost — the sheet's subject is the attached session when no row picked one.
    onOpenConvo={(id) => { const s = live(id); if (s) { c.nav.attach(s); c.nav.open("context"); } }} />;
}
