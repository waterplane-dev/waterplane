/**
 * The LAN route, pure half: when may this phone talk to the active host over
 * its LAN address instead of the tailnet?
 *
 * The DECISION and its sentences are `shared/lanroute.ts`'s (`decideLanRoute`);
 * this is the sequence that gathers the evidence it asks for, in the order it
 * asks, and stops at the first "no":
 *
 *   saved LAN + auto on → on Wi-Fi with a saved SSID → a device token (minted
 *   over the tailnet; a host with no password cannot mint one, and that is
 *   SAID) → the LAN identity (read over the tailnet) → `/api/health` on the
 *   LAN address inside `LAN_PROBE_TIMEOUT_MS` → `/api/lan/verify` with a fresh
 *   nonce, its HMAC checked here with WebCrypto and its `hostId` matched.
 *
 * Only a full "yes" returns `lanBase`; everything else — including any throw —
 * is the tailnet. Nothing here touches the network or the socket itself: the
 * IO is handed in (`LanRouterDeps`), so the whole ladder is node-tested
 * (`lanRoute.test.mjs`). The runtime wiring is `lanLink.ts`.
 *
 * **Single flight.** One evaluation at a time; a trigger arriving mid-flight
 * marks it stale and runs ONE more pass after, and a stale pass never applies
 * a LAN verdict (the network it probed may be gone). Nothing here re-runs by
 * itself: every pass is caused by a trigger (start, network change, socket
 * reopen, a LAN failure).
 */
import {
  LAN_PROBE_TIMEOUT_MS, decideLanRoute, lanMacMessage,
  type LanFailure, type LanProbe, type LanRoute, type LanVerifyResponse, type NetState, type SavedHost,
} from "@waterplane/shared";

export interface LanIdentity { hostId: string; secret: string }

/** A stored/served identity, or null for anything that is not one. */
export function parseLanIdentity(v: unknown): LanIdentity | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return typeof o.hostId === "string" && o.hostId && typeof o.secret === "string" && o.secret.length >= 16
    ? { hostId: o.hostId, secret: o.secret }
    : null;
}

/** 32 random hex characters (16 bytes). */
export function newNonce(rand: (a: Uint8Array) => Uint8Array = (a) => globalThis.crypto.getRandomValues(a)): string {
  const b = rand(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** hex HMAC-SHA256(key = utf8(secret), msg = hostId + "\n" + nonce), or null
 *  where WebCrypto is missing (then the LAN is simply not used). */
export async function lanMacHex(secret: string, hostId: string, nonce: string, subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle): Promise<string | null> {
  if (!subtle) return null;
  try {
    const enc = new TextEncoder();
    const key = await subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await subtle.sign("HMAC", key, enc.encode(lanMacMessage(hostId, nonce)));
    return Array.from(new Uint8Array(sig), (x) => x.toString(16).padStart(2, "0")).join("");
  } catch { return null; }
}

/** Compare every character, whatever the first mismatch. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Did whatever answered at the LAN address prove it is THIS desktop? */
export async function verifyLanAnswer(id: LanIdentity, nonce: string, answer: LanVerifyResponse | null, subtle?: SubtleCrypto): Promise<boolean> {
  if (!answer || answer.hostId !== id.hostId || typeof answer.mac !== "string") return false;
  const want = await lanMacHex(id.secret, id.hostId, nonce, subtle ?? globalThis.crypto?.subtle);
  return !!want && sameHex(want, answer.mac.toLowerCase());
}

export type TokenState = "ok" | "no-password" | "failed";

export interface LanRouterDeps {
  /** The active host, or null (browser, nothing paired). */
  host(): Pick<SavedHost, "lan"> | null;
  net(): Promise<NetState | null>;
  /** Make sure a device token is held (mint over the tailnet when not). */
  ensureToken(): Promise<TokenState>;
  /** The stored LAN identity, fetched over the tailnet when missing. */
  ensureIdentity(): Promise<LanIdentity | null>;
  probe(lanBase: string, timeoutMs: number): Promise<LanProbe>;
  verify(lanBase: string, nonce: string): Promise<LanVerifyResponse | null>;
  /** Put the verdict in force: `lanBase` only for a verified LAN. */
  apply(v: LanVerdict): void;
  now(): number;
  nonce?(): string;
  subtle?: SubtleCrypto;
}

export interface LanVerdict { route: LanRoute; sentence: string; lanBase: string | null }

export const NO_PASSWORD_SENTENCE = "Using the tailnet: set a password on the host to use LAN — without one it cannot give this phone a token.";
export const NO_TOKEN_SENTENCE = "Using the tailnet: the desktop did not give this phone a device token.";
export const NO_IDENTITY_SENTENCE = "Using the tailnet: the desktop's LAN identity could not be read over the tailnet.";

/**
 * The LAN settings of the host in use were just saved while `routeBase` is
 * the route in force (null = already on the tailnet): the sentence to drop to
 * the tailnet with NOW, or null when the LAN in use is still allowed (the
 * ladder then re-runs and decides). Never waits for a probe — falling back is
 * always safe, and a LAN the person just switched off must stop being used.
 */
export function lanDropOnSave(routeBase: string | null, lan: { base: string; auto: boolean } | null | undefined): string | null {
  if (routeBase === null) return null;
  if (!lan?.auto) return "Using the tailnet: switching to the LAN automatically is off.";
  if (lan.base !== routeBase) return "Using the tailnet: the LAN address changed; checking it again.";
  return null;
}

export interface LanRouter {
  /** Run (or join) an evaluation; resolves with the verdict applied last. */
  evaluate(trigger: string): Promise<LanVerdict | null>;
  /** The LAN just failed in use: tailnet NOW, retried on the next trigger. */
  noteFailure(reason: string): LanVerdict | null;
  lastFailure(): LanFailure | null;
}

export function createLanRouter(deps: LanRouterDeps): LanRouter {
  let failure: LanFailure | null = null;
  let running: Promise<LanVerdict | null> | null = null;
  let stale = false;

  const tail = (sentence: string): LanVerdict => ({ route: "tailnet", sentence, lanBase: null });

  async function pass(): Promise<{ v: LanVerdict | null }> {
    const host = deps.host();
    if (!host) return { v: null };
    const net = await deps.net();
    const lastFailure = failure;
    const d0 = decideLanRoute({ host, net, probe: null, macVerified: null, lastFailure });
    if (d0.next !== "probe" || !host.lan) return { v: tail(d0.sentence) };
    const lanBase = host.lan.base;
    const tok = await deps.ensureToken();
    if (tok === "no-password") return { v: tail(NO_PASSWORD_SENTENCE) };
    if (tok !== "ok") return { v: tail(NO_TOKEN_SENTENCE) };
    const id = await deps.ensureIdentity();
    if (!id) return { v: tail(NO_IDENTITY_SENTENCE) };
    const probe = await deps.probe(lanBase, LAN_PROBE_TIMEOUT_MS);
    const d1 = decideLanRoute({ host, net, probe, macVerified: null, lastFailure });
    if (d1.next !== "verify") return { v: tail(d1.sentence) };
    const nonce = deps.nonce ? deps.nonce() : newNonce();
    let ok = false;
    try { ok = await verifyLanAnswer(id, nonce, await deps.verify(lanBase, nonce), deps.subtle); } catch { ok = false; }
    const d2 = decideLanRoute({ host, net, probe, macVerified: ok, lastFailure });
    return { v: { route: d2.route, sentence: d2.sentence, lanBase: d2.route === "lan" ? lanBase : null } };
  }

  async function loop(): Promise<LanVerdict | null> {
    let last: LanVerdict | null = null;
    for (;;) {
      stale = false;
      let v: LanVerdict | null;
      try { v = (await pass()).v; } catch { v = tail("Using the tailnet: checking the LAN failed."); }
      // A trigger landed mid-pass: never switch TO the LAN on evidence that
      // may describe a network the phone has left. Falling back is always safe.
      if (stale) {
        if (v && v.route === "tailnet") { deps.apply(v); last = v; }
        continue;
      }
      if (v) { deps.apply(v); last = v; }
      return last;
    }
  }

  return {
    evaluate(_trigger: string) {
      if (running) { stale = true; return running; }
      running = loop().finally(() => { running = null; });
      return running;
    },
    noteFailure(reason: string) {
      failure = { at: deps.now(), reason };
      if (running) stale = true;
      // `decideLanRoute`'s own "failed-recently" wording, without re-asking
      // the network: the failure is the fact that decides.
      const v = tail(`Using the tailnet: the LAN connection failed (${reason}); it is tried again on the next network change or reconnect.`);
      deps.apply(v);
      return v;
    },
    lastFailure: () => failure,
  };
}
