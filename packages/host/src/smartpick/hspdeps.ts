/** A slice of smartpick.ts — moved whole from smartpick.ts, see docs/notes/smartpick-architecture.md (host). */
import type { Intent, IntentDraft, IntentPatch, SmartPickFacts, SmartPickSummary } from "@waterplane/shared";
import { type SmartPickRequest, type SmartPickRun } from "../sidecar.js";

// ── The narrow slice of the intent store this feature is allowed ────────────

/**
 * What a grooming pass may do to the store, and nothing else.
 *
 * Deliberately narrower than `IntentManager`: there is no `cancel`, no
 * `markDone`, no `dismiss`, no `requeue` here. A merge sets its originals ASIDE
 * — archived, kept in full, restorable — and every one of those four verbs would
 * make it a retirement instead, which is the one thing the user's "apply it
 * automatically" decision was promised would never happen.
 *
 * `remove` is present for exactly one row: the merged row on an undo, whose text
 * is machine-written and is kept in the record anyway. Nothing anybody typed is
 * ever passed to it.
 */
export interface SmartPickIntents {
  get(id: string): Intent | undefined;
  list(): Intent[];
  post(draft: IntentDraft): { ok: boolean; intent?: Intent; existing?: boolean; reason?: string };
  edit(id: string, patch: { order?: number; archived?: boolean; label?: string; handOrdered?: boolean }): { ok: boolean; refused?: string };
  update(id: string, patch: IntentPatch): { ok: boolean; reason?: string };
  remove(id: string): boolean;
  kick(): void;
}

export interface SmartPickDeps {
  root: string;
  intents: SmartPickIntents;
  /** The per-repo tick. A `Set` lookup on the other side of this: rung 1 of the
   *  ladder is the whole of "an un-ticked repo costs exactly zero". */
  isOn(cwd: string): boolean;
  /** The cheap repo facts. Injected so a test needs no git, and defaulted to the
   *  real thing. */
  facts?(cwd: string): Promise<SmartPickFacts>;
  /** The unattended completion. Injected for the same reason. */
  run?(req: SmartPickRequest): Promise<SmartPickRun>;
  now?(): number;
  /** A pass that MERGED something finished — the one notification this feature
   *  sends. A pass that only sorted and picked notifies nothing: a phone that
   *  buzzes on every pick is noise. */
  onApplied?(e: { cwd: string; summary: SmartPickSummary; mergedRowIds: string[] }): void;
  /** Something changed that the backlog list shows. */
  onChange?(): void;
}

/** What the held row's sentence is. `intentReasonText("picking")` writes the one
 *  the phone renders; this is what the dep hands back to say HOLD. */
export const HOLD_TEXT = "looking over this repo's waiting items before picking the next one — a few seconds";

export interface InFlight {
  passId: string;
  fp: string;
  startedAt: number;
}