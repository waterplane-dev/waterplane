import type { PromptDef, PromptId, ToExtension } from "../src/protocol";
import { Absent } from "./Absent";
import { PromptActions } from "./Actions";

const WORDS: Record<PromptId, string> = {
  "groom-claudemd": "Asks Claude Code to propose a smaller CLAUDE.md as a diff, keeping what is dangerous not to know.",
  "shrink-skill-descs": "Lists the longest skill descriptions and asks for shorter ones as a diff.",
  "handoff-fresh-session": "Asks the current session to write a handoff note, so a fresh session can start light.",
  "explain-turn": "Asks why one prompt was expensive, quoting its row.",
  "split-longest-file": "Quotes the file that grew most in this folder’s repo-health series and asks for a split into cohesive modules, as a diff. Nothing is applied until you say so.",
  "explain-rising-metric": "Quotes the repo-health metric that is rising and ranks highest, and asks for the likely causes and three proposals in words. It changes no file.",
};

/** What each prompt needs before it can be built, said in words when it is missing. */
function missing(p: PromptDef, have: { session: boolean; weight: boolean; turn: boolean; health: boolean; rising: boolean }): string | null {
  if (p.needs.includes("session") && !have.session) return "It quotes the current session, and no session has been read yet.";
  if (p.needs.includes("weight") && !have.weight) return "It quotes this folder’s CLAUDE.md and skills, and none were found.";
  if (p.needs.includes("health") && !have.health) return "It quotes this folder’s repo-health series, and none has been measured. Open Repo health in the sidebar to measure it.";
  if (p.id === "explain-rising-metric" && !have.rising) return "No metric in this folder’s series is rising right now, so there is nothing to ask about.";
  if (p.needs.includes("turn") && !have.turn) return "It is about one prompt. Pick one in the Session view first.";
  return null;
}

export function PromptsView({ list, terminal, selectedTurn, have, post }: {
  list: PromptDef[];
  terminal: string | null;
  selectedTurn: number | null;
  have: { session: boolean; weight: boolean; health: boolean; rising: boolean };
  post: (m: ToExtension) => void;
}) {
  if (!list.length) return <Absent>The extension has not sent its prompts yet.</Absent>;
  return (
    <>
      <div className="empty ts-caveat">
        These produce text. Copy it, or type it into the active terminal — typed, not sent: you press Enter. Nothing here changes a file or runs by itself.
      </div>
      {list.map((p) => {
        // Turn 0 is the records before the first prompt: there is no prompt to ask about.
        const turn = selectedTurn != null && selectedTurn > 0 ? selectedTurn : null;
        const why = missing(p, { ...have, turn: turn != null });
        return (
          <section key={p.id} className="prompt-card" aria-labelledby={`pr-${p.id}`}>
            <h3 id={`pr-${p.id}`}>{p.title}</h3>
            <p>{WORDS[p.id]}</p>
            {why ? <Absent>{why}</Absent> : (
              <PromptActions id={p.id} turn={p.needs.includes("turn") ? turn ?? undefined : undefined}
                terminal={terminal} post={post} />
            )}
          </section>
        );
      })}
    </>
  );
}
