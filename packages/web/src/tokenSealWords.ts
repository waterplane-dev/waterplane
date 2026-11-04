/**
 * What Settings › Connection › lock the desktop sign-ins says, the pure half: which saved desktops
 * the choice touches, and the sentences that let a person weigh it BEFORE choosing. Node-tested.
 * The flows and their refusal words are `features/appLock/logic.ts`'s; the storage is `tokenVault.ts`'s.
 *
 * **What the phone cannot know, it does not say.** `auth` reaches the phone for the desktop it is
 * connected to and no other, so a parked desktop's sign-in is `unknown`: never "alerts are not
 * affected", never "signs in again by itself". A desktop with no token is "no password" only when
 * the desktop itself said so; a parked one merely holds no sign-in.
 *
 * **No sentence claims the plaintext is gone.** A passive token and a bare token with no active
 * desktop stay on disk by design (`collectTokens`). They are drawn as what they are: `plain`, `stray`.
 *
 * **What opens the key is `sealKeyKind`, stored when `generate` made it.** A key made before an
 * update takes no PIN on the newest shell, so nothing about the shell can say. `anyKey` is the
 * guess for a key that does not exist yet (the link's `memoryTokens`: both shipped in one APK), so
 * it words only the choice to seal. A seal older than the stored kind reads null, and the words
 * then say what the sheet will show rather than pick.
 */
import { BRAND, parkedKeyFor, type SavedHost } from "@waterplane/shared";
import { lockRowCant, type LockPath, type LockReread } from "./appLock.ts";
import { isDeviceToken } from "./deviceToken.ts";
import { activeHostId, type KV } from "./hosts.ts";
import { savedRowPlain } from "./hostUrl.ts";
import { hasShellTls } from "./sdk/shellTls.ts";
import { LS } from "./storage.ts";
import { collectTokens, sealedHostIds } from "./tokenVault.ts";

/** Where a desktop needs this phone's sign-in. `unknown`: only the connected desktop says. */
export type SealReach = "wifi" | "tailnet" | "unknown";

export interface SealDesktop {
  id: string;
  name: string;
  active: boolean;
  /** Saved at an address where the fingerprint key is refused. */
  plain: boolean;
  /** `lockable`: in the lock, or going into it. `plain`: a token the lock does not take. */
  holds: "lockable" | "plain" | "none";
  reach: SealReach;
  /** Did the desktop itself say whether it has a password? Null: it has not. */
  password: boolean | null;
}

export interface SealFacts {
  desktops: SealDesktop[];
  /** Sign-ins in the lock, or going in: what `sealNow` would find. */
  lockable: number;
  /** Of those, the ones of a removed desktop: parked for a re-add, so not in the list. */
  removed: number;
  /** A bare token with no active desktop: no lock takes it. */
  stray: boolean;
}

/** The connected desktop's `auth`, or null when no socket is open to have told us. */
export type SealAuth = { enabled: boolean; gateTailscale: boolean } | null;

/** Is this row's SAVED address unprotected, on any network? Leaving a Wi-Fi changes nothing there. */
export const rowSavedPlain = (row: SavedHost | null): boolean => !!row && savedRowPlain(row, hasShellTls());

export function sealFacts(kv: KV, hosts: readonly SavedHost[], auth: SealAuth, isHeld: (id: string) => boolean): SealFacts {
  const activeId = activeHostId(kv);
  const plainTokens = collectTokens(kv);
  const sealed = kv.getItem(LS.tokenSealOn) === "1";
  const ids = new Set(sealed ? sealedHostIds(kv) : Object.keys(plainTokens));
  const bare = kv.getItem(LS.deviceToken);
  const desktops = hosts.map((h): SealDesktop => {
    const active = h.id === activeId;
    const inKey = isDeviceToken(kv.getItem(active ? LS.deviceToken : parkedKeyFor(LS.deviceToken, h.id)));
    const lockable = ids.has(h.id) || (sealed && isHeld(h.id));
    const said = active ? auth : null;
    return {
      id: h.id, name: h.name || h.base.replace(/^https?:\/\//, ""), active, plain: rowSavedPlain(h),
      holds: lockable ? "lockable" : inKey ? "plain" : "none",
      reach: said?.enabled ? (said.gateTailscale ? "tailnet" : "wifi") : "unknown",
      password: said ? said.enabled : null,
    };
  });
  const saved = new Set(hosts.map((h) => h.id));
  const held = desktops.filter((d) => d.holds === "lockable").length;
  const removed = [...ids].filter((id) => !saved.has(id)).length;
  return {
    desktops, lockable: held + removed, removed,
    stray: !activeId && isDeviceToken(bare) && !Object.values(plainTokens).includes(bare),
  };
}

/** What opens the sealed key. Null: sealed before the phone kept this, so it does not know. */
export type SealKeyKind = "any" | "biometric" | null;

export function sealKeyKind(kv: KV): SealKeyKind {
  const k = kv.getItem(LS.tokenSealAuth);
  return k === "any" || k === "biometric" ? k : null;
}

const list = (names: readonly string[]): string =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
const named = (f: SealFacts, reach: SealReach): string[] =>
  f.desktops.filter((d) => d.holds === "lockable" && d.reach === reach).map((d) => d.name);

/** What opens the lock, as the sentences say it. */
export const askedFor = (kind: SealKeyKind): string =>
  kind === "any" ? "your fingerprint or the phone's PIN" : kind === "biometric" ? "your fingerprint" : "your fingerprint, or the phone's PIN if its sheet offers one,";

const sealedUnder = (kind: SealKeyKind): string =>
  kind === "any" ? "your fingerprint or PIN" : kind === "biometric" ? "your fingerprint" : "your fingerprint (or PIN, if its sheet offers one)";

export const sealRowNote = (kind: SealKeyKind): string =>
  `Keeps this phone's sign-in to each password-protected desktop sealed under ${sealedUnder(kind)}; opening the app unlocks them.`;
export const SEAL_CONFIRM_TITLE = "Lock the desktop sign-ins?";
export const SEAL_OFF_TOAST = "desktop sign-ins unlocked — stored on this phone as before";
export const SEAL_OPEN_TOAST = "desktop sign-ins open until the app closes — they stay locked on this phone";
export const SEAL_NOT_OPENED = "Opened without the sign-ins: they stay locked until you unlock them.";
export const SEAL_STRAY = "One older sign-in belongs to no saved desktop, so this lock does not cover it.";

export const sealOnToast = (auth: "biometric" | "any" | undefined): string =>
  `desktop sign-ins locked — opening the app now asks for ${askedFor(auth === "any" ? "any" : "biometric")}`;

/** What the lock loses the sign-ins to. An `any` key survives a new fingerprint (`makeKey`). */
const losesThem = (kind: SealKeyKind): string =>
  kind === "any" ? "Removing the phone's screen lock" : kind === "biometric" ? "A fingerprint added or removed on this phone" : "Removing the phone's screen lock, or on an older key a fingerprint added or removed,";

/** The row's folded paragraph. */
export function sealRowMore(kind: SealKeyKind): string {
  const pin = kind === "biometric" ? " — the phone's PIN does not open them" : "";
  return `Guards against a copy of this phone's storage, not against someone holding the unlocked phone — that is lock this app. A desktop with no password has no sign-in to lock. With the sign-ins locked, opening the app asks for ${askedFor(kind)} before it connects${pin}. ${losesThem(kind)} loses the sign-ins: a desktop with a LAN password signs this phone in again by itself; one that gates the tailnet must be paired again.`;
}

/** The line under one desktop. `memory` is null until the shell has answered. `on`: the lock is on,
 *  so what it costs is a fact and not a consequence. */
export function perDesktopTail(d: SealDesktop, on: boolean, memory: boolean | null): string {
  if (d.holds === "plain") return "sign-in stays unlocked";
  if (d.holds === "none") {
    if (d.password === false) return "no password — nothing to lock";
    return d.password ? "no sign-in held yet — nothing to lock" : "no sign-in held — nothing to lock";
  }
  if (d.reach === "wifi") return "needed on your Wi-Fi only";
  if (d.reach === "unknown") return "sign-in held";
  if (memory === null) return "needed on the tailnet too";
  const cost = memory ? "alerts pause after a restart until you open the app" : "alerts need the app open";
  return `needed on the tailnet too — ${on ? "" : "once locked, "}${cost}`;
}

export const removedTail = "sign-in held";
export const removedName = (n: number): string => n === 1 ? "a removed desktop" : `${n} removed desktops`;

function alertLines(f: SealFacts, memory: boolean): string[] {
  const gated = named(f, "tailnet");
  const unknown = named(f, "unknown");
  if (!gated.length && !unknown.length) return ["Alerts are not affected: none of your desktops needs the sign-in on the tailnet."];
  const lines: string[] = [];
  if (gated.length) {
    lines.push(memory
      ? `With the app closed, alerts from ${list(gated)} keep coming until the phone restarts or Android stops the app; then they wait until you open it.`
      : `With the app closed, alerts from ${list(gated)} stop until you open the app.`);
  }
  if (unknown.length) {
    const needs = unknown.length === 1 ? `If ${unknown[0]} needs its sign-in on the tailnet` : `If ${list(unknown)} need their sign-ins on the tailnet`;
    const cost = gated.length ? "the same goes for its alerts" : memory
      ? "alerts keep coming until the phone restarts or Android stops the app, then wait until you open it"
      : "alerts stop with the app closed until you open it";
    lines.push(`${needs}, ${cost}. This phone can only tell for the desktop it is connected to.`);
  }
  return lines;
}

/** What each desktop in the lock does once its sign-in is gone. */
function rejoinParts(f: SealFacts): string[] {
  const lan = named(f, "wifi");
  const gated = named(f, "tailnet");
  const unknown = named(f, "unknown");
  return [
    lan.length ? `${list(lan)} ${lan.length === 1 ? "signs in again by itself" : "sign in again by themselves"}` : "",
    gated.length ? `${list(gated)} must be paired again` : "",
    unknown.length ? `${list(unknown)}: if signed out, pair again` : "",
  ].filter(Boolean);
}

function lostLine(f: SealFacts, kind: SealKeyKind): string {
  const parts = rejoinParts(f);
  return parts.length ? `${losesThem(kind)} loses the sign-ins: ${parts.join("; ")}.` : `${losesThem(kind)} loses the sign-ins.`;
}

export const SEAL_WAY_BACK = "Settings › Connection › lock the desktop sign-ins turns the lock back on.";
export const SEAL_PAIR_HOW = `on the desktop: \`${BRAND.slug} pair\`; here: Settings › Connection › hosts › pair with code`;

export const SEAL_FORGET_LABEL = "forget the locked sign-ins";
export const SEAL_FORGET_TITLE = "Forget the locked sign-ins?";
export const SEAL_FORGET_NOTE = "These sign-ins cannot be opened on this phone. If updating the app does not help, forget them to leave this lock.";
export const SEAL_FORGET_TOAST = "locked sign-ins forgotten — the lock is off";
/** The tap outlived the refusal: the sign-ins opened, or the lock went off, while the card was up. */
export const SEAL_FORGET_MOOT = "nothing forgotten — the sign-ins are no longer stuck";

/** Desktop by desktop. With a blob this build cannot read the phone has no names to give. */
function rejoinSentence(f: SealFacts): string {
  const parts = rejoinParts(f);
  if (f.removed > 0) parts.push(`${removedName(f.removed)} must be paired again if added back`);
  return parts.length
    ? `${parts.join("; ")}.`
    : "A desktop with a LAN password signs this phone in again by itself; one that gates the tailnet must be paired again.";
}

/** The confirm card: what goes, then what to do on each desktop. The bytes stay, so it never says deleted. */
export function forgetLines(f: SealFacts): string[] {
  return [
    "This phone stops using every sign-in in the lock, including one paired since the app started, and the lock goes off. The app does not use them again: the locked copy only stays set aside on this phone.",
    rejoinSentence(f),
    `To pair: ${SEAL_PAIR_HOW}.`,
  ];
}

/** The row's sentence afterwards, until dismissed. */
export function forgetDoneWords(f: SealFacts): string {
  return `The locked sign-ins are forgotten and the lock is off. ${rejoinSentence(f)} To pair: ${SEAL_PAIR_HOW}. ${SEAL_WAY_BACK}`;
}

/** The confirm card: what opening the app costs, what happens to alerts, what can lose them.
 *  `anyKey` and `memory` are one answer today, kept apart because they say different things. */
export function tradeoffLines(f: SealFacts, caps: { anyKey: boolean; memory: boolean }): string[] {
  const kind = caps.anyKey ? "any" : "biometric";
  const pin = caps.anyKey ? "" : " The phone's PIN does not open them on this app version.";
  const plain = f.desktops.filter((d) => d.plain).map((d) => d.name);
  return [
    `Opening the app will ask for ${askedFor(kind)} before it connects.${pin}`,
    ...alertLines(f, caps.memory),
    ...(plain.length ? [`${list(plain)} ${plain.length === 1 ? "is" : "are"} saved at an unprotected address: on it the fingerprint key is refused, so the app opens without the sign-ins.`] : []),
    lostLine(f, kind),
  ];
}

export interface SealRowInput {
  path: LockPath | null;
  /** The app lock's switch. */
  lockOn: boolean;
  /** The route right now is not protected (`plainHostRoute`), whatever the saved address is. */
  routePlain: boolean;
  /** `lockStatus()` on a shell that has it, else `status()`: what `appLockAdapter.reread` gives. */
  read: LockReread | null;
}

/** Why the switch cannot go on, or null. Asked only while it is off: a lock that is on shows its switch. */
export function sealRowCant(f: SealFacts, r: SealRowInput): string | null {
  if (r.path === null) return "needs a newer Android app — this one has no fingerprint keystore";
  if (f.lockable === 0) {
    const waiting = f.desktops.find((d) => d.active && d.password === true);
    if (waiting) return `nothing to lock yet: ${waiting.name} has a password, but this phone holds no sign-in for it`;
    return f.stray
      ? "nothing to lock: the one sign-in on this phone belongs to no saved desktop"
      : "nothing to lock: none of your desktops has a password, so this phone holds no sign-in";
  }
  const refused = (name: string) => `needs the tailnet — ${name} is saved at an unprotected address, where the fingerprint key is refused`;
  // This shell's lock check is the same key, so with the lock on the card there has no way past it.
  const trap = r.path === "sentinel" && r.lockOn ? f.desktops.find((d) => d.plain) : undefined;
  if (trap) return `${refused(trap.name)}. With the app lock on, nothing would open the app there: save its tailnet address, or update the Android app`;
  const here = f.desktops.find((d) => d.active && d.plain);
  if (here) return refused(here.name);
  if (r.routePlain) return "needs the tailnet — the fingerprint key is refused while the route to the desktop is not protected. Leave this Wi-Fi so the app goes over the tailnet";
  return lockRowCant(r.path, false, r.read);
}
