/**
 * **Which key this phone believes for its desktop, and how it comes to.** The
 * stateful half of `updateTrust.ts`: it holds what a protected welcome offered,
 * gathers the facts for `decide`, and carries out the three things a person can
 * answer. Everything it touches arrives through `TrustDeps`, so node runs it.
 *
 *  - **A welcome is believed by the address its own socket dialled** (`conn.dialUrl`),
 *    which `webUpdate.ts` checks before calling `offer`. Never `plainHostRoute()` at
 *    message time: the ladder moves the route before the redial opens.
 *  - **A key is learned with no action on a shipped APK, and through a native dialog
 *    on one that can ask.** The dialog is page-proof, so it is the only thing that
 *    moves the native store; the row in LS is what the JS check reads. A changed key
 *    is never taken silently on either.
 *  - **An unasked dialog comes once per key per app start, and only on a screen
 *    someone is looking at.** "Not now" is an answer. The plan's "asks again on a
 *    later connect" is the next start, or the button in App version whenever the
 *    person wants it, because a phone reconnects far too often to ask each time.
 *  - **Nothing here lowers `gen` without a person.** A key change does, through the
 *    dialog or a `Confirm`, and so does `restored`. A fallback or a revert never calls in.
 */
import { setHostPins, setHostUpdateKey, type KV } from "./hosts.ts";
import { decide, type Gate, type NativePin, type OfferedKey, type SignedBody } from "./updateTrust.ts";
import type { SavedHost } from "@waterplane/shared";

/** The native pin calls (`ShellUpdatePlugin`). */
export interface PinShell {
  pinUpdateKey(o: { hostId: string; name: string; key: string }): Promise<{ pinned?: boolean }>;
  forgetUpdateKey(o: { hostId: string; name: string }): Promise<{ forgotten?: boolean }>;
}

export interface TrustDeps {
  kv(): KV | null;
  activeRow(): SavedHost | null;
  shell(): PinShell | null;
  /** `info().updateKeys`; null on an APK with no native verification. */
  shellKeys(): Promise<NativePin[] | null>;
  visible(): boolean;
  /** False on a passive device, which opens no socket for a welcome to arrive on. */
  hasSocket(): boolean;
  /** The old APK's stand-in for the native dialog. */
  confirm(o: { title: string; lines: string[]; confirmLabel: string; cancelLabel: string }): Promise<boolean>;
}

/** `later`: not asked, or not answered yet; a later connect or the button gets another go. */
export type PinAnswer = "pinned" | "declined" | "later" | "bad-key";

export interface PinWant {
  hostId: string;
  key: string;
  change: boolean;
}

const KEY_CHANGED_ASK = {
  title: "This desktop's update key changed",
  lines: [
    "It now signs its updates with a different key. A reinstalled desktop does this, and so does one pretending to be it.",
    "If you allow it, this desktop updates the app with the new key and the old key stops working.",
  ],
  confirmLabel: "Allow new key",
  cancelLabel: "Keep old key",
};

const RESTORED_ASK = {
  title: "Take updates from the restored desktop?",
  lines: [
    "This desktop is offering a build older than one this device already took. A desktop restored from a backup or rolled back does this, and so does an old update played again.",
    "Allow it only if you restored or rolled back this desktop yourself.",
  ],
  confirmLabel: "Trust it",
  cancelLabel: "Not now",
};

export function createUpdateTrust(d: TrustDeps) {
  let offered: (OfferedKey & { rowId: string }) | null = null;
  const asked = new Set<string>();
  let asking = false;

  /** The row, its id and its key move together: a pin on a row with no `hostId` can never be checked. */
  function keep(row: SavedHost, hostId: string, key: string, gen: number): boolean {
    const kv = d.kv();
    if (!kv) return false;
    return setHostPins(kv, row.id, { hostId }).ok && setHostUpdateKey(kv, row.id, { key, gen }).ok;
  }

  function offerFor(row: SavedHost | null): OfferedKey | null {
    return row && offered?.rowId === row.id ? { hostId: offered.hostId, key: offered.key } : null;
  }

  async function ask(want: PinWant, byHand: boolean): Promise<PinAnswer> {
    const row = d.activeRow();
    if (!row) return "later";
    // `gen` carries over only for the key it was counted under, as the native row's does.
    const gen = row.updateKey?.key === want.key ? row.updateKey.gen : 0;
    if ((await d.shellKeys()) === null) {
      if (want.change) {
        // A `Confirm` answers any other one that is up, so it is never raised unasked.
        if (!byHand) return "later";
        if (!(await d.confirm(KEY_CHANGED_ASK))) return "declined";
      }
      return keep(row, want.hostId, want.key, gen) ? "pinned" : "later";
    }
    const shell = d.shell();
    const tag = `${want.hostId}|${want.key}`;
    if (!shell || asking) return "later";
    if (!byHand && (asked.has(tag) || !d.visible())) return "later";
    asked.add(tag);
    asking = true;
    try {
      const r = await shell.pinUpdateKey({ hostId: want.hostId, name: row.name, key: want.key });
      if (r?.pinned !== true) return "declined";
      return keep(row, want.hostId, want.key, gen) ? "pinned" : "later";
    } catch (e) {
      return (e as { code?: string })?.code === "BAD_KEY" ? "bad-key" : "later";
    } finally {
      asking = false;
    }
  }

  return {
    /** A protected welcome stated this key for the active row. */
    offer(rowId: string, key: OfferedKey): void {
      offered = { rowId, hostId: key.hostId, key: key.key };
    },

    /** The policy table over this manifest, as of now. */
    async judge(m: { signed?: unknown; sig?: unknown }): Promise<Gate> {
      const row = d.activeRow();
      return decide({
        signed: m.signed,
        sig: m.sig,
        rowHostId: row?.hostId ?? null,
        pin: row?.updateKey ?? null,
        shell: await d.shellKeys(),
        offered: offerFor(row),
        canLearn: !!row && d.hasSocket(),
      });
    },

    ask,

    /**
     * The first pin, off a welcome alone: an up-to-date phone has no manifest to judge, and the
     * plan has every paired phone learn its key on its next protected connect. A key that differs
     * from the row's waits for the gate, where a manifest signed by it can show the person's answer
     * is about the key that really signs this desktop's bundles.
     */
    async learn(): Promise<PinAnswer | "held"> {
      const row = d.activeRow();
      const offer = offerFor(row);
      if (!row || !offer) return "held";
      if (row.updateKey && row.updateKey.key !== offer.key) return "held";
      if (row.hostId && row.hostId !== offer.hostId) return "held";
      const keys = await d.shellKeys();
      const inShell = keys?.some((p) => p.hostId === offer.hostId && p.key === offer.key);
      if (row.updateKey && (keys === null || inShell)) return "held";
      return ask({ ...offer, change: false }, false);
    },

    /**
     * Take a desktop whose `gen` went backwards, same key: a restored backup or `--rollback`.
     * `pinUpdateKey` asks nothing for a key already pinned and keeps its `gen`, so the native reset
     * is forget then pin, each with its own dialog. A person who answers the first and not the
     * second is left with no native pin: the row still holds the key, so the JS check still stands,
     * and tapping the button again goes straight to the second question.
     */
    async restored(hostId: string, key: string): Promise<PinAnswer> {
      const row = d.activeRow();
      if (!row) return "later";
      if ((await d.shellKeys()) !== null) {
        const shell = d.shell();
        if (!shell || asking) return "later";
        asking = true;
        try {
          const f = await shell.forgetUpdateKey({ hostId, name: row.name });
          if (f?.forgotten !== true) return "declined";
          const p = await shell.pinUpdateKey({ hostId, name: row.name, key });
          if (p?.pinned !== true) return "declined";
        } catch {
          return "later";
        } finally {
          asking = false;
        }
      } else if (!(await d.confirm(RESTORED_ASK))) {
        return "declined";
      }
      return keep(row, hostId, key, 0) ? "pinned" : "later";
    },

    /** A signed bundle landed: the high-water mark follows it, and only ever upward. */
    taken(rowId: string, key: string, body: SignedBody): void {
      const row = d.activeRow();
      if (!row || row.id !== rowId) return;
      const held = row.updateKey?.key === key ? row.updateKey.gen : 0;
      keep(row, body.hostId, key, Math.max(held, body.gen));
    },
  };
}
