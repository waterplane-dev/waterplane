import { useRef, useState } from "react";
import { Loader, Sparkles } from "lucide-react";
import { CHANGE_FOCI, DEFAULT_CHANGE_FOCI, MAX_CHANGE_FOCUS_NOTE, cleanChangeFoci, fmtUsd, type ChangeBrief, type ChangeBriefSpend } from "@waterplane/shared";
import { api, copyText } from "./api";
import { track } from "./usage";
import { SheetHead } from "./Sheet";
import { Markdown } from "./Markdown";
import { showToast } from "./toast";
import { fmtTok } from "./format";
import { LS, lsGet, lsJson, lsSet, lsSetJson } from "./storage";
import { Button } from "./kit/Button";
import { Hint } from "./kit/Hint";

interface Props {
  repoId: string;
  /** As the sheet last read them — the brief re-reads after its own fetch. */
  ahead: number;
  behind: number;
  /** The brief fetched: the review sheet's counts must be re-read too. */
  onFetched: () => void;
  onClose: () => void;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** `21.3k tokens in, 1.9k out` — only the halves the envelope reported. */
function tokWords(s: ChangeBriefSpend): string {
  const parts = [s.inTok != null ? `${fmtTok(s.inTok)} tokens in` : "", s.outTok != null ? `${fmtTok(s.outTok)} out` : ""].filter(Boolean);
  return parts.join(", ");
}

/**
 * What a brief spent, in one sentence. Every number is the CLI's own report
 * (`total_cost_usd`, the envelope's usage) — a cost that was not reported is
 * said to be unknown, never estimated.
 */
function spendWords(s: ChangeBriefSpend, last = false): string {
  const secs = `${Math.round(s.durationMs / 1000)} s`;
  if (s.engine === "local") return `${last ? "The last one was" : "Answered"} by a local model — no account was charged (${secs}).`;
  const detail = [s.model, tokWords(s), secs].filter(Boolean).join(", ");
  if (s.usd == null) return `${last ? "The last one" : "This call"} ran on ${detail}; its cost was not reported.`;
  return `${last ? "The last one cost" : "This explanation cost"} ${fmtUsd(s.usd)} at API prices (${detail}). ` +
    "On a Claude subscription it comes out of your usage limit instead of a bill.";
}

/**
 * The Review sheet's Explain: what a push would send and a pull would bring,
 * told in plain words by one model call on the desktop (host `changebrief.ts`),
 * under the foci ticked here — all of them until the person unticks one.
 *
 * Nothing applies itself: the answer is something to read before tapping Push
 * or Pull, and this view has neither button. The ticks and the own-focus line
 * are this phone's to remember (`LS.gitExplainFoci` / `gitExplainNote`).
 */
export function GitExplain({ repoId, ahead, behind, onFetched, onClose }: Props) {
  const [foci, setFoci] = useState<string[]>(() => cleanChangeFoci(lsJson<unknown>(LS.gitExplainFoci, DEFAULT_CHANGE_FOCI)));
  const [note, setNote] = useState(() => lsGet(LS.gitExplainNote) ?? "");
  const [brief, setBrief] = useState<ChangeBrief | null>(null);
  const [last, setLast] = useState<ChangeBriefSpend | null>(() => lsJson<ChangeBriefSpend | null>(LS.gitExplainLast, null));
  /** A LABEL and the guard against a second call — never a disabled attribute. */
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);

  function toggle(id: string, on: boolean) {
    const next = cleanChangeFoci(on ? [...foci, id] : foci.filter((f) => f !== id));
    setFoci(next);
    lsSetJson(LS.gitExplainFoci, next);
  }
  function editNote(v: string) {
    setNote(v);
    lsSet(LS.gitExplainNote, v);
  }
  async function explain() {
    if (runningRef.current) return;
    runningRef.current = true;
    track("action:git.explain");
    setRunning(true); setBrief(null);
    try {
      const r = await api.gitExplain(repoId, foci, note);
      setBrief(r);
      if (r.spend) { setLast(r.spend); lsSetJson(LS.gitExplainLast, r.spend); }
    } catch (e) {
      setBrief({ reason: `The desktop did not answer: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      runningRef.current = false;
      setRunning(false);
      onFetched();
    }
  }
  const copy = (text: string) => void copyText(text).then((ok) => showToast(ok ? "copied" : "copy failed"));

  const scope = ahead || behind
    ? [ahead ? `${plural(ahead, "commit")} to push` : "", behind ? `${plural(behind, "commit")} to pull` : ""].filter(Boolean).join(" · ")
    : "nothing to push; the desktop checks the upstream for anything to pull";
  return (
    <div className="sheet">
      <SheetHead title="Explain push & pull" onClose={onClose} />
      <div className="sheet-body git-explain">
        <Hint>{scope}.</Hint>
        {/* Said BEFORE the tap: this button spends, and the person decides. */}
        <Hint>
          Explain makes one AI call from your desktop, on its Claude account (Sonnet unless the desktop is set
          otherwise). It reads the commits and diffs and changes nothing.{" "}
          {last ? spendWords(last, true) : "The cost grows with the size of the changes; it is shown with the answer."}
        </Hint>
        <div className="git-explain-foci">
          {CHANGE_FOCI.map((f) => (
            <label key={f.id} className="git-explain-focus" title={f.ask}>
              <input type="checkbox" checked={foci.includes(f.id)} onChange={(e) => toggle(f.id, e.target.checked)} />
              {f.label}
            </label>
          ))}
        </div>
        <textarea className="search" rows={2} maxLength={MAX_CHANGE_FOCUS_NOTE}
          placeholder="Your own focus (optional) — e.g. does this touch payments?"
          value={note} onChange={(e) => editNote(e.target.value)} />
        <div className="sheet-actions">
          <Button onClick={() => { void explain(); }}>
            {running ? <><Loader size={14} className="spin" /> explaining… (fetches first, can take a minute or two)</> : <><Sparkles size={14} /> Explain</>}
          </Button>
          {brief?.text && <Button onClick={() => copy(brief.text!)}>Copy</Button>}
        </div>
        {brief?.fetchNote && <Hint className="git-note">{brief.fetchNote}</Hint>}
        {brief?.reason && <Hint className="git-note">{brief.reason}</Hint>}
        {brief?.truncated && <Hint>Part of a diff was too long and was cut — the explanation may not cover all of it.</Hint>}
        {brief?.spend && <Hint>{spendWords(brief.spend)}</Hint>}
        {brief?.text && <div className="git-explain-text"><Markdown src={brief.text} q="" onCopy={copy} /></div>}
      </div>
    </div>
  );
}
