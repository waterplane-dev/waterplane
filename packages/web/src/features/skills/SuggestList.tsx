/**
 * What "suggest what to switch off" answered: a LIST, each row pre-ticked with from → to, the reason
 * and the host's own weight and use figures. Nothing here changes a setting until the one Apply tap,
 * which goes through the same write as Save. A refusal or a limit is the host's sentence, no list.
 */
import { Check, Square } from "lucide-react";
import type { SkillInventoryDoc, SkillRecommendResponse } from "@waterplane/shared";
import { Button, Hint, Row, RowSub, RowTitle } from "../../kit";
import { dismissSuggest, toggleSuggest } from "./actions";
import { SUGGEST_ONLY_LIST, applyNote, applyWords, emptyWords, suggestionName, spendWords, suggestKey, suggestionMove, suggestionUses, tickedChars, tilde, suggestionChanges } from "./logic";

const ICON = 14;

export function SuggestList({ res, unticked, doc, file, applying, onApply }: {
  res: SkillRecommendResponse; unticked: string[]; doc: SkillInventoryDoc; file: string | null; applying: boolean; onApply: () => void;
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
  const n = suggestionChanges(list, unticked).length;
  const note = applyNote(tickedChars(list, unticked));
  return (
    <div className="sk-suggest">
      <Hint>{SUGGEST_ONLY_LIST}</Hint>
      {list.map((s) => {
        const k = suggestKey(s);
        const on = !unticked.includes(k);
        const name = suggestionName(s, doc.rows);
        const meta = [s.savedChars !== undefined ? tilde(s.savedChars) : null, suggestionUses(s)].filter(Boolean).join(" · ");
        return (
          <div key={k} className="sk-card">
            <Row kind="grow">
              <RowTitle>
                <Button className={`sk-tick${on ? " on" : ""}`} aria-pressed={on} aria-label={`${on ? "Untick" : "Tick"} ${name}`} onClick={() => toggleSuggest(k)}>
                  {on ? <Check size={ICON} /> : <Square size={ICON} />}
                </Button>{" "}
                {name} <span className="sk-ver">{suggestionMove(s, doc.rows)}</span>
              </RowTitle>
              <RowSub>{[meta, s.reason].filter(Boolean).join(" · ")}</RowSub>
            </Row>
          </div>
        );
      })}
      {spend && <Hint>{spend}</Hint>}
      {!file ? <Hint tone="warn">That file cannot be read, so applying to it is not offered.</Hint>
        : n === 0 ? <Hint>Nothing is ticked, so there is nothing to apply.</Hint>
        : (
          <>
            {note && <Hint>{note}</Hint>}
            {/* not primary: the sheet's one primary verb is Save */}
            <Button onClick={onApply}>{applying ? "Applying…" : applyWords(n)}</Button>
          </>
        )}
      <Button className="sk-link" onClick={dismissSuggest}>close the list</Button>
    </div>
  );
}
