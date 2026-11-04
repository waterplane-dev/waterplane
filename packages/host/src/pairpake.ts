/**
 * The host's half of PAKE pairing (`shared/pake.ts`), for a phone on a network nobody trusts.
 *
 *   POST /api/pair/pake/start  {sidP, ya}              PRE-auth, rate-limited per remote IP
 *   POST /api/pair/pake/finish {sidP, confirm, box}    the same
 *
 * No request header is read on either route: the phone's old token, if it has one, rides sealed as
 * `presented` in the `box`.
 *
 * **A session is one try.** It lives `PAKE_SESSION_TTL_MS`, at most `PAKE_MAX_SESSIONS` are held with
 * the oldest dropped, and the first `finish` deletes it before anything else is decided, so a
 * replayed `finish` finds nothing. A `start` naming a live session is refused rather than replacing
 * it: a relay must not be able to reset the attempt a phone is in the middle of.
 *
 * **Every confirm against every code, whatever matched first.** A confirm that hits but whose `box`
 * does not open is a miss too, so a relay cannot tell a hit from a miss by tampering.
 *
 * **A miss costs every code offered one of its `PAKE_MISS_CAP` tries.** Past that the code is closed
 * for PAKE only: it stays live for redeem, so someone on the Wi-Fi can stop an encrypted pairing,
 * which dropping packets does anyway, but cannot burn a code meant for the tailnet.
 *
 * A hit spends the code through `redeemPair`'s own path, and only the words around it are added
 * here. The LAN identity may go to a LAN redeemer because it is sealed.
 */
import { randomBytes } from "node:crypto";
import {
  PAKE_CONFIRM_BYTES, PAKE_MAX_OFFERS, PAKE_NONCE_BYTES, PAKE_POINT_BYTES, PAKE_SID_BYTES,
  PakeFailure, pairCommit, pakeDecode, pakeEncode, pakeErrorText, pakeHostOffer, pakeOpenBox, pakeSeal, pakeShareOk, updateKeyFingerprint,
  type PairLinkFacts, type PakeError, type PakeFinishResponse, type PakeOffer, type PakeRefusal, type PakeSealedReply, type PakeStartResponse,
} from "@waterplane/shared";
import { lanIdentity } from "./lanid.js";
import { lanTlsFacts, type LanTlsFacts } from "./lantls.js";
import { updatePublicKey } from "./updatekey.js";
import type { PairDeps, PairNet, PairRedeemReply } from "./pair.js";

export const PAKE_SESSION_TTL_MS = 60_000;
export const PAKE_MAX_SESSIONS = 16;
/** Wrong confirms a code survives before it closes for PAKE. */
export const PAKE_MISS_CAP = 10;
/** The longest `box` opened, in base64 characters: a device name and a token fit many times over. */
const MAX_BOX_CHARS = 2048;

const NO_PASSWORD = "This desktop has no password set, so it refuses encrypted pairing: there would be no token to give this phone. Set a password on the desktop, then show a new code.";

interface PakeHeld extends PakeOffer { hash: Buffer }
interface PakeSession { at: number; offers: PakeHeld[] }

export interface PakeSessionOpts { now?: () => number; ttlMs?: number; max?: number }

/** Memory only, like the codes it was derived from. */
export class PakeSessions {
  private live = new Map<string, PakeSession>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly max: number;

  constructor(opts: PakeSessionOpts = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? PAKE_SESSION_TTL_MS;
    this.max = opts.max ?? PAKE_MAX_SESSIONS;
  }

  private prune(now: number): void {
    for (const [sid, s] of this.live) if (now >= s.at + this.ttlMs) this.live.delete(sid);
  }

  has(sid: string): boolean {
    this.prune(this.now());
    return this.live.has(sid);
  }

  /** Hold a session, the oldest out past the cap. False: this `sid` is already live. */
  put(sid: string, offers: PakeHeld[]): boolean {
    const now = this.now();
    this.prune(now);
    if (this.live.has(sid)) return false;
    while (this.live.size >= this.max) this.live.delete(this.live.keys().next().value!);
    this.live.set(sid, { at: now, offers });
    return true;
  }

  /** The session, gone from here whatever happens next. Null: past its time or never held. */
  take(sid: string): PakeHeld[] | null {
    this.prune(this.now());
    const s = this.live.get(sid);
    this.live.delete(sid);
    return s?.offers ?? null;
  }

  get size(): number {
    this.prune(this.now());
    return this.live.size;
  }
}

const refusal = (error: PakeError, message = pakeErrorText(error)): PakeRefusal => ({ ok: false, error, message });

export type PakeDeps = Pick<PairDeps, "root" | "auth" | "store" | "tls">;

/** `start`: one share per code this attempt may be for, the newest first to stay when there are more
 *  than `PAKE_MAX_OFFERS`, because "show a new QR" is what the phone tells a person whose code was left
 *  out. Nothing is spent, whatever the answer. */
export async function pakeStart(body: Record<string, unknown>, deps: PakeDeps): Promise<{ status: number; body: PakeStartResponse }> {
  const sidP = pakeDecode(body.sidP, PAKE_SID_BYTES);
  const ya = pakeDecode(body.ya, PAKE_POINT_BYTES);
  if (!sidP || !ya || !(await pakeShareOk(ya))) return { status: 400, body: refusal("bad-request") };
  if (!deps.auth.isEnabled()) return { status: 403, body: refusal("no-password", NO_PASSWORD) };
  const { live, open } = deps.store.pakeCodes();
  if (live === 0) return { status: 409, body: refusal("no-codes") };
  if (open.length === 0) return { status: 409, body: refusal("closed") };
  const sid = body.sidP as string;
  if (deps.store.pake.has(sid)) return { status: 400, body: refusal("bad-request") };
  const nh = randomBytes(PAKE_NONCE_BYTES);
  const offers: PakeHeld[] = [];
  for (const hash of open.slice(-PAKE_MAX_OFFERS)) {
    try {
      offers.push({ ...(await pakeHostOffer(hash, sidP, ya, nh)), hash });
    } catch (e) {
      if (e instanceof PakeFailure) return { status: 400, body: refusal("bad-request") };
      throw e;
    }
  }
  if (!deps.store.pake.put(sid, offers)) return { status: 400, body: refusal("bad-request") };
  return { status: 200, body: { ok: true, nh: pakeEncode(nh), yb: offers.map((o) => pakeEncode(o.yb)) } };
}

/** The offer whose confirm arrived, and at which index. Every pair is compared, with no early exit
 *  on a hit; `compare` is the store's `timingSafeEqual`. */
function matchConfirm(offers: readonly PakeHeld[], confirms: readonly Uint8Array[], compare: (a: Buffer, b: Buffer) => boolean): { offer: PakeHeld; at: number } | null {
  let hit: { offer: PakeHeld; at: number } | null = null;
  for (const offer of offers) {
    for (let at = 0; at < confirms.length; at++) {
      if (compare(Buffer.from(offer.confirm), Buffer.from(confirms[at]!)) && hit === null) hit = { offer, at };
    }
  }
  return hit;
}

/** The confirms, or null for a list that cannot be a real attempt at `n` offers. */
function readConfirms(body: Record<string, unknown>, n: number): Uint8Array[] | null {
  const { confirm, box } = body;
  if (!Array.isArray(confirm) || !Array.isArray(box) || confirm.length === 0 || confirm.length > n || box.length !== confirm.length) return null;
  const out: Uint8Array[] = [];
  for (const c of confirm) {
    const b = pakeDecode(c, PAKE_CONFIRM_BYTES);
    if (!b) return null;
    out.push(b);
  }
  return out;
}

/** The box's words, or null when it does not open or is not ours. */
async function openBox(offer: PakeHeld, raw: unknown): Promise<{ deviceName: unknown; presented: string | null } | null> {
  if (typeof raw !== "string" || raw.length > MAX_BOX_CHARS) return null;
  const v = await pakeOpenBox(offer.kBox, offer.th, raw);
  if (!v || typeof v !== "object") return null;
  const { deviceName, presented } = v as { deviceName?: unknown; presented?: unknown };
  return { deviceName, presented: typeof presented === "string" ? presented : null };
}

/** What a sealed reply carries beside `redeemPair`'s answer. */
export function sealedFacts(deps: Pick<PairDeps, "root" | "tls">): Pick<PakeSealedReply, "hostId" | "lanIdentity" | "tls" | "updateKey"> {
  const id = lanIdentity(deps.root);
  const tls = tlsOf(deps);
  const updateKey = updatePublicKey(deps.root);
  return {
    hostId: id.hostId,
    lanIdentity: { hostId: id.hostId, secret: id.secret },
    ...(tls ? { tls: { port: tls.port, spki: tls.spki } } : {}),
    ...(updateKey ? { updateKey } : {}),
  };
}

const tlsOf = (deps: Pick<PairDeps, "tls">): LanTlsFacts | null => (deps.tls ? deps.tls() : lanTlsFacts());

/**
 * What the deep link says for this desktop, and the fingerprint printed beside it. `s=1` and `k=` go
 * out only with a password set: PAKE refuses every attempt without one, so a link saying *PAKE or
 * nothing* would pair nobody, on the tailnet included.
 */
export async function pairLinkFacts(deps: Pick<PairDeps, "root" | "auth" | "tls">, net: PairNet): Promise<{ link: PairLinkFacts; fingerprint?: string }> {
  const lan = net.lanBase && net.lanBase !== net.base ? net.lanBase : undefined;
  const updateKey = updatePublicKey(deps.root);
  const fingerprint = updateKey ? await updateKeyFingerprint(updateKey) : null;
  const commit = updateKey && deps.auth.isEnabled() ? await pairCommit(updateKey, tlsOf(deps)?.spki) : null;
  return {
    link: { ...(deps.auth.isEnabled() ? { secure: true } : {}), ...(commit ? { commit } : {}), ...(lan ? { lan } : {}) },
    ...(fingerprint ? { fingerprint } : {}),
  };
}

export type PakeRedeem = (hash: Buffer, deviceName: unknown, presented: string | null) => Promise<{ status: number; body: PairRedeemReply }>;

/** `finish`: at most one code spent, and the session gone whatever the outcome. */
export async function pakeFinish(body: Record<string, unknown>, deps: PakeDeps, redeem: PakeRedeem): Promise<{ status: number; body: PakeFinishResponse }> {
  if (!pakeDecode(body.sidP, PAKE_SID_BYTES)) return { status: 400, body: refusal("bad-request") };
  const offers = deps.store.pake.take(body.sidP as string);
  if (!offers) return { status: 410, body: refusal("no-session") };
  const miss = (): { status: number; body: PakeRefusal } => {
    deps.store.pakeMiss(offers.map((o) => o.hash));
    const { live, open } = deps.store.pakeCodes();
    return { status: 403, body: refusal(live > 0 && open.length === 0 ? "closed" : "unknown") };
  };
  const confirms = readConfirms(body, offers.length);
  if (!confirms) return miss();
  const hit = matchConfirm(offers, confirms, deps.store.compareHash);
  if (!hit) return miss();
  const words = await openBox(hit.offer, (body.box as unknown[])[hit.at]);
  if (!words) return miss();
  // Before the spend: a desktop that cannot read its own identity must not eat the code.
  const facts = sealedFacts(deps);
  const r = await redeem(hit.offer.hash, words.deviceName, words.presented);
  if (!r.body.ok) return { status: r.status, body: refusal(r.body.error, r.body.message) };
  const sealed: PakeSealedReply = { ...r.body, ...facts };
  return { status: 200, body: { ok: true, seal: await pakeSeal(hit.offer.kSeal, hit.offer.th, sealed) } };
}
