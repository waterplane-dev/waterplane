/**
 * Words a person typed that this phone could not keep, said where they typed.
 *
 * One tiny store: a store that cannot be read, a write the store refused, or a
 * draft moved aside reports here, and the composer draws ONE line per notice
 * (`LossLine.tsx`) that stays until dismissed. A toast would be gone before the
 * person looked up, and the words are the last copy. Pure (no storage import)
 * so a node test drives it.
 */
export interface LossNotice {
  /** One notice per (kind, what): a store failing on every keystroke is one line. */
  id: string;
  kind: "unreadable" | "refused";
  /** What it was, in the person's words: "drafts", "presets", "file remarks". */
  what: string;
  /** The exact localStorage key that holds the kept text (the slot actually written), if keeping it worked. */
  keptSlot?: string;
}

let notices: LossNotice[] = [];
const listeners = new Set<() => void>();
const emit = () => { for (const f of listeners) f(); };

/** Ids the person dismissed while the cause still stands, with the slot they saw. */
const dismissed = new Map<string, string | undefined>();

export function reportLoss(n: Omit<LossNotice, "id">): void {
  const id = `${n.kind}:${n.what}`;
  if (dismissed.has(id)) {
    // A dismissed line stays dismissed, unless a different copy is now kept aside.
    if (dismissed.get(id) === n.keptSlot) return;
    dismissed.delete(id);
  }
  const have = notices.find((x) => x.id === id);
  if (have) {
    // Same store failing again: keep one line, but say what is kept NOW.
    if (have.keptSlot === n.keptSlot) return;
    notices = notices.map((x) => (x.id === id ? { ...n, id } : x));
    emit();
    return;
  }
  notices = [...notices, { ...n, id }];
  emit();
}
/** The person closed the line. An unreadable line stays closed while the same cause repeats; a refused one returns on the next refused write. */
export function dismissLoss(id: string): void {
  const have = notices.find((x) => x.id === id);
  if (!have) return;
  // Only a standing fact (an unreadable store, re-reported on every read) stays
  // dismissed. A refused write is a new event about new words: it speaks again.
  if (have.kind === "unreadable") dismissed.set(id, have.keptSlot);
  notices = notices.filter((x) => x.id !== id);
  emit();
}
/** The store works again: the line goes and a later failure may speak anew. */
export function clearLoss(id: string): void {
  dismissed.delete(id);
  if (!notices.some((x) => x.id === id)) return;
  notices = notices.filter((x) => x.id !== id);
  emit();
}
export const getLosses = (): readonly LossNotice[] => notices;
export function subscribeLosses(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
export function resetLossesForTest(): void { notices = []; dismissed.clear(); emit(); }

/** The sentence the composer line says. */
export function lossSentence(n: LossNotice): string {
  return n.kind === "unreadable"
    ? n.keptSlot
      ? `Your saved ${n.what} could not be read. The old text is kept aside and nothing will overwrite it.`
      : `Your saved ${n.what} could not be read, and this phone could not keep a copy aside. Nothing will overwrite it.`
    : `Your ${n.what} could not be saved on this phone. Copy what you typed before you leave.`;
}
