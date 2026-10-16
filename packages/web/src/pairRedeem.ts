/**
 * Pairing this phone with a desktop by code — the pure half, node-tested
 * (`pairRedeem.test.mjs`). The form is `PairForm.tsx`; the host side is
 * `host/pair.ts`.
 *
 * Three rules:
 *
 * - **Input is forgiving, the target is not.** The address field also takes a
 *   pasted landing URL or deep link (`parsePairInput`), which fills both
 *   fields; anything else goes through `normalizeHostBase` + `normalizePairCode`
 *   and a target exists only when both came out clean.
 * - **A deep link is a QUESTION, never an action.** Any app on the phone can
 *   fire `waterplane://pair?...`, so `pairLinkRequest` only ever produces a form to
 *   show, prefilled and naming the address it would connect to. Nothing here
 *   redeems; `redeemPair` runs from the person's own tap on "pair".
 * - **What a redeem hands back lands under the right host.** The token and the
 *   LAN identity are host-scoped keys (`KEY_SCOPE`): bare for the ACTIVE host,
 *   parked under `waterplane.h.<id>.` for any other — written parked for a host that
 *   is about to become active too, because the switch at the next boot
 *   restores parked over bare. With no active host at all (the first run),
 *   both: the boot's restore then only fills keys that are missing.
 */
import {
  BRAND, normalizeHostBase, normalizePairCode, parkedKeyFor, parsePairDeepLink, parsePairInput, pairRedeemErrorText,
  type PairRedeemError, type PairRedeemResponse, type PairTarget, type SavedHost,
} from "@waterplane/shared";
import { activeHostId, addHost, readHosts, updateHost, type KV } from "./hosts.ts";
import { isDeviceToken } from "./deviceToken.ts";
import { LS } from "./storage.ts";

/** The pair form's two fields, as typed. */
export interface PairFields { address: string; code: string }

/** A paste into the ADDRESS field that is a whole link: both fields, from it.
 *  Null when the text is just an address (or nothing). */
export function fieldsFromPaste(text: string): PairFields | null {
  const t = parsePairInput(text);
  return t ? { address: t.base, code: t.code } : null;
}

/** What the form would redeem, or null while either field is not usable. */
export function pairTargetOf(f: PairFields): PairTarget | null {
  const linked = parsePairInput(f.address);
  if (linked) return linked;
  const base = normalizeHostBase(f.address);
  const code = normalizePairCode(f.code);
  return base && code ? { base, code } : null;
}

/** A deep link the shell handed over. `ask`: open the pair form prefilled —
 *  never a redeem. `invalid`: a link that does not parse. */
export type PairLinkRequest = { kind: "ask"; target: PairTarget } | { kind: "invalid" };

export function pairLinkRequest(url: unknown): PairLinkRequest {
  const target = parsePairDeepLink(url);
  return target ? { kind: "ask", target } : { kind: "invalid" };
}

export const PAIR_LINK_INVALID = "That pairing link isn't valid";

/** The sentence shown over a form a LINK filled in. */
export function pairLinkSentence(t: PairTarget): string {
  return `A pairing link asks to connect this phone to ${t.base.replace(/^https?:\/\//, "")}. Nothing is sent until you tap pair.`;
}

/** The redeem answer, read defensively off the wire. */
export type RedeemReply =
  | Extract<PairRedeemResponse, { ok: true }>
  | { ok: false; error: PairRedeemError | "network" | "bad-reply"; message: string };

const ERRORS: readonly PairRedeemError[] = ["bad-request", "unknown", "expired", "used", "rate-limited", "no-password"];

export function readRedeemReply(status: number, body: unknown): RedeemReply {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (b.ok === true && b.host && typeof b.host === "object") {
    const h = b.host as Record<string, unknown>;
    if (typeof h.base === "string" && typeof h.name === "string") return b as unknown as RedeemReply;
  }
  if (b.ok === false && ERRORS.includes(b.error as PairRedeemError)) {
    return { ok: false, error: b.error as PairRedeemError, message: typeof b.message === "string" ? b.message : "" };
  }
  if (status === 429) return { ok: false, error: "rate-limited", message: "" };
  return { ok: false, error: "bad-reply", message: `The desktop answered ${status}, not a pairing reply. Is that the ${BRAND.displayName} daemon?` };
}

/** What the form says for a refusal: the host's own sentence for
 *  `no-password` (it knows why), our wording for the rest. */
export function redeemErrorText(r: Extract<RedeemReply, { ok: false }>): string {
  if (r.error === "no-password") return r.message || pairRedeemErrorText("no-password");
  if (r.error === "network" || r.error === "bad-reply") return r.message;
  return pairRedeemErrorText(r.error);
}

/** Which key a host-scoped value goes under for host `id`. */
export function scopedKeys(bareKey: string, id: string, activeId: string | null): string[] {
  if (id === activeId) return [bareKey];
  if (activeId === null) return [bareKey, parkedKeyFor(bareKey, id)];
  return [parkedKeyFor(bareKey, id)];
}

/**
 * The device token this phone already holds for the desktop at `base`, if it
 * is a saved host AT EXACTLY that address — sent with a re-pair so the host
 * retires this phone's old ledger row instead of leaving it as a ghost in
 * Paired devices. Never sent anywhere but the address that host is saved at.
 */
export function heldTokenFor(kv: KV, base: string): string | null {
  const host = readHosts(kv).find((h) => h.base === base);
  if (!host) return null;
  const key = host.id === activeHostId(kv) ? LS.deviceToken : parkedKeyFor(LS.deviceToken, host.id);
  const tok = kv.getItem(key);
  return isDeviceToken(tok) ? tok : null;
}

export type StoreResult =
  | { ok: true; host: SavedHost; added: boolean; isActive: boolean; wrote: string[] }
  | { ok: false; why: string };

/**
 * Store a successful redeem: the host (added, or the one already listed at that
 * address), its token and its LAN identity under that host's keys. Switching to
 * it is the caller's (`switchTo`, a reload).
 */
export function storeRedeemed(kv: KV, reply: Extract<RedeemReply, { ok: true }>, asked: PairTarget): StoreResult {
  const base = normalizeHostBase(reply.host.base) ?? asked.base;
  const lanBase = reply.host.lanBase ? normalizeHostBase(reply.host.lanBase) : null;
  const lan = lanBase ? { base: lanBase, ssids: reply.host.lanSsids ?? [], auto: false } : null;
  let host = readHosts(kv).find((h) => h.base === base || h.base === asked.base) ?? null;
  let added = false;
  if (host) {
    // Known already (re-paired): keep its name and LAN settings; only fill a
    // LAN address it did not have.
    if (!host.lan && lan) {
      const r = updateHost(kv, host.id, { name: host.name, base: host.base, lan });
      if (r.ok) host = r.host;
    }
  } else {
    const r = addHost(kv, { name: reply.host.name, base, lan });
    if (!r.ok) return r;
    host = r.host;
    added = true;
  }
  const active = activeHostId(kv);
  const wrote: string[] = [];
  const put = (bare: string, v: string) => {
    for (const k of scopedKeys(bare, host!.id, active)) { kv.setItem(k, v); wrote.push(k); }
  };
  if (isDeviceToken(reply.token)) {
    put(LS.deviceToken, reply.token);
    // A passive token opens on the passive screen even before the first status
    // read (`passiveMode.ts`); a full one clears a passive mark a re-pair left.
    if (reply.scope === "passive") put(LS.passive, "1");
    else for (const k of scopedKeys(LS.passive, host.id, active)) kv.removeItem(k);
  }
  const id = reply.lanIdentity;
  if (id && typeof id.hostId === "string" && typeof id.secret === "string" && id.secret.length >= 16) {
    put(LS.lanIdentity, JSON.stringify({ hostId: id.hostId, secret: id.secret }));
  }
  return { ok: true, host, added, isActive: host.id === active, wrote };
}
