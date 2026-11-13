/**
 * What "suggest what to switch off" answered: a LIST, each row pre-ticked with from → to, the reason
 * and the host's own weight and use figures. Nothing here changes a setting until the one Apply tap,
 * which goes through the same write as Save. A refusal or a limit is the host's sentence, no list.
 */
import { Check, Square } from "lucide-react";
import type { SkillInventoryDoc, SkillRecommendResponse } from "@waterplane/shared";
import { Button, Hint, Row, RowSub, RowTitle } from "../../kit";
import { dismissSuggest, toggleSuggest } from "./actions";
import { RepoFileChoice } from "./RepoFileChoice";
import { SUGGEST_ONLY_LIST, applyFilesWords, applyNote, applyWords, changeCount, emptyWords, suggestionLevers, suggestionMeanings, suggestionName, tickedSuggestions, spendWords, suggestKey, suggestionUses, tickedChars, tilde, suggestionChanges } from "./logic";

const ICON = 14;

export function SuggestList({ res, unticked, doc, file, globalFile, shared, showChoice, applying, onApply }: {
  res: SkillRecommendResponse; unticked: string[]; doc: SkillInventoryDoc;
  /** This repo's file (the save bar's choice) and the all-repos file; null = cannot be read. */
  file: string | null; globalFile: string | null; shared: boolean;
  /** False while the save bar already shows the same choice (one control per choice on screen). */
  showChoice: boolean; applying: boolean; onApply: () => void;
}) {
  const list = res.suggestions;
  const spend = spendWords(res.spend, res.dropped);
  if (!list.length) {
    return (
      <div className="sk-suggest">
        <Hint tone={res.ok ? undefined : "warn"}>{emptyWords(res)}</Hint>
        {spend && <Hint>{spend}</Hint>}
        <Button className="sk-link" onClick={dismissSuggest}>close</Button>
      </div>
    );
  }
  const ticked = tickedSuggestions(list, unticked);
  const c = suggestionChanges(ticked, []);
  const n = ticked.length;
  const meanings = suggestionMeanings(list);
  const blocked = (c.here.length > 0 && !file) || (c.all.length > 0 && !globalFile);
  const note = applyNote(tickedChars(list, unticked));
  return (
    <div className="sk-suggest">
      <Hint>{SUGGEST_ONLY_LIST}</Hint>
      {meanings.map((m) => <Hint key={m}>{m}</Hint>)}
      {list.map((s) => {
        const k = suggestKey(s);
        const on = !unticked.includes(k);
        const name = suggestionName(s, doc.rows);
        const lv = suggestionLevers(s, doc.rows);
        const meta = [s.savedChars !== undefined ? `${tilde(s.savedChars)} fewer here` : null, suggestionUses(s)].filter(Boolean).join(" · ");
        return (
          <div key={k} className="sk-card">
            <Row kind="grow">
              <RowTitle>
                <Button className={`sk-tick${on ? " on" : ""}`} aria-pressed={on} aria-label={`${on ? "Untick" : "Tick"} ${name}`} onClick={() => toggleSuggest(k)}>
                  {on ? <Check size={ICON} /> : <Square size={ICON} />}
                </Button>{" "}
                {name}
              </RowTitle>
              <RowSub as="div" className="sk-why">{s.reason}</RowSub>
              {lv.all && <RowSub>{lv.all}</RowSub>}
              <RowSub>{lv.here}</RowSub>
              {meta && <RowSub>{meta}</RowSub>}
            </Row>
          </div>
        );
      })}
      {spend && <Hint>{spend}</Hint>}
      {c.here.length > 0 && showChoice && <RepoFileChoice shared={shared} />}
      {blocked ? <Hint tone="warn">{!globalFile && c.all.length ? "The all-repos settings file" : "This repo's settings file"} cannot be read, so applying to it is not offered.</Hint>
        : n === 0 || changeCount(c) === 0 ? <Hint>Nothing is ticked, so there is nothing to apply.</Hint>
        : (
          <>
            {applyFilesWords(c, globalFile, file) && <Hint>{applyFilesWords(c, globalFile, file)}</Hint>}
            {note && <Hint>{note}</Hint>}
            {/* not primary: the sheet's one primary verb is Save */}
            <Button onClick={onApply}>{applying ? "Applying…" : applyWords(n)}</Button>
          </>
        )}
      <Button className="sk-link" onClick={dismissSuggest}>close the list</Button>
    </div>
  );
}
