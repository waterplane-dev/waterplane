/**
 * Ask rules (docs/plans/agent-authority.md §2): the one read + save both surfaces use, and the
 * per-repo half drawn in Repo readings — one on/off per rule for THIS repo, written as `offIn`
 * with `repo.worktreePath` (the host resolves each entry by realpath at launch).
 *
 * The desktop-wide list (add, remove, the suggested rules) is Settings › Sessions › ask before
 * (`features/askRules`). Every save toasts what it changed and that a RUNNING session keeps the
 * rules it launched with; a refusal is the host's sentence, verbatim.
 */
import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { isOffline, type AskRule, type AskRulesReply, type RepoTarget } from "@waterplane/shared";
import { api } from "./api";
import { AskRulesRefusal } from "./webapi/webapiAskRules";
import { hereWords, isOffIn, lostWords, putBody, savedReceipt, withOffIn } from "./askRules";
import { Empty } from "./Empty";
import { Explain } from "./Explain";
import { SetSwitch, SetWarn } from "./SettingsKit";
import { useRemoteResource, type RemoteResource } from "./useRemoteResource";

export interface AskRulesHandle {
  res: RemoteResource<AskRulesReply>;
  rules: AskRule[];
  /** True while a PUT is on the wire; a second tap is swallowed, never greyed. */
  saving: boolean;
  /** Send the whole next list. Says the receipt or the refusal through `say`. */
  save: (next: AskRule[], say: (words: string) => void) => Promise<boolean>;
}

export function useAskRules(): AskRulesHandle {
  const res = useRemoteResource<AskRulesReply>("askrules", () => api.askRules());
  const [saving, setSaving] = useState(false);
  async function save(next: AskRule[], say: (words: string) => void): Promise<boolean> {
    if (saving) return false;
    const from = res.data;
    if (!from) { say("The ask rules have not loaded yet — nothing was changed."); return false; }
    setSaving(true);
    try {
      // The reply carries a fresh rev + confirm, so the next tap saves without a re-read.
      const r = await api.setAskRules(putBody(next).rules, { rev: from.rev, confirm: from.confirm ?? "" });
      res.set(r);
      say(savedReceipt(r.dropped));
      return true;
    } catch (e) {
      // Changed elsewhere (another phone) or the confirm lapsed (a host restart): re-read, so
      // the screen shows the list as it is and the next tap carries a live confirm.
      if (e instanceof AskRulesRefusal && e.reread) res.reload({ quiet: true });
      say(isOffline(e)
        ? "No connection — the ask rules were not changed."
        : String((e as Error)?.message || e));
      return false;
    } finally {
      setSaving(false);
    }
  }
  return { res, rules: res.data?.doc.rules ?? [], saving, save };
}

/** The repo's own rows, under the checklist. */
export function AskRulesHere({ repo, say }: { repo: RepoTarget; say: (words: string) => void }) {
  const ask = useAskRules();
  const path = repo.worktreePath;
  return (
    <>
      <div className="section-head">
        <span className="section"><ShieldAlert size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />ask before, in this repo</span>
        <Explain of="ask rules in this repo">
          <p>claude stops and asks you before a command matching one of these rules. Switch a rule
            off here where that command is your daily flow; it keeps asking in every other repo.</p>
          <p>A change reaches claude sessions started on this desktop after it — a running session keeps
            the rules it launched with. Other backends take no rule. A peer desktop's jobs run under that
            peer's own list, and this desktop's own headless calls (review, assess) take no rule. It stops
            the accident, not a wrapper script: a script or alias running the same command is not seen.</p>
        </Explain>
      </div>
      <Empty res={ask.res} empty={!ask.res.data} thing="the ask rules" />
      {ask.res.data && (
        <>
          {lostWords(ask.res.data.lost) && <SetWarn icon={ShieldAlert}>{lostWords(ask.res.data.lost)}</SetWarn>}
          <div className="form-hint">{hereWords(ask.rules, path)}</div>
          <div className="set-kinds askrule-here">
            {ask.rules.map((r) => {
              const on = !isOffIn(r, path);
              return (
                <SetSwitch
                  key={r.id}
                  label={<code className="askrule-rule">{r.rule}</code>}
                  on={on}
                  state={ask.saving ? "saving…" : on ? "asks" : "off here"}
                  onChange={() => void ask.save(withOffIn(ask.rules, r.id, path, on), say)}
                />
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
