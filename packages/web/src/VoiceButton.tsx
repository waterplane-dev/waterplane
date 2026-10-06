import type { PointerEvent } from "react";
import { Hourglass, Mic } from "lucide-react";
import { DictateLangPill } from "./DictateLangPill";
import { DictateFallbackPill } from "./DictateFallbackPill";
import { holdTitle } from "./dictateHold";
import { track } from "./usage";
import type { Voice } from "./useVoice";

/**
 * Voice input — the ONE control, on every surface that takes dictation: the
 * compose bar, a sheet's prompt (`PromptComposer`'s `DictateButton`), a file
 * remark (`FileReview.tsx`).
 *
 * It was two chromes over `useVoice` — the compose bar's round icon and a
 * labelled `.key` on the sheets — on the argument that a scrolling icon row and
 * a worded action bar were not the same control. They were the same control
 * drawn two ways, and the person holding the phone read them as two features
 * that half-agreed. The compose bar's was the more finished one (the clock,
 * the held badge, the glyph per wait), so it is the template, and the sheets
 * lost their label rather than the bar growing one.
 *
 * `useVoice` stays with the CALLER: what a dictation appends to and where a
 * late one lands (`VoiceBox`) is the surface's business; how the microphone
 * looks and what it says is this file's.
 *
 *  - **Unsupported is ABSENT, not dimmed.** No engine (no Web Speech API, no
 *    desktop whisper) and there is no button at all — a greyed control explains
 *    nothing on a phone, where a `title` never appears.
 *  - **Three states, because the second one has a wait in it**: idle,
 *    listening, and RECORDED-AND-BEING-READ. With the desktop engine the words
 *    arrive about a second after you stop, and a button straight back at idle
 *    in that second reads as a tap that did nothing. `.busy` pulses amber.
 *  - **The GLYPH carries which wait it is, not the hue alone**: a microphone
 *    means the microphone is OPEN, an hourglass means you stopped and the
 *    desktop is reading what you said. "I cannot see if it is recording, or
 *    sending after a second tap" was the reported confusion.
 *  - **The clock is the proof it is still hearing**: it counts audio that
 *    ARRIVED (`Voice.heard`), so a frozen clock is a stopped mic.
 *  - **The badge is this control's own state** — recordings held for the
 *    desktop — and the only visible one it has; the sentence is the title and
 *    the toast log.
 *  - **The language pill only while the microphone is OPEN, and only on the
 *    host engine**: it is read at the STOP, so a tap mid-sentence still
 *    applies; the browser recogniser was told its language at the start, so
 *    there is nothing it could change there. The fallback pill SAYS when the
 *    phone's recogniser is listening instead of whisper.
 *  - `action:voice` is one usage id for every surface: one feature, counted
 *    once.
 */
export function VoiceButton({ voice, onPointerDown, idleTitle }: {
  voice: Voice;
  /** The compose bar keeps the keyboard up across a tap (`keepFocus`). */
  onPointerDown?: (e: PointerEvent<HTMLButtonElement>) => void;
  /** What a tap at rest does, where the surface has more to say than "Dictate". */
  idleTitle?: string;
}) {
  if (!voice.supported) return null;
  return (
    <>
      <button type="button" className={`mic ${voice.listening ? "on" : ""}${voice.transcribing ? " busy" : ""}`}
        onPointerDown={onPointerDown} onClick={() => { track("action:voice"); voice.toggle(); }}
        title={voice.listening ? `listening ${voice.heard ?? ""} — tap to stop`
          : holdTitle(voice.held, voice.transcribing)
          ?? idleTitle ?? (voice.engine === "host" ? "Dictate — read on the desktop" : "Dictate")}>
        {voice.transcribing && !voice.listening ? <Hourglass size={18} /> : <Mic size={18} />}
        {voice.held > 0 && <span className="mic-badge">{voice.held}</span>}
        {voice.heard && <span className="mic-clock">{voice.heard}</span>}
      </button>
      {voice.listening && voice.engine === "host" && <DictateLangPill />}
      {voice.listening && voice.fallback && <DictateFallbackPill why={voice.fallback} />}
    </>
  );
}
