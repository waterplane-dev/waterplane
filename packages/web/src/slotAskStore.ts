/**
 * **The slot check's ask: what is pending, what is on screen, and the per-repo
 * switch.** The rules are `slotCheck.ts`'s (pure, node-tested); this is the
 * state around them.
 *
 * Flow: a timed send (`core/send/useSend.tsx`) calls `expectSlotAsk` with the
 * row's id; every `backlog.list` reaches `onSlotAskList` (the backlog feature's
 * handler); once the list holds the row ON THE CLOCK THE TAP SET, it either
 * becomes the ask (≥1 mate, not switched off here) or is dropped. The card
 * (`SlotAskLayer.tsx`, mounted beside the toast in `main.tsx`) draws `current`.
 *
 * *check* goes through an opener the backlog feature registers at boot — the
 * card cannot import a feature, and the feature owns the assessment sheet.
 *
 * The switch is per repo and per HOST (`LS.slotAskOff`): *don't ask in this
 * repo* writes it, the toast says where it comes back (the backlog's
 * *ask after a timed send*), and that control is the one way back.
 */
import type { BacklogItem } from "@waterplane/shared";
import { LS, lsJson, lsSetJson } from "./storage";
import { clockStamp, resolveSlotAsk, type SlotAsk, type SlotAskPending, type SlotCheck } from "./slotCheck";

let items: readonly BacklogItem[] = [];
let pending: SlotAskPending[] = [];
let current: SlotAsk | null = null;
let opener: ((c: SlotCheck) => void) | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const fn of listeners) fn(); };

// ── The per-repo switch ─────────────────────────────────────────────────────

function offList(): string[] {
  const v = lsJson<unknown>(LS.slotAskOff, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
export function isSlotAskOff(repoDir: string): boolean {
  return offList().includes(repoDir);
}
export function setSlotAskOff(repoDir: string, off: boolean): void {
  const cur = offList().filter((d) => d !== repoDir);
  lsSetJson(LS.slotAskOff, off ? [...cur, repoDir] : cur);
  if (off) {
    pending = pending.filter((p) => p.repoDir !== repoDir);
    if (current?.check.repoDir === repoDir) current = null;
  }
  emit();
}

// ── Pending sends ───────────────────────────────────────────────────────────

/** A timed send this phone just made. `was` is the row's clock in the list as
 *  it stands NOW, so a re-time waits for the list that carries the new one. */
export function expectSlotAsk(id: string, repoDir: string): void {
  if (!id || !repoDir || isSlotAskOff(repoDir)) return;
  const was = clockStamp(items.find((x) => x.id === id));
  pending = [...pending.filter((p) => p.id !== id), { id, repoDir, was, since: Date.now() }];
}

/** Every `backlog.list`. Resolves what it can; at most one ask is on screen,
 *  and a newer one replaces it (it is about the send just made). */
export function onSlotAskList(next: readonly BacklogItem[]): void {
  items = next;
  if (!pending.length) return;
  const now = Date.now();
  const keep: SlotAskPending[] = [];
  let ask: SlotAsk | null = null;
  for (const p of pending) {
    const step = resolveSlotAsk(p, next, now, isSlotAskOff(p.repoDir));
    if (step.kind === "wait") keep.push(p);
    else if (step.kind === "ask") ask = step.ask;
  }
  pending = keep;
  if (ask) { current = ask; emit(); }
}

// ── The card ────────────────────────────────────────────────────────────────

export function currentSlotAsk(): SlotAsk | null {
  return current;
}
export function onSlotAsk(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
export function closeSlotAsk(): void {
  if (!current) return;
  current = null;
  emit();
}

/** The backlog feature's door into a slot-scoped assessment. */
export function setSlotCheckOpener(fn: ((c: SlotCheck) => void) | null): void {
  opener = fn;
}
/** *check*: true when something opened it. */
export function openSlotCheck(c: SlotCheck): boolean {
  if (!opener) return false;
  opener(c);
  return true;
}
