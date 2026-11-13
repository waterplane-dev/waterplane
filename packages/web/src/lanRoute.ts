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
 *
 * **A desktop this shell holds a pin for is checked on its TLS address, never its plain one**
 * (`lanDialOf`): that is what stops a relay downgrading it by blocking the TLS port. A failed check
 * falls to the tailnet, or where there is no tailnet to fall to, says why (`RouteTrouble`). A
 * shipped APK has no `ShellTls`, so it stays on the plain LAN with the warning.
 */
import {
  LAN_PROBE_TIMEOUT_MS, cleanHostTls, decideLanRoute, isHostId, isPlainRoute, isProxyBase, lanMacMessage, needsTunnel,
  type HostTls, type LanFailure, type LanProbe, type LanRoute, type LanVerifyResponse, type NetState, type SavedHost,
} from "@waterplane/shared";
import { dialBaseOf, routeContext } from "./hostUrl.ts";
import type { TlsPin, TlsRefusal } from "./sdk/shellTls.ts";

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

/**
 * Whether the probe's HTTP status means the desktop ANSWERED. The probe carries
 * no token (the LAN is not the route yet), and a gated host refuses an
 * unauthenticated `/api/health` over the LAN with 401 — that IS this host
 * answering, and the HMAC verify after it proves which host. Any other non-2xx
 * (a 403 origin refusal, a 5xx, a captive portal) is not a usable answer.
 */
export function lanProbeAnswered(status: number): boolean {
  return (status >= 200 && status < 300) || status === 401;
}

export type TokenState = "ok" | "no-password" | "failed";

export interface LanRouterDeps {
  /** The active host, or null (browser, nothing paired). */
  host(): (Pick<SavedHost, "lan"> & Partial<Pick<SavedHost, "base">>) | null;
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
  /** The address to check for a saved LAN address (`lanDialOf`). Absent: that address as saved. */
  dial?(lanBase: string): LanDial | null;
  /** Did this shell refuse `lanBase`'s certificate at or after `since`? */
  refused?(lanBase: string, since: number): Promise<boolean>;
  /** A failed LAN leaves this phone no other way to the desktop (`fallbackGone`). */
  noFallback?(net: NetState | null): boolean;
}

/** Why a pinned desktop cannot be reached, where something must be said and pairing by code offered. */
export type RouteTrouble = "keyChanged" | "noAnswer";

export interface LanVerdict { route: LanRoute; sentence: string; lanBase: string | null; trouble?: RouteTrouble }

export const NO_PASSWORD_SENTENCE = "Using the tailnet: set a password on the host to use LAN — without one it cannot give this device a token.";
export const NO_TOKEN_SENTENCE = "Using the tailnet: the desktop did not give this device a device token.";
export const NO_IDENTITY_SENTENCE = "Using the tailnet: the desktop's LAN identity could not be read over the tailnet.";
export const NO_PROTECTED_LAN_SENTENCE = "Using the tailnet: this desktop has a key on this device, and its LAN address has no encrypted address to check.";

const TAILNET_SAID = "Using the tailnet: ";

/** The same reason where the tailnet is not there to use: Tailscale is known off and the row's own
 *  address needs it. A sentence that does not claim the tailnet stays as it is. */
export function tailscaleOffSentence(sentence: string): string {
  if (!sentence.startsWith(TAILNET_SAID)) return sentence;
  return `Tailscale is off on this device: turn it on to reach the desktop. Not on LAN: ${sentence.slice(TAILNET_SAID.length)}`;
}

/** The sentence Connection health answers with "set the LAN password", Tailscale on or off. */
export function asksLanPassword(sentence: string): boolean {
  return sentence === NO_PASSWORD_SENTENCE || sentence === tailscaleOffSentence(NO_PASSWORD_SENTENCE);
}

const addressOf = (base: string): string => base.replace(/^https?:\/\//, "");

/** The two sentences a pinned desktop's failure can need. `fallback`: the tailnet is still there. */
export function troubleSentence(trouble: RouteTrouble, base: string, fallback: boolean): string {
  const a = addressOf(base);
  if (trouble === "keyChanged") {
    return `${fallback ? "Using the tailnet: " : ""}${a} showed a different key. The desktop's key changed, or someone is in between${fallback ? "." : ": pair again by code."}`;
  }
  return `${fallback ? "Using the tailnet: " : ""}${a} did not answer. The desktop may be off, or its address may have changed${fallback ? "." : ": pair again by code."}`;
}

/** The route a row with no tailnet address is on, in place of "using the tailnet". */
export function lanOnlySentence(base: string): string {
  return `This device reaches the desktop at ${addressOf(base)}. No tailnet address is saved for it.`;
}

/** A row whose own address is a plain LAN one: what `tlsBaseOf` would rewrite. */
export function lanOnlyBase(base: string): boolean {
  return base.startsWith("http:") && isPlainRoute(base);
}

/** Is there no way to this desktop but its LAN address? A LAN-only row, or a tailnet address with
 *  Tailscale known to be off. An absent `tailnet` is unknown, and unknown is not off. */
export function fallbackGone(row: Pick<SavedHost, "base">, net: NetState | null): boolean {
  return lanOnlyBase(row.base) || (net?.tailnet === false && isPlainRoute(row.base, { tailnet: false }));
}

export interface LanDial { base: string; pinned: boolean }

/**
 * The address the ladder may check for `lanBase`. On a shell that enforces the pin this row holds,
 * that is the TLS address, or null where there is none: `tlsBaseOf` leaves an `https` address as it
 * is, and a pinned desktop is never reached on an unprotected one. Otherwise `lanBase` as saved.
 */
export function lanDialOf(row: Pick<SavedHost, "base" | "lan" | "tls" | "tlsOff" | "vouched">, lanBase: string, enforcing: boolean): LanDial | null {
  if (!enforcing || !row.tls || row.tlsOff) return { base: lanBase, pinned: false };
  const base = dialBaseOf(row, true, lanBase);
  return isPlainRoute(base, routeContext(base, row, true, null)) ? null : { base, pinned: base !== lanBase };
}

/** Is this refusal about `base`, and newer than `since`? `host` is the name alone, never a port. */
export function refusalFits(r: TlsRefusal | null, base: string, since = 0): boolean {
  if (!r?.at || r.at < since) return false;
  if (!r.host) return true;
  const bare = (s: string): string => s.replace(/^\[|\]$/g, "").toLowerCase();
  try { return bare(new URL(base).hostname) === bare(r.host); } catch { return false; }
}

export interface WelcomeFacts { hostId?: string; tlsPort?: number; tlsSpki?: string }

/**
 * What a `welcome` may write on the active row, or null for nothing. `protectedDial` is the URL the
 * delivering socket DIALLED, judged by `plainBaseNow`, never the route at message time: the ladder
 * moves that before the redial opens.
 *
 * Absent fields clear nothing: the desktop has none to give until a socket is bound, and
 * `WATERPLANE_HOST=0.0.0.0` never has. A row the person put on plain HTTP takes no pin. Nor does a
 * row whose own address is `https` to a name of its own (a vouched proxy): the pin would apply on
 * that address too (`ShellRoute.pinApplies`), and the background services would refuse a proxy
 * that is answering correctly with its CA-valid leaf.
 */
export function welcomePinPlan(
  row: Pick<SavedHost, "base" | "hostId" | "tls" | "tlsOff">, w: WelcomeFacts, protectedDial: boolean,
): { hostId?: string; tls?: HostTls } | null {
  if (!protectedDial) return null;
  const out: { hostId?: string; tls?: HostTls } = {};
  if (isHostId(w.hostId) && w.hostId !== row.hostId) out.hostId = w.hostId;
  const tls = cleanHostTls({ port: w.tlsPort, spki: w.tlsSpki });
  if (tls && !row.tlsOff && !isProxyBase(row.base) && (tls.port !== row.tls?.port || tls.spki !== row.tls?.spki)) out.tls = tls;
  return out.hostId || out.tls ? out : null;
}

/**
 * Bring the shell's pins in line with the rows, which are what was learned: a shipped APK keeps a
 * `tls` it cannot pin, so a new APK starts with rows and no pins. A pin is keyed by the ROW's id,
 * the id the link set and a pull hand the shell. Only what differs is touched: `setPin` drops the
 * recorded refusal, so a set of the same key would erase why this phone cannot get through.
 */
export function pinSyncPlan(rows: readonly Pick<SavedHost, "id" | "tls" | "tlsOff">[], held: readonly TlsPin[]): { set: TlsPin[]; remove: string[] } {
  const want = new Map(rows.flatMap((h) => (h.tls && !h.tlsOff ? [[h.id, h.tls.spki] as const] : [])));
  const have = new Map(held.map((p) => [p.hostId, p.spki]));
  return {
    set: [...want].filter(([id, spki]) => have.get(id) !== spki).map(([hostId, spki]) => ({ hostId, spki })),
    remove: [...have.keys()].filter((id) => !want.has(id)),
  };
}

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

  /** The network the last pass read: `noteFailure` has to speak without asking again. */
  let lastNet: NetState | null = null;

  const tail = (sentence: string): LanVerdict => {
    const base = deps.host()?.base;
    const off = lastNet?.tailnet === false && !!base && needsTunnel(base);
    return { route: "tailnet", sentence: off ? tailscaleOffSentence(sentence) : sentence, lanBase: null };
  };

  async function pass(): Promise<{ v: LanVerdict | null }> {
    const host = deps.host();
    if (!host) return { v: null };
    const net = await deps.net();
    lastNet = net;
    const lastFailure = failure;
    const d0 = decideLanRoute({ host, net, probe: null, macVerified: null, lastFailure });
    if (d0.next !== "probe" || !host.lan) return { v: tail(d0.sentence) };
    const dial = deps.dial ? deps.dial(host.lan.base) : { base: host.lan.base, pinned: false };
    if (!dial) return { v: tail(NO_PROTECTED_LAN_SENTENCE) };
    const lanBase = dial.base;
    // The decision's sentences name the address actually checked.
    const seen = { lan: { ...host.lan, base: lanBase } };
    const tok = await deps.ensureToken();
    if (tok === "no-password") return { v: tail(NO_PASSWORD_SENTENCE) };
    if (tok !== "ok") return { v: tail(NO_TOKEN_SENTENCE) };
    const id = await deps.ensureIdentity();
    if (!id) return { v: tail(NO_IDENTITY_SENTENCE) };
    const asked = deps.now();
    // A failed check of a pinned desktop: why, in place of the ladder's own sentence, where it knows.
    const refusedOr = async (sentence: string): Promise<LanVerdict> => {
      if (!dial.pinned) return tail(sentence);
      const fallback = !deps.noFallback?.(net);
      const key = (await deps.refused?.(lanBase, asked)) === true;
      if (!key && fallback) return tail(sentence);
      const trouble: RouteTrouble = key ? "keyChanged" : "noAnswer";
      return { ...tail(troubleSentence(trouble, lanBase, fallback)), trouble };
    };
    const probe = await deps.probe(lanBase, LAN_PROBE_TIMEOUT_MS);
    const d1 = decideLanRoute({ host: seen, net, probe, macVerified: null, lastFailure });
    if (d1.next !== "verify") return { v: await refusedOr(d1.sentence) };
    const nonce = deps.nonce ? deps.nonce() : newNonce();
    let ok = false;
    try { ok = await verifyLanAnswer(id, nonce, await deps.verify(lanBase, nonce), deps.subtle); } catch { ok = false; }
    const d2 = decideLanRoute({ host: seen, net, probe, macVerified: ok, lastFailure });
    if (d2.route !== "lan") return { v: await refusedOr(d2.sentence) };
    return { v: { route: d2.route, sentence: d2.sentence, lanBase } };
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
