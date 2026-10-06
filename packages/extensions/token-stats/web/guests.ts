/**
 * A ledger another extension draws inside this sheet (`LedgerViewDef`, sdk) — its definition, the
 * document the host answered for it, and the read, as the sheet passes them down. Pure, so the
 * picker rule is node-tested.
 */
import type { BackendInfo } from "@waterplane/shared";
import type { LedgerViewDef } from "@waterplane/sdk";
import type { ResourceState } from "@waterplane/kit";

export interface GuestLedger {
  def: LedgerViewDef<any>;
  doc: unknown | null;
  res?: { state: ResourceState; age?: number | null; error?: string | null };
  backend?: BackendInfo;
}

/** The guests with a tab: the host answered and there is something behind the chip. */
export function shownGuests(guests: readonly GuestLedger[]): GuestLedger[] {
  return guests.filter((g) => g.def.hasData(g.doc ?? null));
}

/** Claude's scope sentence, drawn only while another tab exists — with one source there is nothing for "only" to be exclusive of. */
export function claudeOnlyText(shown: readonly GuestLedger[]): string | null {
  if (!shown.length) return null;
  const names = shown.map((g) => g.def.label);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Claude Code sessions only — ${list} sessions are counted on their own ${names.length === 1 ? "view" : "views"}.`;
}
