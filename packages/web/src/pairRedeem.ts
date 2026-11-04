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
 * - **What a redeem hands back lands under the right host.** The token is a
 *   host-scoped key (`KEY_SCOPE`): bare for the ACTIVE host, parked under
 *   `waterplane.h.<id>.` for any other — written parked for a host that is about
 *   to become active too, because the switch at the next boot restores parked
 *   over bare. With no active host at all (the first run), both: the boot's
 *   restore then only fills keys that are missing.
 * - **A row's address is what the person asked for, and nothing else.** A plain
 *   redeem's reply can come from whoever answers that address, so it names a
 *   desktop and hands over a token and that is all (`storeRedeemed`). A seal
 *   proves more (`storeSealed`), and still never supplies the address.
 *
 * What runs before either store is `pairPake.ts`: PAKE first, on any address.
 */
import {
  BRAND, decideLanRoute, isPlainRoute, isProxyBase, needsTunnel, normalizeHostBase, normalizePairCode, parkedKeyFor, parsePairDeepLink, parsePairInput, pairRedeemErrorText,
  type HostLan, type NetState, type PairRedeemError, type PairRedeemResponse, type PairTarget, type PakeSealedReply, type SavedHost,
} from "@waterplane/shared";
import { activeHostId, addHost, readHosts, setHostPins, setHostTlsOff, setHostUpdateKey, updateHost, type KV } from "./hosts.ts";
import { forgetHeldToken, heldToken, holdToken, isDeviceToken } from "./deviceToken.ts";
import type { PairAsk } from "./pairPake.ts";
import { LS } from "./storage.ts";

/** The pair form's two fields, as typed. */
export interface PairFields { address: string; code: string }

/** A paste into the ADDRESS field that is a whole link: both fields, from it.
 *  Null when the text is just an address (or nothing). */
export function fieldsFromPaste(text: string): PairFields | null {
  const t = parsePairInput(text);
  return t ? { address: t.base, code: t.code } : null;
}

/**
 * What the form would pair with, or null while either field is not usable. `link` is the link that
 * filled the form: what it says (`s=1`, `k=`, `l=`) is about the desktop behind its CODE, so it
 * holds through a changed address and is dropped with a changed code.
 */
export function pairTargetOf(f: PairFields, link?: PairTarget | null): PairTarget | null {
  const linked = parsePairInput(f.address);
  if (linked) return linked;
  const base = normalizeHostBase(f.address);
  const code = normalizePairCode(f.code);
  if (!base || !code) return null;
  return link?.code === code ? { ...link, base } : { base, code };
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
 * `lanToo`: its LAN address counts as well, for a `box` only, because there the token is sealed;
 * a plain redeem would put it in a header on that address.
 */
export function heldTokenFor(kv: KV, base: string, lanToo = false): string | null {
  const host = readHosts(kv).find((h) => h.base === base || (lanToo && h.lan?.base === base));
  if (!host) return null;
  const sealed = kv.getItem(LS.tokenSealOn) === "1" ? heldToken(host.id) : null;
  if (sealed) return sealed;
  const key = host.id === activeHostId(kv) ? LS.deviceToken : parkedKeyFor(LS.deviceToken, host.id);
  const tok = kv.getItem(key);
  return isDeviceToken(tok) ? tok : null;
}

export type StoreResult =
  | {
      ok: true; host: SavedHost; added: boolean; isActive: boolean; wrote: string[]; sealedPending: boolean;
      /** A seal moved the row's address: on the active row, the caller's reload to make. */
      moved?: boolean;
    }
  | { ok: false; why: string };

/** Why a plain reply leaves a row alone, and the way out. */
export const PAIR_ROW_KEPT =
  "Nothing changed: this phone already holds that desktop's keys, and this pairing cannot prove it came from the same desktop. Get a new code on the desktop and pair again, or remove the desktop from this phone's list to start over.";

/** A row a plain reply may not touch: it holds something only a proof or the person put there. */
function holdsProof(h: SavedHost): boolean {
  return !!(h.tls || h.vouched || h.hostId);
}

/**
 * Store a redeem whose reply nothing authenticates: the host (added, or the one
 * listed at the address asked), and its token under that host's keys. Switching
 * to it is the caller's (`switchTo`, a reload).
 *
 * **Rule 1.** The row's address is `asked.base` and the reply's `base` is never
 * read: a phone with Tailscale off sends a `100.x` request to whoever runs the
 * Wi-Fi, and a planted address would be protected by name from then on. For the
 * same reason this writes no `hostId`, `tls`, `updateKey` or LAN identity, a
 * `lanBase` is kept only if it is plain by name, and a row holding `tls`,
 * `vouched` or `hostId` is refused whole, token included.
 *
 * The LAN route does not need the identity from here: `ensureIdentity`
 * (`lanLink.ts`) reads it over the tailnet the first time the ladder gets that
 * far, which is the only path the host ever handed it to.
 *
 * In sealed mode a full token goes to memory and never to a key: `sealedPending` tells the caller
 * to re-wrap in the same tap, before the reload forgets it. A passive token stays plain, as it
 * does in every mode (the passive screen has no prompt to open a seal with).
 */
export function storeRedeemed(kv: KV, reply: Extract<RedeemReply, { ok: true }>, asked: PairTarget): StoreResult {
  const base = normalizeHostBase(asked.base);
  if (!base) return { ok: false, why: "Not an address. Use a host name or IP, optionally with a port." };
  const lanBase = reply.host.lanBase ? normalizeHostBase(reply.host.lanBase) : null;
  const lan = lanBase && isPlainRoute(lanBase) ? { base: lanBase, ssids: reply.host.lanSsids ?? [], auto: false } : null;
  let host = readHosts(kv).find((h) => h.base === base) ?? null;
  let added = false;
  if (host) {
    if (holdsProof(host)) return { ok: false, why: PAIR_ROW_KEPT };
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
  return { ok: true, host, added, ...writeSignIn(kv, host, reply) };
}

/** A reply's token under its row's keys, in whichever mode this phone is in. */
function writeSignIn(kv: KV, host: SavedHost, reply: Extract<RedeemReply, { ok: true }>): { isActive: boolean; wrote: string[]; sealedPending: boolean } {
  const active = activeHostId(kv);
  const wrote: string[] = [];
  const put = (bare: string, v: string) => {
    for (const k of scopedKeys(bare, host.id, active)) { kv.setItem(k, v); wrote.push(k); }
  };
  let sealedPending = false;
  if (isDeviceToken(reply.token)) {
    const sealed = kv.getItem(LS.tokenSealOn) === "1";
    if (sealed && reply.scope !== "passive") {
      holdToken(host.id, reply.token);
      for (const k of scopedKeys(LS.deviceToken, host.id, active)) kv.removeItem(k);
      sealedPending = true;
    } else {
      // Held wins over storage, so a full token this one replaces must not stay held.
      if (sealed) forgetHeldToken(host.id);
      put(LS.deviceToken, reply.token);
    }
    // A passive token opens on the passive screen even before the first status
    // read (`passiveMode.ts`); a full one clears a passive mark a re-pair left.
    if (reply.scope === "passive") put(LS.passive, "1");
    else for (const k of scopedKeys(LS.passive, host.id, active)) kv.removeItem(k);
  }
  return { isActive: host.id === active, wrote, sealedPending };
}

// ── A seal ────────────────────────────────────────────────────────────────

const shown = (base: string): string => base.replace(/^https?:\/\//, "");

/** The person said no to a second question, after the desktop had already spent the code. */
export const PAIR_SEALED_KEPT =
  "Nothing changed: this phone kept the desktop as it was saved and dropped the new sign-in. That code is spent, so pairing again needs a new one.";

/** The row a seal lands on: the one with its desktop id, else one at the address asked, so one
 *  desktop never gets two rows. Null: a new desktop to this phone. */
function sealedRow(kv: KV, reply: PakeSealedReply, base: string): SavedHost | null {
  const rows = readHosts(kv);
  return rows.find((h) => h.hostId === reply.hostId) ?? rows.find((h) => h.base === base) ?? rows.find((h) => h.lan?.base === base) ?? null;
}

/**
 * The second question a seal needs, or null. A `hostId` is public and a seal proves only "the host
 * that knew the code", so a row moves to a new address only when the person sees both addresses,
 * and an id that changed under an address is a new desktop, said in words.
 */
export function sealedAsk(kv: KV, reply: PakeSealedReply, asked: PairTarget): PairAsk | null {
  const base = normalizeHostBase(asked.base);
  const row = base ? sealedRow(kv, reply, base) : null;
  if (!base || !row) return null;
  if (row.hostId && row.hostId !== reply.hostId) {
    return {
      title: `A different desktop at ${shown(base)}`,
      lines: [
        `${row.name} was saved at this address, and the desktop answering now is not the same one.`,
        "That is expected after reinstalling the desktop. If you did not, keep the old one.",
      ],
      confirmLabel: "replace it",
      cancelLabel: "keep the old one",
    };
  }
  if (row.hostId === reply.hostId && row.base !== base && row.lan?.base !== base) {
    return {
      title: `Move ${row.name} to this address?`,
      lines: [
        `${row.name} is saved at ${shown(row.base)}. This pairing was made at ${shown(base)}.`,
        "A code shows who held it, not where the desktop is. Go on only if the desktop's own screen shows the new address.",
      ],
      confirmLabel: "use the new address",
      cancelLabel: "keep the old one",
    };
  }
  return null;
}

/** The LAN side after a seal: what it stated, keeping the person's own choices; never the row's base. */
function lanAfter(prev: HostLan | undefined, said: HostLan | null, base: string): HostLan | null {
  const next = said ? { ...said, ssids: prev?.ssids.length ? prev.ssids : said.ssids, auto: prev?.auto ?? said.auto } : prev ?? null;
  return next && next.base !== base ? next : null;
}

/**
 * Store a reply a seal authenticated, after `sealedAsk` was answered. The caller has checked the
 * seal and any `k=`. **Rule 1 still holds:** the address is `asked.base`, and `reply.host.base` is
 * never read. What a seal adds over `storeRedeemed`: the desktop's id, TLS pin, update key and LAN
 * identity, and the right to touch a row holding proof.
 *
 * **Asked at the LAN address of a row with another `base`, the row keeps that `base`.** The address
 * asked is one the row already holds, so nothing moved, and writing it over `base` would lose the
 * tailnet address. No reply supplies anything here either. A new desktop at that LAN address is the
 * exception: the old `base` is the old desktop's, so the person's "replace it" takes the address asked.
 *
 * `tlsOff` goes first because `setHostPins` refuses a pin while it is on. Native pins are
 * `pinSealed`'s (`pairNative.ts`), which the caller runs next. A row whose address is a vouched
 * proxy takes no TLS pin (`isProxyBase`), and loses one it holds.
 */
export function storeSealed(kv: KV, reply: PakeSealedReply, asked: PairTarget): StoreResult {
  const base = normalizeHostBase(asked.base);
  if (!base) return { ok: false, why: "Not an address. Use a host name or IP, optionally with a port." };
  const lanBase = reply.host.lanBase ? normalizeHostBase(reply.host.lanBase) : null;
  const said = lanBase && isPlainRoute(lanBase) ? { base: lanBase, ssids: reply.host.lanSsids ?? [], auto: false } : null;
  const row = sealedRow(kv, reply, base);
  const newDesktop = !!row?.hostId && row.hostId !== reply.hostId;
  const rowBase = row && !newDesktop && row.lan?.base === base ? row.base : base;
  let host: SavedHost;
  if (row) {
    const lan = lanAfter(row.lan, said, rowBase);
    host = row;
    // `updateHost` clears `vouched`, so a re-pair that changes nothing writes nothing.
    if (row.base !== rowBase || JSON.stringify(lan) !== JSON.stringify(row.lan ?? null)) {
      const r = updateHost(kv, row.id, { name: row.name, base: rowBase, lan });
      if (!r.ok) return r;
      host = r.host;
    }
  } else {
    const r = addHost(kv, { name: reply.host.name, base, lan: lanAfter(undefined, said, base) });
    if (!r.ok) return r;
    host = r.host;
  }
  const off = host.tlsOff ? setHostTlsOff(kv, host.id, false) : null;
  if (off && !off.ok) return off;
  const pins = setHostPins(kv, host.id, { hostId: reply.hostId, tls: isProxyBase(host.base) ? null : reply.tls ?? null });
  if (!pins.ok) return pins;
  host = pins.host;
  const key = reply.updateKey
    ? { key: reply.updateKey, gen: !newDesktop && row?.updateKey?.key === reply.updateKey ? row.updateKey.gen : 0 }
    : newDesktop ? null : undefined;
  if (key !== undefined) {
    const r = setHostUpdateKey(kv, host.id, key);
    if (!r.ok) return r;
    host = r.host;
  }
  const identity = scopedKeys(LS.lanIdentity, host.id, activeHostId(kv));
  for (const k of identity) kv.setItem(k, JSON.stringify(reply.lanIdentity));
  const signIn = writeSignIn(kv, host, reply);
  return { ok: true, host, added: !row, ...signIn, wrote: [...identity, ...signIn.wrote], moved: !!row && row.base !== rowBase };
}

/** The address the pair form opens on: a shell that says there is no tailnet here takes the LAN one. */
export function pairAddressOf(t: Pick<PairTarget, "base" | "lan">, net: NetState | null): string {
  return net?.tailnet === false && t.lan ? t.lan : t.base;
}

/**
 * Paired at a row's LAN address, the row keeps its `base`, and nothing here turns a setting on: so a
 * phone with Tailscale off, on a row the LAN ladder will not take from this network, has no route
 * yet. The sentence for that case, null in any other. The ladder itself says whether it would get
 * as far as a probe.
 */
export function pairedNoRoute(host: Pick<SavedHost, "name" | "base" | "lan">, asked: string, net: NetState | null): string | null {
  const base = normalizeHostBase(asked);
  if (!base || host.base === base || host.lan?.base !== base) return null;
  if (net?.tailnet !== false || !needsTunnel(host.base)) return null;
  if (decideLanRoute({ host, net, probe: null, macVerified: null, lastFailure: null }).next === "probe") return null;
  return `Paired with ${host.name}, but this phone cannot reach it yet: Tailscale is off, and its LAN address is only used with "switch to LAN automatically" on and this Wi-Fi on its list. Nothing was changed. Turn Tailscale on, or set both in Connection health › change LAN settings.`;
}
