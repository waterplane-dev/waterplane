/**
 * Settings › Sessions › *ask before* — the desktop-wide ask-rule list
 * (docs/plans/agent-authority.md §2): each rule on its own row with its remove
 * and where it is switched off, a typed add refused in words, and ONE control
 * that adds exactly the missing suggested rules — the person's tap, never
 * automatic. The per-repo on/off lives on the repo (Repo readings), and an
 * "off in …" chip here switches that repo back on.
 */
import { useState } from "react";
import { ListPlus, Plus, ShieldAlert, Trash2 } from "lucide-react";
import {
  addRefusal, ASK_RULES_TRUTH, lostWords, missingSuggested, offInWords, repoLabel, suggestedAddable, withOffIn, withoutRule, withRule, withSuggested,
} from "../../askRules";
import { useAskRules } from "../../AskRulesHere";
import { ConfirmButton } from "../../Confirm";
import { Empty } from "../../Empty";
import { FilterChip } from "../../kit";
import { SetAction, SetCustom, SetWarn } from "../../SettingsKit";
import { useCore } from "../../sdk";

export function AskRulesSettings() {
  const core = useCore();
  const say = (w: string) => core.say.toast(w);
  const ask = useAskRules();
  const [draft, setDraft] = useState("");
  const [why, setWhy] = useState<string | null>(null);
  const repos = core.world.repos;
  const suggested = ask.res.data?.suggested ?? [];
  const missing = missingSuggested(ask.rules, suggested);
  const addable = suggestedAddable(ask.rules, suggested);

  async function add() {
    const refusal = addRefusal(ask.rules, draft);
    setWhy(refusal);
    if (refusal) return;
    if (await ask.save(withRule(ask.rules, draft), say)) setDraft("");
  }

  return (
    <SetCustom
      id="ask-rules" label="ask before" icon={ShieldAlert}
      note={ASK_RULES_TRUTH}
      more={<>
        <p>Each rule is a Claude Code permission rule, like <b>Bash(git push * main)</b>. The desktop hands the list to
          every claude launch, and claude then draws its own box naming the exact command — only your tap answers it.</p>
        <p>It stops the accident, not the adversary: a rule matches the words typed, so a script, an alias or a
          subprocess running the same command is not seen, and a bare <b>git push</b> on a branch that tracks main is
          not caught. Other backends and shell sessions take no rule at all.</p>
        <p>The list reaches claude sessions started on this desktop. A peer desktop's jobs run under that peer's own
          list, and this desktop's own headless calls (review, assess) take no rule.</p>
        <p>Switch a rule off for one repo from that repo's Repo readings, where the command is the daily flow.</p>
      </>}
    >
      <Empty res={ask.res} empty={!ask.res.data} thing="the ask rules" />
      {ask.res.data && (
        <div className="askrule-list">
          {lostWords(ask.res.data.lost) && <SetWarn icon={ShieldAlert}>{lostWords(ask.res.data.lost)}</SetWarn>}
          {ask.rules.length === 0 && !ask.res.data.lost && <div className="set-note">No rules yet — nothing asks first.</div>}
          {ask.rules.map((r) => {
            const off = offInWords(r, repos);
            return (
              <div key={r.id} className="askrule">
                <div className="askrule-top">
                  <code className="askrule-rule">{r.rule}</code>
                  <ConfirmButton
                    className="key" confirm="remove?"
                    onConfirm={() => void ask.save(withoutRule(ask.rules, r.id), say)}
                  >
                    <Trash2 size={14} /> remove
                  </ConfirmButton>
                </div>
                {off && (
                  <div className="set-chips" aria-label={off}>
                    <span className="set-note">off in (tap a repo to ask there again)</span>
                    {(r.offIn ?? []).map((p) => (
                      <FilterChip key={p} on
                        onClick={() => void ask.save(withOffIn(ask.rules, r.id, p, false), say)}>
                        {repoLabel(p, repos)}
                      </FilterChip>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          <div className="askrule-add">
            <input
              className="guardrail-text" value={draft}
              placeholder="Bash(git push * main)"
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
              onChange={(e) => { setDraft(e.target.value); setWhy(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }}
              aria-label="a rule to add"
            />
            <button className="key" onClick={() => void add()}>
              <Plus size={14} /> {ask.saving ? "saving…" : "add"}
            </button>
          </div>
          {why && <div className="set-note oracle-warn">{why}</div>}

          {/* Exactly the missing ones, and only on this tap: the count IS what
              the tap adds, and the fold lists them before anything is sent. */}
          {addable > 0 && (
            <SetAction
              label={`add the suggested rules (${addable})`} icon={ListPlus}
              busy={ask.saving}
              onClick={() => void ask.save(withSuggested(ask.rules, suggested), say)}
              note={addable < missing.length
                ? `${addable} of the ${missing.length} missing fit under the list's limit.`
                : "Force pushes, pushes to main or master, production deploys, releases, merges and publishing."}
              more={<ul className="askrule-suggest">{missing.slice(0, addable).map((s) => <li key={s}><code>{s}</code></li>)}</ul>}
            />
          )}
        </div>
      )}
    </SetCustom>
  );
}
