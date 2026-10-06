/**
 * The peers sheet's state: each saved host's ledger as last read, whether a
 * read or a write is running, and the last outcome as a sentence. Written only
 * by `actions.ts`.
 */
import { createStore, useStore } from "../../sdk";
import type { HostLedger } from "./logic";

export interface PeersState {
  ledgers: HostLedger[];
  /** Nothing read yet (first paint) — distinct from "read, and empty". */
  loaded: boolean;
  /** A read or write is in flight (counted by `actions.ts`, never a grey). */
  busy: number;
  /** The last verb's outcome, said in full. */
  note: string | null;
  /** Which two hosts the pair form has picked. */
  pick: { a: string | null; b: string | null };
  /** Per pairing key (`PairedRow.key`): is claude signed in on that peer, as it said when asked.
   *  Absent = not asked yet, not answered, or an older peer — and then nothing is said. */
  signedIn: Record<string, boolean>;
}

export const peersState = createStore<PeersState>({ ledgers: [], loaded: false, busy: 0, note: null, pick: { a: null, b: null }, signedIn: {} });

export function usePeers(): PeersState {
  return useStore(peersState);
}
