/**
 * Setup check — ONE ranked list of what is worth fixing, and beside it what was checked and found
 * fine and what could not be checked. Rules (CLAUDE.md, `ux`, `web-work`): a count on a chip is a
 * filter (`logic.viewOf` feeds the number and the rows); the badge cut says `n of N` with a clear;
 * controls sit ABOVE the rows; a list is never blank — "nothing to fix" still lists the checks that
 * passed, and what could not run says why, never as passed; nothing applies itself.
 */
import { useEffect, useMemo } from "react";
import { ClipboardCheck } from "lucide-react";
import { checkedCountWords, repoShown } from "@waterplane/shared";
import type { ComplianceReport } from "@waterplane/shared";
import { api } from "../../api";
import { core, useStore } from "../../sdk";
import { Empty, Explain, FilterBar, Hint, Sheet, chipRows, useRemoteResource } from "../../kit";
import { loadHiddenRepos } from "../../localState";
import { RepoSelect } from "../../RepoPicker";
import { AskRulesHere } from "../../AskRulesHere";
import { fixNeedsConfirm } from "../../setupRemedy";
import { useSlowJob } from "../../slowJobs";
import {
  NO_REPO_WORDS, PENDING_WORDS, SCOPE_EXPLAIN, SCOPE_WORDS, absentWords, cutBarWords, installHead, notCheckedHead, passedHead, ruleCutWords, screenCutWords, waivedHead,
} from "../../setupCheckWords";
import { clearCut, setRepo, setScope, stepBack, waive } from "./actions";
import { AllRepos } from "./AllRepos";
import { chipCountOf, headCounts, scopeChips, viewOf } from "./logic";
import { FindingCard, Fold, NotCheckedRows, PassedRows } from "./SetupCheckRows";
import { setupCheckAim } from "./store";

export function SetupCheckSheet() {
  const c = core();
  const aim = useStore(setupCheckAim);
  const repos = c.world.repos;
  const repoId = aim.repoId;
  const scope = aim.scope === "repo" && !repoId ? "machine" : aim.scope;
  const isAll = scope === "all";
  // The overview is read only on its own view; the phone's hidden repos are left out of it host-side.
  const hidden = useMemo(() => [...loadHiddenRepos()].sort(), []);
  const allRes = useRemoteResource(`setupcheck:all:${hidden.join(",")}`, () => api.setupCheckRepos(hidden), { enabled: isAll, cache: { shape: 1 } });
  const allDoc = allRes.data;
  // A drill-down from the overview: Back returns there, the open group untouched. The steps Back takes
  // are armed by the taps (`actions.ts`), not by this view, so a door over a drilled card keeps them.
  const drilled = aim.from === "all" && !isAll;
  const res = useRemoteResource(`setupcheck:${repoId ?? "-"}`, () => api.setupCheck(repoId), { cache: { shape: 1 } });
  const doc = res.data;
  const repo = repos.find((r) => r.id === repoId) ?? null;

  // A first sweep that outlasted the host's wait answers `pending`: ask again until it has a document.
  useEffect(() => {
    if (!doc?.pending) return;
    const t = window.setTimeout(() => res.reload({ quiet: true }), 4000);
    return () => window.clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `res` is a new object each render; re-arming on it would never let the timer fire
  }, [doc?.pending, doc?.at]);

  const view = doc && !isAll ? viewOf(doc, scope, scope === "repo" ? aim.weight : undefined, scope === "repo" ? aim.rule : undefined, aim.screen) : null;
  // A confirm-gated fix carries the token of the compliance report; read it only when one is on screen.
  const needsToken = !!repoId && !!doc?.findings.some((f) => f.scope === "repo" && f.remedy.kind === "fix" && fixNeedsConfirm(f.remedy.fixId));
  const rep = useSlowJob<ComplianceReport>("setup.check", repoId, { enabled: needsToken, auto: true, verb: "re-check the setup" });

  const reload = () => { res.reload({ quiet: true }); };
  const ctx = { repoId, profile: c.world.billing?.profile, reload, confirmFor: (id: string) => rep.data?.confirm?.[id] };

  const manyRepos = repos.filter((r) => r.isPrimary).length >= 2;
  // A chip says a number only when the document it counts is the one it opens: "all repos" counts rule
  // groups (not repos) and "this repo" with no repo chosen reads a repo-less document, so both go bare.
  const chips = doc || isAll ? chipRows(scopeChips(!!repoId || repos.some((r) => r.isPrimary), manyRepos), (k) => ({ count: doc && k !== "all" ? chipCountOf(doc, k) : 0 }), (k) => SCOPE_WORDS[k]).map((ch) => (ch.key === "all" || (ch.key === "repo" && !repoId) ? { ...ch, text: SCOPE_WORDS[ch.key] } : ch)) : [];
  const counts = view ? headCounts(view) : null;
  // A cut's bar (the spend screen, one rule, the badge) says `n of N findings`; the head line then leaves the findings count to it.
  const cutBar = !!view && (!!aim.screen || (scope === "repo" && !!(aim.rule || aim.weight)));

  return (
    <Sheet title={drilled ? `Setup check · ${scope === "machine" ? SCOPE_WORDS.machine : repo ? repoShown(repo) : SCOPE_WORDS.repo}` : "Setup check"} icon={<ClipboardCheck size={16} />} onClose={stepBack}>
      <div className="sheet-scroll sc-scroll">
        {scope === "repo" && (
          <RepoSelect
            repos={repos.filter((r) => r.isPrimary || r.id === repoId)}
            value={repos.find((r) => r.id === repoId)?.worktreePath ?? ""}
            onChange={(dir) => { const r = repos.find((x) => x.worktreePath === dir); if (r) setRepo(r.id); }}
            aria-label="repo"
          />
        )}
        {/* The kit's segmented control (PullSheet's): one line at 390 px, no wrapping chip rows. */}
        <div className="segmented sc-scope" role="group" aria-label="what to check">
          {chips.map((ch) => (
            <button key={ch.key} className={`seg ${scope === ch.key && !aim.screen ? "on" : ""}`} aria-pressed={scope === ch.key && !aim.screen}
              onClick={() => setScope(ch.key)}>{ch.text}</button>
          ))}
        </div>
        {aim.screen && view && (
          <FilterBar onClear={clearCut} clearTitle="show this scope's findings, not only the ones about this spend">{screenCutWords(view.count, view.all)}</FilterBar>
        )}
        {scope === "repo" && aim.rule && !aim.screen && view && (
          <FilterBar onClear={clearCut} clearTitle="show every finding for this repo, not only this rule">{ruleCutWords(view.count, view.all)}</FilterBar>
        )}
        {scope === "repo" && aim.weight && !aim.screen && view && (
          <FilterBar onClear={clearCut} clearTitle="show every finding for this repo, not only the ones the badge counts">{cutBarWords(view.count, view.all)}</FilterBar>
        )}
        {isAll && <Empty res={allRes} empty={!allDoc} thing="the all-repos overview" />}
        {isAll && allDoc && <AllRepos doc={allDoc} rule={aim.openRule} profile={c.world.billing?.profile} />}
        {!isAll && <Empty res={res} empty={!doc} thing="the setup check" />}
        {!isAll && doc?.pending && <Hint>{PENDING_WORDS}</Hint>}
        {!isAll && doc && !doc.pending && view && counts && (
          <>
            <div className="sc-head">
              <span>{checkedCountWords(counts.findings, counts.passed, counts.notChecked, !!cutBar)}</span>
              <Explain of="the setup check" label="what the scopes mean"><p>{SCOPE_EXPLAIN}</p></Explain>
            </div>
            {scope === "repo" && !repoId && <Hint>{NO_REPO_WORDS}</Hint>}
            {view.rows.map((f) => <FindingCard key={f.id} f={f} ctx={ctx} />)}
            {counts.findings === 0 && <div className="empty empty-msg">Nothing to fix here. What was checked is listed below.</div>}
            {view.install.length > 0 && (
              <Fold head={installHead(view.install.length)} open>
                {view.install.map((f) => <FindingCard key={f.id} f={f} ctx={ctx} />)}
              </Fold>
            )}
            {view.waived.length > 0 && (
              <Fold head={waivedHead(view.waived.length)}>
                <PassedRows rows={view.waived} onTakeBack={async (p) => { const r = await waive(p.id, false, repoId); if (r.ok) reload(); else c.say.toast(r.error); }} />
              </Fold>
            )}
            {/* Open when there is nothing to fix: "all clear" must still show what was looked at. */}
            {view.passed.length > 0 && <Fold head={passedHead(view.passed.length)} open={counts.findings === 0}><PassedRows rows={view.passed} /></Fold>}
            {view.notChecked.length > 0 && <Fold head={notCheckedHead(view.notChecked.length)} open><NotCheckedRows rows={view.notChecked} /></Fold>}
            {doc.absent.map((a, i) => <Hint key={i}>{absentWords(a)}</Hint>)}
          </>
        )}
        {/* Not a check — a choice about this repo, kept beside its findings because this is the screen a repo's own settings are on. */}
        {scope === "repo" && repo && <AskRulesHere repo={repo} say={c.say.toast} />}
      </div>
    </Sheet>
  );
}
