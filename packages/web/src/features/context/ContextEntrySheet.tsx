/**
 * The `context` sheet, wired: `ContextSheet.tsx` (unchanged, rules in
 * `web-numbers`) handed the subject session and its two doors.
 */
import { AGENT_LARGE_TOK, agentWindowWarnSetting, budgetSparkOf, liveAgentText, sessionBudgetLabel, type SessionInfo } from "@waterplane/shared";
import { setPref, useCore, usePref } from "../../sdk";
import { backendMark } from "../../backendCaps";
import { ContextSheet } from "../../ContextSheet";
import { openSessionBudget } from "../../sessionBudgetDoor";
import { REPLAN_NOTE, budgetLine } from "./logic";
import { closeContext, compactSubject, explainCostOf, freshFromContext, openSetupFromContext, openTokensFromContext, replanSubject } from "./actions";

export function ContextEntrySheet({ subject }: { subject: SessionInfo }) {
  const core = useCore();
  const { backends } = core.world;
  // The way out of an expensive conversation, offered only when it can
  // actually be taken: the repo has to be one we know, or the button would
  // name a directory nothing could open.
  const repo = core.world.sessionRepo(subject);
  const title = core.world.sessionRowTitle(subject);
  // The ONE line (tokens) the chip, the toast, this sheet and the host's push share.
  const warnTok = agentWindowWarnSetting(usePref("agentWindowWarn"));
  return <ContextSheet sessionId={subject.id} title={title}
    online={core.conn.status === "open"}
    // Gated on the SERIES, not on the live gauge — the two came apart the
    // moment a backend turned up that prints nothing on its screen and
    // still keeps a record a history can be read out of. Where there is no
    // series the sheet's own empty state ("this conversation has not
    // completed a turn") would be a false claim about the session rather
    // than a true one about the binary, so it states NON-MEASUREMENT
    // instead — never a 0%.
    unmeasured={core.world.sessionCant(subject, "contextSeries") ?? undefined}
    // Only the `windowFrom: "config"` and `"source"` captions use this, and
    // only to ATTRIBUTE the window to whoever's configuration or channel
    // stated it. Null for claude, which is the sheet's neutral fallback.
    backendLabel={backendMark(backends, subject.backend) ?? undefined}
    onFresh={repo ? () => freshFromContext(repo) : undefined}
    onCompact={core.world.sessionCan(subject, "slash") ? () => compactSubject(subject) : undefined}
    // Why it is not drawn, for a backend that reads `/compact` as English.
    compactCant={core.world.sessionCant(subject, "slash") ?? undefined}
    // The prompt points the new session at this conversation's transcript by
    // its id; with no id there is nothing to point at, so no button.
    onExplainCost={subject.claudeSessionId ? () => { explainCostOf(subject, title); } : undefined}
    // The row's `liveAgentTag` in full, on the phone's clock.
    liveAgentNote={subject.running ? liveAgentText(subject.contextSpark?.liveAgentTok, subject.contextSpark?.liveAgentAt, Date.now(), warnTok) : null}
    // Esc + a queued re-plan prompt, where this backend takes Claude's keys and
    // slash-style input at all; otherwise the reason, in text.
    onReplan={core.world.sessionCan(subject, "slash") ? () => replanSubject(subject, title) : undefined}
    replanCant={core.world.sessionCant(subject, "slash") ?? undefined}
    replanNote={REPLAN_NOTE}
    // The default is never written back: choosing it deletes the key.
    agentWarn={{ value: warnTok, onChange: (tok) => { core.say.track("action:ctx.agentWarn"); setPref("agentWindowWarn", tok === AGENT_LARGE_TOK ? "" : String(tok)); } }}
    // The session's own budget, worded by shared; the door opens the budget
    // sheet for THIS subject (a launcher row's tile is not the attached one).
    // Its spend is `budgetSparkOf`: a source session's own (`sourceSpend`), else the log's spark.
    budget={{ label: subject.budget ? sessionBudgetLabel(subject.budget.cfg) : null, line: budgetLine(subject.budget, Date.now(), budgetSparkOf(subject)), onOpen: () => openSessionBudget(subject.id) }}
    // Doors to what the repo + desktop WILL carry (repo readings, Setup region) and to every
    // conversation's split. No repo the desktop lists ⇒ that door is a sentence, never greyed.
    onOpenSetup={repo ? () => openSetupFromContext(repo.id) : undefined}
    setupCant={repo ? undefined : "this session's repo is not one the desktop lists"}
    onOpenAllSessions={openTokensFromContext}
    onClose={closeContext} />;
}
