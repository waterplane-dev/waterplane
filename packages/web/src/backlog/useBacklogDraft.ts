/**
 * The add field's leftover draft — read ONCE at mount, rescued and said, and
 * cleared only by a person's tap (*send it* / *discard*). Never written over:
 * a draft is the last copy (`local/no-draft-clobber`).
 */
import { useState } from "react";
import { LS, lsDel, lsGet } from "../storage";

const DRAFT_KEY = LS.backlogDraft;

export function useBacklogDraft() {
  /**
   * Words the old add field was holding when this sheet lost it.
   *
   * A draft is the last copy. Deleting the only surface that could read one is
   * the same delete as writing over it, so the leftover is RESCUED and SAID —
   * offered as a send, one tap, with its own words on screen — rather than
   * being left in a localStorage key nothing opens. Read once at mount: it is
   * cleared by either button and must not come back on the next render.
   */
  const [strandedDraft, setStrandedDraft] = useState(() => (lsGet(DRAFT_KEY) ?? "").trim());
  const dropStrandedDraft = () => { lsDel(DRAFT_KEY); setStrandedDraft(""); };
  return {
    strandedDraft,
    dropStrandedDraft,
  };
}
