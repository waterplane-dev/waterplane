/**
 * The all-repos view of the Setup check (ALL-REPOS.md §3): rule groups over every primary repo, and
 * the two checked-off folds. Doors only: a group's count opens exactly its repos (`repoRollupCut`
 * feeds the number, the rows and the bar), a repo row opens that repo's own check cut to the rule.
 * No spend, no ranking of repos, no total: those live on the screens the findings point at.
 */
import { repoRollupCut } from "@waterplane/shared";
import type { RollupCut, RollupGroup } from "@waterplane/shared";
import { FilterBar, Hint, Row, RowSub, RowTitle } from "../../kit";
import { ago } from "../../format";
import {
  ALL_EMPTY, allPendingWords, clearHead, clearRowWords, groupCountWords, groupUnreadWords, hiddenReposWords, repoCutWords, repoRowWords, savingLine, unreadHead,
} from "../../setupCheckWords";
import type { AllReposResponse } from "../../setupCheckTypes";
import { openRepoFromAll, openRule } from "./actions";
import { Fold } from "./SetupCheckRows";
import type { BillingProfile } from "@waterplane/shared";

function GroupLine({ g, cut }: { g: RollupGroup; cut: RollupCut }) {
  const unread = groupUnreadWords(cut.unread);
  return (
    <div className="sc-grp" data-rule={g.rule}>
      <div className="sc-what">{g.what}</div>
      <div className="sc-sub">
        <button className="sc-link" title={`list the ${g.repos.length} repos where this is open`} onClick={() => openRule(g.rule)}>{groupCountWords(cut.count, cut.of)}</button>
        {unread && <span>{` · ${unread}`}</span>}
      </div>
    </div>
  );
}

export function AllRepos({ doc, rule, profile }: { doc: AllReposResponse; rule: string | undefined; profile?: BillingProfile }) {
  const r = doc.rollup;
  const cut = repoRollupCut(r, rule ? { rule } : {});
  const g = cut.group;
  const nothing = r.groups.length === 0;
  return (
    <>
      {doc.pending && <Hint>{allPendingWords(doc.done, doc.total)}</Hint>}
      {!doc.pending && doc.at > 0 && <div className="sc-sub sc-age">{`checked ${ago(doc.at)}`}</div>}
      {rule && g && (
        <FilterBar onClear={() => openRule(undefined)} clearTitle="show every rule again">{repoCutWords(cut.count, cut.of, g.what)}</FilterBar>
      )}
      {!rule && r.groups.map((x) => <GroupLine key={x.rule} g={x} cut={repoRollupCut(r, { rule: x.rule })} />)}
      {rule && g && cut.rows.map((x) => (
        <div key={x.repoId} className="sc-repo-row">
          <Row as="button" onClick={() => openRepoFromAll(x.repoId, g.rule)} title={`open ${x.name}'s check, cut to this rule`}>
            <RowTitle>{x.name}</RowTitle>
            {repoRowWords(savingLine(x.saving, profile), x.findingIds.length) && <RowSub>{repoRowWords(savingLine(x.saving, profile), x.findingIds.length)}</RowSub>}
          </Row>
        </div>
      ))}
      {nothing && !doc.pending && <div className="empty empty-msg">{ALL_EMPTY(r.clear.length)}</div>}
      {r.clear.length > 0 && (
        <Fold head={clearHead(r.clear.length)} open={nothing}>
          {r.clear.map((x) => (
            <div key={x.repoId} className="sc-clear-row">
              <Row as="button" onClick={() => openRepoFromAll(x.repoId)} title={`open ${x.name}'s check`}>
                <RowTitle>{x.name}</RowTitle>
                <RowSub>{`${clearRowWords(x.passed, x.notChecked)}${x.at ? ` · ${ago(x.at)}` : ""}`}</RowSub>
              </Row>
            </div>
          ))}
        </Fold>
      )}
      {r.notChecked.length > 0 && (
        <Fold head={unreadHead(r.notChecked.length)} open>
          {r.notChecked.map((x) => (
            <div key={x.repoId} className="sc-chk"><div>{`${x.name}: ${x.why}`}</div></div>
          ))}
        </Fold>
      )}
      {doc.hidden > 0 && <Hint>{hiddenReposWords(doc.hidden)}</Hint>}
    </>
  );
}
