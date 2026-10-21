/**
 * The `decisions` sheet: every numbered (or bulleted, or picked) item on the
 * screen with one short answer field each, inserted into compose as the lines
 * a person used to type by hand — "4. Example scope: both".
 *
 * Why a field per item and not one box: on a phone the slow part was not the
 * words, it was re-typing "4. Example scope:" in front of each of them while
 * scrolling back up to see which number was which. Here the question is
 * above its own field.
 */
import { useMemo } from "react";
import { MessageSquareReply, X } from "lucide-react";
import { useCore, useStore } from "../../sdk";
import { SheetHead } from "../../Sheet";
import { decisionBlock, decisionItems } from "./logic";
import { decide, decideAnswers } from "./store";
import { Button, Hint } from "../../kit";

/** Offered on every item, after its own options. "your call" hands the
 *  decision back explicitly, which is different from leaving it blank. */
const ALWAYS = ["yes", "no", "your call"];

const FROM: Record<string, string> = {
  picked: "the lines you picked",
  screen: "the terminal screen",
  transcript: "the end of the cached conversation",
};

export function DecisionsSheet() {
  const core = useCore();
  const { lines, from } = useStore(decide);
  const answers = useStore(decideAnswers);
  const items = useMemo(() => decisionItems(lines), [lines]);
  const set = (text: string, v: string) => decideAnswers.set({ ...decideAnswers.get(), [text]: v });
  const values = items.map((it) => answers[it.text] ?? "");
  const block = decisionBlock(items, values);
  const answered = values.filter((v) => v.trim()).length;
  const insert = () => {
    if (!block) return;
    core.compose.insert(block);
    // Inserted is delivered: the words are in the draft now, which is their copy.
    const left = { ...decideAnswers.get() };
    for (const it of items) delete left[it.text];
    decideAnswers.set(left);
    core.nav.close("answers");
  };
  return (
    <div className="sheet">
      <SheetHead title="Answer the list" onClose={() => core.nav.close("answers")} />
      <Hint>
        {items.length
          ? <>{items.length} item{items.length > 1 ? "s" : ""} from {FROM[from]}. Answer the ones you have a view on; blank ones are left out.</>
          : lines.length || from !== "transcript"
            ? <>Nothing numbered or bulleted in {FROM[from]}. Long-press the terminal and choose <b>pick lines</b> to answer any lines you like.</>
            : <>Reading {FROM[from]}…</>}
      </Hint>
      <div className="decide-list">
        {items.map((it, i) => (
          <div className="decide-item" key={`${i}:${it.text}`}>
            <div className="decide-q">{it.num && <b>{it.num}. </b>}{it.text}</div>
            <div className="decide-a">
              <input type="text" value={values[i]} placeholder="your answer"
                enterKeyHint="next" onChange={(e) => set(it.text, e.target.value)} />
              {values[i] && <Button title="clear this answer" onClick={() => set(it.text, "")}><X size={16} /></Button>}
            </div>
            <div className="decide-chips">
              {[...it.options, ...ALWAYS].map((o) => (
                <button key={o} className={`key${values[i] === o ? " on" : ""}`} onClick={() => set(it.text, o)}>{o}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="sheet-actions">
        <span className="set-note">{answered ? `${answered} of ${items.length} answered` : "nothing answered yet"}</span>
        {/* Cancel keeps what was typed (`decideAnswers`): reopening on the same
            list brings it back. Typed words are never thrown away by a close. */}
        <Button onClick={() => core.nav.close("answers")}><X size={16} /> cancel</Button>
        {block && <button className="send" onClick={insert}><MessageSquareReply size={16} /> into compose</button>}
      </div>
    </div>
  );
}
