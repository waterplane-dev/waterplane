import { useEffect, useState } from "react";
import { Languages } from "lucide-react";
import { dictateLangFace, dictateLangTitle } from "@waterplane/shared";
import { dictateLang, offeredLangs, setDictateLang, subscribeDictateLang } from "./dictateLang";
import { track } from "./usage";

/**
 * Which language the microphone beside it is read as.
 *
 * ── Why it is on the microphone as well as in settings ──────────────────────
 *
 * Because it changes per RECORDING. This app is dictated in German and in
 * English by the same person in the same session, and the reported failure was
 * exactly that: English spoken into a German phone came back translated into
 * German, fluently, with nothing on screen ever having said which language the
 * desktop was being asked for. A control only in Settings would be visited
 * once and then be wrong for every clip after it.
 *
 * ── It appears when the microphone is OPEN, and not before ──────────────────
 *
 * Asked for, after the first version sat in the compose row permanently: a
 * control that is only needed between "I started talking" and "I stopped" is
 * furniture the rest of the time, and that row is six buttons beside a live
 * terminal. So the caller draws it only while `listening` — the language is
 * still read at the stop, so a pill tapped mid-sentence applies to the sentence
 * being said. What it can no longer do is state the language BEFORE a
 * recording; that is Settings' row, which is where the list itself is chosen.
 *
 * It lists what Settings offers, not the catalogue (`offeredLangs`): the tap
 * happens mid-recording, one-handed, and scrolling 25 rows at that moment is
 * the control failing at its only job.
 *
 * ── It can be changed while recording, and that is not a race ───────────────
 *
 * The language travels with the CLIP, read when the recording stops
 * (`useVoice.ts`), so tapping this mid-sentence still applies to the sentence
 * being said — which is the moment a person notices they switched language.
 * A clip already held for a dead tunnel keeps the language it was made in; it
 * is not re-decided days later by a pill somebody has since moved.
 *
 * ── Why a `<select>` ────────────────────────────────────────────────────────
 *
 * The native picker is a full-screen list on Android with real language names
 * in it, reachable one-handed, and it is what `Backlog`/`LaunchAskSheet`
 * already use for the same shape of question. A popover here would have to be
 * positioned in every row `VoiceButton` is drawn in — the compose bar's
 * scrolling circles, a sheet's action bar, a file remark — for a worse list.
 */
export function DictateLangPill() {
  const [code, setCode] = useState(dictateLang);
  useEffect(() => subscribeDictateLang(() => setCode(dictateLang())), []);
  const choices = offeredLangs();
  const title = dictateLangTitle(code);
  return (
    <span className="dict-lang" title={title}>
      <Languages size={14} />
      {/* The FACE is short (`auto`, `EN`, `DE`) because this sits in a row of
          42px circles, and the full name is one tap away in the picker itself.
          The `aria-label` and the title carry the long form. */}
      <span className="dict-lang-face">{dictateLangFace(code)}</span>
      <select value={code} aria-label={`dictation language — ${title}`}
        onChange={(e) => { track("action:voice.lang"); setDictateLang(e.target.value); }}>
        {choices.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
      </select>
    </span>
  );
}
