/**
 * Pairing over a network nobody trusts: what the page does around `shared/pake.ts`. Pure over a
 * transport it is handed, node-tested (`pairPake.test.mjs`); the form is `PairForm.tsx`, storing a
 * seal is `pairRedeem.ts`'s `storeSealed`.
 *
 * Every pairing tries PAKE first, on any address. What happens when it does not end in a seal turns
 * on one fact, whether `asked.base` is plain (`isPlainRoute`):
 *
 * - **A protected address may go on to `redeem`** with no question: `no-password` is the normal
 *   state of a tailnet-only desktop, `closed` codes are meant to keep working over the tailnet, and
 *   an older desktop on the tailnet is what most people still have. The reply is unsealed, so Rule 1
 *   holds (`storeRedeemed`), and the code did not cross anything plain.
 * - **A plain address never does on a refusal.** A typed refusal came from a host that speaks PAKE,
 *   so going on could only hand a relay the code. It says what to do instead, in OUR words: nothing
 *   an unauthenticated reply says is put on screen.
 * - **A plain address that does not speak PAKE at all** (404, or 401 from an older gated desktop)
 *   gets one `Confirm` worded for both readings, because an older desktop must stay pairable. `s=1`
 *   takes that question away. A reply AFTER a good `start` is never read as an older desktop: a relay
 *   could otherwise let `start` through and force the question at `finish`.
 *
 * **A code sent plain is dead on this phone.** A relay that forced the `Confirm` knows the code and
 * could then play the PAKE host. So the code is marked BEFORE it goes out and the mark outlives the
 * app being killed. It is held as a hash, and only for as long as a code can live.
 *
 * A failure on the phone's own side (no WebCrypto, the group not loading) is told apart from a bad
 * reply by when it happens: `pakePhoneStart` reads nothing from the network, so no relay can cause
 * one. The APK's page is `http://localhost`, a secure context, so WebCrypto is there; this is for a
 * WebView too old for the rest of it.
 */
import {
  PAIR_TTL_MS, cleanHostTls, isHostId, pairCommit, pakeDecode, pakeErrorText, pakePhoneFinish, pakePhoneOpen, pakePhoneStart, sha256,
  type PairTarget, type PakeBoxBody, type PakeError, type PakeSealedReply,
} from "@waterplane/shared";
import type { KV } from "./hosts.ts";
import { parseLanIdentity } from "./lanRoute.ts";
import { LS } from "./storage.ts";

/** What `askConfirm` is handed. */
export interface PairAsk { title: string; lines: string[]; confirmLabel: string; cancelLabel: string }

export type PairNext =
  | { kind: "sealed"; reply: PakeSealedReply }
  /** A protected address: redeem, unsealed, with no question. */
  | { kind: "redeem" }
  /** A plain address: redeem only if the person says so, and the code is dead from then on. */
  | { kind: "ask"; ask: PairAsk }
  | { kind: "stop"; why: string };

type Answer = { status: number; body: unknown };

/** Each resolves with the status and whatever body came back, and rejects only on transport. */
export interface PakeRoute {
  start(base: string, req: { sidP: string; ya: string }): Promise<Answer>;
  finish(base: string, req: { sidP: string; confirm: string[]; box: string[] }): Promise<Answer>;
}

const UNPROTECTED = "If you go on, the code and this phone's sign-in cross the network unprotected, and anyone listening can use them.";

export const PAIR_ASK_OLD: PairAsk = {
  title: "This desktop did not answer encrypted pairing",
  lines: [
    "It may be an older desktop. Or someone on this network may be blocking encrypted pairing, and then you should stop.",
    UNPROTECTED,
  ],
  confirmLabel: "pair unprotected",
  cancelLabel: "stop",
};

export const PAIR_ASK_PHONE: PairAsk = {
  title: "This phone cannot run encrypted pairing",
  lines: ["Its web view lacks what encrypted pairing needs.", UNPROTECTED],
  confirmLabel: "pair unprotected",
  cancelLabel: "stop",
};

export const PAIR_NOT_SENT = "Stopped. The code was not sent, and it still works.";
export const PAIR_SECURE_ONLY =
  "That address did not answer encrypted pairing, and this code is for encrypted pairing only. Nothing was sent. Check the address on the desktop's screen: someone may be blocking it.";
export const PAIR_SECURE_ONLY_PHONE =
  "This phone cannot run encrypted pairing, and this code is for encrypted pairing only. Nothing was sent. Pair over the desktop's Tailscale address instead.";
export const PAIR_CODE_SENT_PLAIN =
  "This code already crossed the network unprotected, so this phone will not use it again. Show a new code on the desktop.";
export const PAIR_NO_PASSWORD_PLAIN =
  "This desktop has no password set, so it will not pair over an unprotected address. Set a password on the desktop, then show a new code.";
export const PAIR_SEAL_WRONG =
  "Something at that address answered, but could not prove it is the desktop showing this code, so nothing was saved. Check the address, and show a new code on the desktop.";
export const PAIR_COMMIT_WRONG =
  "The desktop that answered is not the one whose QR you scanned, so nothing was saved. Check the address, and show a new code on the desktop's own screen.";
export const PAIR_NOT_RECORDED =
  "This phone's storage is full, so it could not note that this code is about to go out unprotected. Nothing was sent. Free some space and try again.";

function replyProblem(status: number): string {
  return `The desktop answered ${status}, not a pairing reply. Check the address.`;
}

export function pairUnreachable(base: string, plain: boolean): string {
  return plain
    ? `Could not reach ${base}. Check that this phone is on the desktop's Wi-Fi and the desktop is awake.`
    : `Could not reach ${base}. Check that Tailscale is connected on this phone and the desktop is awake.`;
}

const PAKE_ERRORS: readonly PakeError[] = ["bad-request", "unknown", "expired", "used", "rate-limited", "no-password", "closed", "no-codes", "no-session"];

/** A refusal from a host that speaks PAKE. The three a tailnet pairing outlives go on to `redeem`
 *  there; on a plain address every refusal is the end. */
function refused(error: PakeError, plain: boolean): PairNext {
  if (error === "no-password" || error === "closed" || error === "no-codes") {
    if (!plain) return { kind: "redeem" };
    if (error === "no-password") return { kind: "stop", why: PAIR_NO_PASSWORD_PLAIN };
  }
  return { kind: "stop", why: pakeErrorText(error) };
}

/** An answer that is not `ok`: a typed refusal, else a sentence about the status. */
function notOk(a: Answer, plain: boolean): PairNext {
  const b = a.body as { ok?: unknown; error?: unknown } | null;
  if (b && typeof b === "object" && b.ok === false && PAKE_ERRORS.includes(b.error as PakeError)) return refused(b.error as PakeError, plain);
  return { kind: "stop", why: a.status === 429 ? pakeErrorText("rate-limited") : replyProblem(a.status) };
}

/** Nothing here spoke PAKE, for a reason that is no refusal. */
function noPake(t: PairTarget, plain: boolean, side: "desktop" | "phone"): PairNext {
  if (!plain) return { kind: "redeem" };
  if (t.secure) return { kind: "stop", why: side === "phone" ? PAIR_SECURE_ONLY_PHONE : PAIR_SECURE_ONLY };
  return { kind: "ask", ask: side === "phone" ? PAIR_ASK_PHONE : PAIR_ASK_OLD };
}

/** A seal's contents, read as strictly as the wire is: one bad field and none of it is believed. */
export function readSealedReply(v: unknown): PakeSealedReply | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  const host = b.host as Record<string, unknown> | null | undefined;
  if (b.ok !== true || !host || typeof host !== "object" || typeof host.name !== "string" || !isHostId(b.hostId)) return null;
  if (parseLanIdentity(b.lanIdentity)?.hostId !== b.hostId) return null;
  if (b.tls !== undefined && !cleanHostTls(b.tls)) return null;
  if (b.updateKey !== undefined && !pakeDecode(b.updateKey)?.length) return null;
  return v as PakeSealedReply;
}

/**
 * One pairing attempt, up to the point the page acts: store a seal, redeem, ask, or stop. Sends no
 * `Authorization` (`bearerFor` skips these routes): `box.presented` is how an old token travels.
 */
export async function pairStep(t: PairTarget, plain: boolean, box: PakeBoxBody, route: PakeRoute): Promise<PairNext> {
  let phone: Awaited<ReturnType<typeof pakePhoneStart>>;
  try {
    phone = await pakePhoneStart(t.code);
  } catch {
    return noPake(t, plain, "phone");
  }
  let start: Answer;
  try {
    start = await route.start(t.base, phone.request);
  } catch {
    return { kind: "stop", why: pairUnreachable(t.base, plain) };
  }
  // New-host refusals are never these two, which is what makes them an older desktop's answer.
  if (start.status === 404 || start.status === 401) return noPake(t, plain, "desktop");
  const said = start.body as { ok?: unknown; nh?: unknown; yb?: unknown } | null;
  if (said?.ok !== true) return notOk(start, plain);
  let answer: Awaited<ReturnType<typeof pakePhoneFinish>>;
  try {
    answer = await pakePhoneFinish(phone.state, { nh: said.nh, yb: said.yb }, box);
  } catch {
    return { kind: "stop", why: PAIR_SEAL_WRONG };
  }
  let finish: Answer;
  try {
    finish = await route.finish(t.base, answer.request);
  } catch {
    return { kind: "stop", why: pairUnreachable(t.base, plain) };
  }
  const done = finish.body as { ok?: unknown; seal?: unknown } | null;
  if (done?.ok !== true) return notOk(finish, plain);
  const reply = readSealedReply(await pakePhoneOpen(answer.candidates, done.seal).catch(() => null));
  if (!reply) return { kind: "stop", why: PAIR_SEAL_WRONG };
  if (t.commit && (await pairCommit(reply.updateKey, reply.tls?.spki)) !== t.commit) return { kind: "stop", why: PAIR_COMMIT_WRONG };
  return { kind: "sealed", reply };
}

// ── A code sent plain ─────────────────────────────────────────────────────

const hex = (b: Uint8Array): string => Array.from(b, (c) => c.toString(16).padStart(2, "0")).join("");

/** What the mark holds, or null on a phone with no WebCrypto, which can never run PAKE anyway. */
export async function codeMark(code: string): Promise<string | null> {
  try { return hex(await sha256(new TextEncoder().encode(code))); } catch { return null; }
}

type SentMark = { mark: string; at: number };

/** The marks still inside a code's life. Unreadable storage is no marks, never a throw. */
function liveMarks(kv: KV, now: number): SentMark[] {
  let v: unknown;
  try { v = JSON.parse(kv.getItem(LS.pairCodesSent) ?? "[]"); } catch { return []; }
  if (!Array.isArray(v)) return [];
  return v.filter((m: SentMark) => !!m && typeof m.mark === "string" && typeof m.at === "number" && now - m.at < PAIR_TTL_MS);
}

export function codeWentPlain(kv: KV, mark: string, now: number): boolean {
  return liveMarks(kv, now).some((m) => m.mark === mark);
}

/** Before the code leaves. False: it could not be written, so the code must not leave either. */
export function markCodePlain(kv: KV, mark: string, now: number): boolean {
  try {
    kv.setItem(LS.pairCodesSent, JSON.stringify([...liveMarks(kv, now), { mark, at: now }]));
    return true;
  } catch { return false; }
}
