import { Smartphone } from "lucide-react";
import { FALLBACK_FACE } from "./dictateFallback";
import { showToast } from "./toast";
import { track } from "./usage";

/**
 * Which engine is listening, when it is NOT the desktop's whisper.
 *
 * Drawn in the language pill's place, and on the same rule — only while the
 * microphone is open — because the two never coexist: the phone's recogniser
 * is given its language at the start, so a language pill has nothing to change
 * there. The face says WHICH engine; a tap says WHY, in the sentence
 * `dictateFallback.ts` builds (a `title` is invisible on a phone).
 */
export function DictateFallbackPill({ why }: { why: string }) {
  return (
    <button type="button" className="dict-lang dict-fallback"
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => { track("action:voice.fallback"); showToast(why); }}
      aria-label={why}>
      <Smartphone size={14} />
      <span className="dict-lang-face">{FALLBACK_FACE}</span>
    </button>
  );
}
