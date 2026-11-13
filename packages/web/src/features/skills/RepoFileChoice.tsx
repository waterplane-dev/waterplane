/**
 * Which repo file a save writes — a two-way choice on the save bar (R-skills-004), never a link at
 * the top: it is a setting of the save, so it sits beside the save, and says what each file means.
 */
import { Hint } from "../../kit";
import { setShared } from "./actions";
import { REPO_FILE_WORDS, repoFileHelp } from "./logic";

export function RepoFileChoice({ shared, onChange }: { shared: boolean; onChange?: () => void }) {
  const pick = (v: boolean) => { setShared(v); onChange?.(); };
  return (
    <div className="sk-file">
      <Hint>This repo&apos;s change is kept for:</Hint>
      {/* raw buttons: the app's .seg segmented control is a plain button pair everywhere (05-rows-approve.css) */}
      <div className="segmented" role="group" aria-label="Who this repo's change is for">
        <button className={`seg${!shared ? " on" : ""}`} aria-pressed={!shared} onClick={() => pick(false)}>{REPO_FILE_WORDS.local}</button>
        <button className={`seg${shared ? " on" : ""}`} aria-pressed={shared} onClick={() => pick(true)}>{REPO_FILE_WORDS.shared}</button>
      </div>
      <Hint>{repoFileHelp(shared)}</Hint>
    </div>
  );
}
