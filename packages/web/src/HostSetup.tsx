import { useEffect, useState, type ReactNode } from "react";
import { nativePlugin } from "./shellBridge";
import { BRAND, envName, PLAIN_ROUTE_WARNING, PROTOCOL_VERSION, addressNeedsConfirm, normalizeHostBase, normalizeHostName, normalizeSsid, defaultHostName, vouchedAfter, type PairTarget, type SavedHost } from "@waterplane/shared";
import { CheckCircle2, ExternalLink, FlaskConical, Globe, KeyRound, Loader2, Plug, Plus, Router, Settings2, ShieldCheck, Smartphone, Wifi, X, XCircle } from "lucide-react";
import { SetNote, SetSwitch, SetLine, SetWarn } from "./SettingsKit";
import { PairForm, type PairNoRoute } from "./PairForm";
import { FoundDesktops } from "./FoundDesktops";
import { passwordSentence } from "./hostDiscover";
import { lanSettingsSaved } from "./lanLink";
import { askConfirm } from "./Confirm";
import { LOCATION_DISCLOSURE, LOCATION_SKIPPED_TEXT } from "./shellNet";
import { tryDemo } from "./demoEntry";
import { openExternal } from "./openExternal";
import { showToast } from "./toast";
import { activeHostId, addAndActivate, addHost, browserKV, updateHost, type HostInput } from "./hosts";
import { hostBase, isNativeShell, savedRowPlain } from "./hostUrl";
import { hasShellTls } from "./sdk/shellTls";
import { Button } from "./kit/Button";
import { plainSaveRefusal } from "./hostEditGuard";
import { sealedMode } from "./deviceToken";
import { pickLockPath } from "./appLock";
import { LS, lsBool } from "./storage";
import { isDemo } from "./demoEntry";
import { Explain } from "./Explain";
import { testLanAddress } from "./lanLink";
import { lanHttpsFix, lanTestWords, lanTlsLine, routeCardTag, routeNowWords, staleLanOffer, tailnetOkWords, type LanTest } from "./hostTestWords";
import { useHostRoute } from "./hostRoute";
import { fmtSince, useLink } from "./link";
import { Tag } from "./kit/Tag";

/**
 * Add or edit one desktop — Android shell only.
 *
 * In the browser the app is served BY the daemon, so "which host?" is answered
 * by the address bar and this component never renders. The APK has no address
 * bar: its UI comes out of the APK (that is the whole point — a dead tunnel can
 * no longer replace the app with a browser error page), so every desktop's
 * address is asked for once and remembered (`hosts.ts`).
 *
 * Three uses, one form: the FIRST host (full screen, in front of `App`, adds
 * and makes it active), ADD from the host switcher (adds; "add and switch"
 * also makes it active), and EDIT (name, addresses, the LAN side).
 *
 * FIRST and ADD also offer "pair with code" (`PairForm.tsx`) — on the first
 * run it is the PRIMARY option, because a code from a phone already paired
 * brings the device token in the same step. A `<scheme>://pair` link opens it
 * prefilled (`pair` + `pairFromLink`).
 *
 * The probe before saving is not decoration. Everything downstream of a wrong
 * address degrades into the app's *normal* offline behaviour — a reconnect
 * banner, a queue that fills up, sends that never ack — which is exactly the
 * state the user is trying to escape when they open this screen. Distinguishing
 * "your desktop is asleep" from "you typed the wrong IP" costs one GET, and the
 * three failures below are told apart because their fixes are different.
 */
type Probe =
  | { s: "idle" }
  | { s: "busy" }
  | { s: "ok"; root: string; protocol: number; ms: number }
  | { s: "bad"; why: string; hint?: string };

const PROBE_TIMEOUT_MS = 6000;

/** Where a fresh install sends someone who has no desktop half yet. */
const DESKTOP_GUIDE = `https://${BRAND.domain}/#install`;

/** The ask over an EMPTY field: the saved address stays out of it, because the only thing that
 *  makes it protected is that the person typed it (`vouchedAfter`), not that they read it here. */
const CONFIRM_ADDRESS_TEXT =
  "Type this desktop's address to confirm it. It is an https address that counts as protected only once you have typed it yourself, so the saved one is not shown: an older version of this app may have saved an address you never chose.";

/** A plain-http address, said once in a line under the field it is about; the full sentence behind the `?`. */
function PlainWarn() {
  return (
    <SetWarn>
      Not protected: anyone on this network could read and take over.{" "}
      <Explain of="why this address is not protected" label="why"><p>{PLAIN_ROUTE_WARNING}</p></Explain>
    </SetWarn>
  );
}

export type HostSetupMode = "first" | "add" | "edit";

/** The top of the Edit screen: which of the two addresses this phone is on NOW, whether it answers, and why
 *  that one. The two cards below carry the same answer as a tag, so the form and the panel never disagree. */
function RouteNow({ active, saved }: { active: boolean; saved: string | null }) {
  const route = useHostRoute();
  const status = useLink((s) => s.status, true);
  const lastSeen = useLink((s) => s.sync.lastSeenAt, true);
  const w = routeNowWords({
    active, route, status,
    lastSeenAgo: status === "open" || !lastSeen ? null : fmtSince(lastSeen),
    dial: active ? hostBase() : null,
    saved,
  });
  const Icon = w.via === "lan" ? Router : w.via === "tailnet" ? Globe : Plug;
  return (
    <section className={`route-now${w.tone ? ` ${w.tone}` : ""}`} aria-live="polite">
      <div className="route-now-head"><Icon size={18} /> {w.head}</div>
      <div className="route-now-state">{w.state}</div>
      {w.dial && <div className="route-now-dial"><code>{w.dial}</code></div>}
      {w.why && <SetNote className="route-now-why">{w.why}</SetNote>}
    </section>
  );
}

/** One address's card head: its name and whether it is the one in use. */
function CardHead({ icon: Icon, title, tag, live }: { icon: typeof Globe; title: string; tag: { text: string; inUse: boolean } | null; live?: boolean }) {
  return (
    <div className="route-card-head">
      <Icon size={15} /> <b>{title}</b>
      {tag && <Tag tone={tag.inUse && live ? "ok" : undefined} className={`route-card-tag${tag.inUse ? " in-use" : ""}`}>{tag.text}</Tag>}
    </div>
  );
}

interface NetState { transport?: string; ssid?: string | null; permission?: string }
interface ShellNetPlugin { current?: () => Promise<NetState>; requestLocation?: () => Promise<NetState> }

/** The shell's network plugin, when this APK has it (`packages/app`'s ShellNet). */
function shellNet(): ShellNetPlugin | null {
  const p = nativePlugin<ShellNetPlugin>("Net");
  return p?.current ? p : null;
}

/** Why the Wi-Fi name could not be read — a sentence, never a dimmed chip. */
function ssidWhy(st: NetState | null): string {
  if (!st) return "This phone did not answer which network it is on.";
  if (st.transport !== "wifi") return "This phone is not on Wi-Fi right now.";
  if (st.permission !== "granted") return "Android tells an app the Wi-Fi name only with the location permission.";
  return "Android did not say the Wi-Fi name — location may be switched off.";
}

export function HostSetup({ mode, host, lanSuggest = [], pair, pairFromLink, onDone, onCancel, onEditLan, linkDoors }: {
  mode: HostSetupMode;
  /** Open on "pair with code", prefilled (a deep link, or a typed code). */
  pair?: PairTarget | null;
  /** `pair` came from a link any app could have fired — the form says so. */
  pairFromLink?: boolean;
  /** The host being edited (`edit`). */
  host?: SavedHost;
  /** LAN addresses the host itself reported (`welcome.lanIps`) — offered as chips. */
  lanSuggest?: readonly string[];
  /** After a save that does not reload (add, edit of a host that is not active). */
  onDone: (saved: SavedHost | null) => void;
  onCancel?: () => void;
  /** Open a row's LAN settings: the control on a pairing that left no route. */
  onEditLan?: (saved: SavedHost) => void;
  /** Edit of the ACTIVE desktop: doors to the link's health and its tests, under "in use" (the
   *  caller's; this form also renders before `App`, where there is no sheet to open). */
  linkDoors?: ReactNode;
}) {
  const [noRoute, setNoRoute] = useState<PairNoRoute | null>(null);
  const [name, setName] = useState(host?.name ?? "");
  const [confirming, setConfirming] = useState(mode === "edit" && !!host && addressNeedsConfirm(host));
  const [text, setText] = useState(confirming ? "" : host?.base ?? "");
  const [lanText, setLanText] = useState(host?.lan?.base ?? "");
  const [ssids, setSsids] = useState<string[]>(host?.lan?.ssids ?? []);
  const [auto, setAuto] = useState(host?.lan?.auto ?? false);
  const [probe, setProbe] = useState<Probe>({ s: "idle" });
  const [lanTest, setLanTest] = useState<LanTest | "busy" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [ssidNote, setSsidNote] = useState<string | null>(null);
  // Unsaved edits: a door to another sheet unmounts this form, and what was typed would go with it.
  const formNow = JSON.stringify([name, text, lanText, ssids, auto]);
  const [formAtOpen] = useState(formNow);
  const [needLocation, setNeedLocation] = useState(false);
  const [pairing, setPairing] = useState(mode !== "edit" && (mode === "first" || !!pair));
  // A desktop found on the tailnet that has a password: the pair form, on its address.
  const [found, setFound] = useState<{ target: PairTarget; note: string } | null>(null);
  const base = normalizeHostBase(text);
  const lanBase = lanText.trim() ? normalizeHostBase(lanText) : null;
  const net = shellNet();
  // What the base field opened with: `vouched` needs the text to differ from it.
  const opened = confirming ? "" : host?.base ?? "";
  // The row this form would save, so the warning says what the saved row will read as.
  const draft = {
    base: base ?? "", tls: host?.tls, tlsOff: host?.tlsOff,
    lan: lanBase ? { base: lanBase, ssids, auto } : undefined,
    vouched: base && vouchedAfter(host ?? null, base, opened) ? (true as const) : undefined,
  };
  const plainTail = !!base && savedRowPlain(draft, hasShellTls());
  const plainLan = !!lanBase && savedRowPlain(draft, hasShellTls(), lanBase);
  // Only the desktop in use has a route; every other row is not dialled at all.
  const kvNow = browserKV();
  const isActive = mode === "edit" && !!host && !!kvNow && activeHostId(kvNow) === host.id;
  const routeNow = useHostRoute();
  // Green only while the address in use actually answers; "in use" alone is the accent.
  const live = useLink((s) => s.status === "open");
  const tagFacts = { active: isActive, route: isActive ? routeNow?.route ?? null : null, hasLan: !!lanBase, auto, ssids: ssids.length };
  const tailTag = mode === "edit" ? routeCardTag("tailnet", tagFacts) : null;
  const lanTag = routeCardTag("lan", tagFacts);

  useEffect(() => { if (pair && mode !== "edit") setPairing(true); }, [pair, mode]);

  // Typing invalidates a previous verdict — a green tick next to an edited
  // address is worse than no tick.
  useEffect(() => { setProbe({ s: "idle" }); setProblem(null); }, [text]);
  useEffect(() => { setLanTest(null); }, [lanText]);

  async function testLan(): Promise<void> {
    if (!lanBase) return;
    setLanTest("busy");
    setLanTest(await testLanAddress(lanBase, host?.id ?? ""));
  }

  async function test(): Promise<boolean> {
    if (!base) return false;
    setProbe({ s: "busy" });
    const t0 = performance.now();
    const ctl = new AbortController();
    const fuse = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
    try {
      // Absolute URL on purpose: it must not be rewritten by a transport patch
      // already installed for a DIFFERENT (the active) host.
      // This is the probe that DECIDES the host, so it cannot use a helper that
      // resolves against the host already paired: an absolute URL is the whole
      // point, and it carries its own abort rather than the shared fuse.
      // eslint-disable-next-line no-restricted-globals -- pairing probe
      const r = await fetch(`${base}/api/health`, { cache: "no-store", signal: ctl.signal });
      if (!r.ok) {
        setProbe({
          s: "bad",
          why: `host answered ${r.status}`,
          hint: r.status === 403
            ? `The daemon refused this app's origin. Add http://localhost to ${envName("ALLOWED_ORIGINS")} on the desktop.`
            : `Something is listening there, but it is not the ${BRAND.name} daemon.`,
        });
        return false;
      }
      const d = (await r.json()) as { ok?: boolean; protocol?: number; root?: string };
      if (!d?.ok) {
        setProbe({ s: "bad", why: `not a ${BRAND.name} daemon`, hint: "Something else is listening on that port." });
        return false;
      }
      setProbe({ s: "ok", root: d.root || "?", protocol: d.protocol ?? 0, ms: performance.now() - t0 });
      return true;
    } catch (e) {
      const aborted = (e as Error)?.name === "AbortError";
      setProbe({
        s: "bad",
        why: aborted ? "no answer within 6s" : "could not reach that address",
        hint: aborted
          ? "The desktop may be asleep, or Tailscale is not up on this device."
          : "Check the address, and that Tailscale is connected on both ends.",
      });
      return false;
    } finally {
      clearTimeout(fuse);
    }
  }

  function input(): HostInput {
    return {
      name: normalizeHostName(name) ?? undefined,
      base: text,
      lan: lanBase ? { base: lanBase, ssids, auto } : null,
      opened,
    };
  }

  /** Save. `activate`: make it the active host (reloads). */
  function save(activate: boolean): void {
    const kv = browserKV();
    if (!kv) { setProblem("This device's storage is not available."); return; }
    const trap = plainSaveRefusal(normalizeHostBase(text) ?? text, sealedMode(), lsBool(LS.appLock), isDemo() ? null : pickLockPath(nativePlugin("Keystore")));
    if (trap) { setProblem(trap); return; }
    if (mode === "edit" && host) {
      const r = updateHost(kv, host.id, input());
      if (!r.ok) { setProblem(r.why); return; }
      // The active host's address moved: the socket, the transport patch and
      // every in-flight request were built against the old one. The reload is
      // free here — the shell is in the APK, not on the network.
      if (activeHostId(kv) === host.id && r.host.base !== host.base) { location.reload(); return; }
      // The LAN side of the host in use changed: re-decide the route now (and
      // off the LAN at once if it is no longer allowed), not at the next
      // network change.
      if (activeHostId(kv) === host.id) lanSettingsSaved();
      onDone(r.host);
      return;
    }
    if (activate) {
      const r = addAndActivate(input());
      if (!r.ok) setProblem(r.why);
      return;
    }
    const r = addHost(kv, input());
    if (!r.ok) { setProblem(r.why); return; }
    onDone(r.host);
  }

  async function addCurrentWifi(ask = false): Promise<void> {
    if (!net) return;
    if (ask && net.requestLocation) {
      // The prominent disclosure, BEFORE Android's own prompt: what is read,
      // why, that it stays on the phone, and what skipping costs. Skip asks
      // Android nothing and says what that leaves (shellNet.ts).
      const go = await askConfirm({
        title: LOCATION_DISCLOSURE.title,
        lines: [...LOCATION_DISCLOSURE.lines],
        confirmLabel: LOCATION_DISCLOSURE.continueLabel,
        cancelLabel: LOCATION_DISCLOSURE.skipLabel,
        tone: "info",
      });
      if (!go) { setSsidNote(LOCATION_SKIPPED_TEXT); return; }
    }
    let st: NetState | null = null;
    try { st = ask && net.requestLocation ? await net.requestLocation() : await net.current!(); } catch { st = null; }
    const ssid = normalizeSsid(st?.ssid);
    if (!ssid) {
      setSsidNote(ssidWhy(st));
      setNeedLocation(!!st && st.transport === "wifi" && st.permission !== "granted" && !!net.requestLocation);
      return;
    }
    setNeedLocation(false);
    setSsidNote(ssids.includes(ssid) ? `"${ssid}" is already on the list.` : null);
    if (!ssids.includes(ssid)) setSsids([...ssids, ssid]);
  }

  const title = mode === "edit" ? `Edit ${host?.name ?? "host"}` : mode === "add" ? "Add a desktop" : "Connect to your desktop";
  const namePlaceholder = base ? defaultHostName(base) : "desk";
  const fromPairLink = !!(pairFromLink && pair);

  if (noRoute) {
    return (
      <div className={mode === "first" ? "auth-gate" : undefined}>
        <div className={mode === "first" ? "auth-card" : "form host-form"}>
          <SetWarn>{noRoute.sentence}</SetWarn>
          <SetLine style={{ marginTop: 10 }}>
            {onEditLan && <Button onClick={() => onEditLan(noRoute.host)}><Settings2 size={13} /> change LAN settings</Button>}
            <Button onClick={noRoute.go}>done</Button>
          </SetLine>
        </div>
      </div>
    );
  }

  return (
    <div className={mode === "first" ? "auth-gate" : undefined}>
      <div className={mode === "first" ? "auth-card" : "form host-form"}>
        {mode === "first" && !fromPairLink && (
          // The first thing a fresh install shows: what this app is, and that it does nothing until
          // the desktop half exists. A pairing link skips it, because that person has a desktop.
          <>
            <div className="auth-title pair-title"><span className="pair-title-icon"><Smartphone size={18} /></span> Welcome to {BRAND.name}</div>
            <div className="pair-welcome">
              <SetNote>A remote control for Claude Code on your own computer. The coding happens on the desktop; this app lets you steer it from anywhere.</SetNote>
              <SetNote><b>Set up the desktop first.</b> Install {BRAND.name} there (macOS, Linux, or Windows with WSL2), then come back and connect this device.</SetNote>
              <Button title={`opens ${DESKTOP_GUIDE} in your browser`} onClick={() => { if (!openExternal(DESKTOP_GUIDE)) showToast("could not open the link"); }}><ExternalLink size={13} /> desktop setup guide</Button>
            </div>
          </>
        )}
        {mode === "first" && <div className={fromPairLink ? "auth-title pair-title" : "pair-subtitle"}>{fromPairLink && <span className="pair-title-icon"><Plug size={18} /></span>} {title}</div>}
        {mode === "add" && !pair && (
          <FoundDesktops onPassword={(b, n) => { setFound({ target: { base: b, code: "" }, note: passwordSentence(n) }); setPairing(true); }} />
        )}
        {found && pairing && (
          <SetNote className="warn" style={{ marginBottom: 10 }}>{found.note}</SetNote>
        )}
        {mode !== "edit" && !fromPairLink && (
          <div className="pair-modes" role="tablist">
            <button role="tab" aria-selected={pairing} className={`seg${pairing ? " on" : ""}`} onClick={() => setPairing(true)}><KeyRound size={14} /> pair with code</button>
            <button role="tab" aria-selected={!pairing} className={`seg${pairing ? "" : " on"}`} onClick={() => setPairing(false)}><Plug size={14} /> type the address</button>
          </div>
        )}
        {pairing && mode !== "edit" ? (
          <>
            <PairForm
              key={pair ? `${pair.base} ${pair.code}` : found ? `found ${found.target.base}` : "typed"}
              mode={mode === "first" ? "first" : "add"}
              initial={pair ?? found?.target}
              fromLink={pairFromLink}
              onDone={(h) => onDone(h)}
              onNoRoute={setNoRoute}
            />
            {onCancel && (
              <SetLine style={{ marginTop: 10 }}>
                <Button onClick={onCancel}>cancel</Button>
              </SetLine>
            )}
          </>
        ) : (<>
        {confirming && (
          <>
            <SetWarn>{CONFIRM_ADDRESS_TEXT}</SetWarn>
            <SetLine style={{ marginBottom: 12 }}>
              <Button onClick={() => { setConfirming(false); setText(host?.base ?? ""); }}>keep it unconfirmed</Button>
            </SetLine>
          </>
        )}
        {mode === "edit" && <RouteNow active={isActive} saved={host?.base ?? null} />}
        {mode === "edit" && linkDoors && (formNow === formAtOpen ? linkDoors
          : <SetNote style={{ margin: "10px 0" }}>Save or cancel first to open connection health or the tests — leaving this screen would drop what you changed.</SetNote>)}
        {mode !== "first" && (
          <input
            className="auth-input"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="name"
            placeholder={`name — ${namePlaceholder}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}

        <section className={`route-card${tailTag?.inUse ? " in-use" : ""}`}>
        {mode === "edit" && <CardHead icon={Globe} title="Tailnet address" tag={tailTag} live={live} />}
        <SetNote style={{ marginTop: mode === "edit" ? 4 : 0 }}>
          {mode !== "edit" && <><b>Tailnet address</b> — </>}the one the {BRAND.name} daemon prints at boot. Port <code>8770</code> unless you type another.
        </SetNote>
        <input
          className="auth-input"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="100.64.0.5   ·   mac.tailnet.ts.net"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && base && mode === "first") void test().then((ok) => { if (ok) save(true); }); }}
        />
        {text.trim() && !base && (
          <SetNote style={{ marginTop: 6, color: "var(--dead)" }}>
            Not an address. Use a host name or IP, optionally with a port — http or https only.
          </SetNote>
        )}
        {base && (
          <SetLine style={{ marginTop: 6, gap: 8, flexWrap: "wrap" }}>
            {probe.s === "busy"
              ? <SetNote as="span"><Loader2 size={13} className="spin" style={{ verticalAlign: "-2px" }} /> testing <code>{base}</code>…</SetNote>
              : <Button onClick={() => void test()}><Plug size={13} /> test this address</Button>}
          </SetLine>
        )}
        {probe.s === "ok" && (
          <SetNote style={{ marginTop: 6, color: "var(--ok)" }}>
            <CheckCircle2 size={13} style={{ verticalAlign: "-2px" }} /> {tailnetOkWords(probe.ms, probe.root)}
            {probe.protocol !== PROTOCOL_VERSION && ` It speaks protocol ${probe.protocol}, this app ${PROTOCOL_VERSION}.`}
          </SetNote>
        )}
        {probe.s === "bad" && (
          <SetNote style={{ marginTop: 6, color: "var(--dead)" }}>
            <XCircle size={13} style={{ verticalAlign: "-2px" }} /> {probe.why}
            {probe.hint && <div style={{ opacity: 0.8, marginTop: 4 }}>{probe.hint}</div>}
          </SetNote>
        )}
        {plainTail && <PlainWarn />}
        </section>

        {mode === "first" && (
          <input
            className="auth-input"
            style={{ marginTop: 10 }}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="name"
            placeholder={`name — ${namePlaceholder}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}

        {mode !== "first" && (
          <details className={`route-card${lanTag?.inUse ? " in-use" : ""}`} open={!!host?.lan}>
            {/* raw: the <summary> of a hand-rolled <details>, not SetNote's fold (a div) */}
            <summary><CardHead icon={Router} title={lanBase ? "Home Wi-Fi address" : "Home Wi-Fi address (optional)"} tag={lanTag} live={live} /></summary>
            <SetNote style={{ marginTop: 4 }}>
              Faster at home. Used only on the Wi-Fi networks listed below, with the switch on, after the desktop proves who it is.
            </SetNote>
            <input
              className="auth-input"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="192.168.1.20"
              value={lanText}
              onChange={(e) => setLanText(e.target.value)}
            />
            {lanText.trim() && !lanBase && (
              <SetNote style={{ marginTop: 6, color: "var(--dead)" }}>Not an address.</SetNote>
            )}
            {(() => {
              const ip = lanHttpsFix(lanBase);
              return ip ? (
                <SetLine style={{ marginTop: 6, gap: 8, flexWrap: "wrap" }}>
                  <SetNote as="span">Type the address without <code>https://</code>: the app encrypts it by itself, on the desktop's own TLS port.</SetNote>
                  <Button onClick={() => setLanText(ip)}>use {ip}</Button>
                </SetLine>
              ) : null;
            })()}
            {lanBase && (
              <SetLine style={{ marginTop: 6, gap: 8, flexWrap: "wrap" }}>
                {lanTest === "busy"
                  ? <SetNote as="span"><Loader2 size={13} className="spin" style={{ verticalAlign: "-2px" }} /> testing <code>{lanBase}</code>…</SetNote>
                  : <Button onClick={() => void testLan()}><Router size={13} /> test this address</Button>}
              </SetLine>
            )}
            {lanTest && lanTest !== "busy" && (() => { const w = lanTestWords(lanTest); return <SetNote style={{ marginTop: 6, color: w.tone === "ok" ? "var(--ok)" : w.tone === "dead" ? "var(--dead)" : undefined }}>{w.text}</SetNote>; })()}
            {(() => {
              const now = staleLanOffer(lanBase, lanTest === "busy" ? null : lanTest, lanSuggest);
              return now ? (
                <SetLine style={{ marginTop: 6, gap: 8, flexWrap: "wrap" }}>
                  <SetNote as="span">The desktop reports <code>{now}</code> now.</SetNote>
                  <Button onClick={() => setLanText(now)}>use {now}</Button>
                </SetLine>
              ) : null;
            })()}
            {lanSuggest.length > 0 && !lanText.trim() && (
              <div className="set-chips" style={{ marginTop: 6 }}>
                {lanSuggest.map((ip) => (
                  <Button key={ip} onClick={() => setLanText(ip)}>{ip}</Button>
                ))}
              </div>
            )}
            {plainLan && <PlainWarn />}
            {(() => {
              const l = lanTlsLine({ lanBase, shell: isNativeShell(), enforcing: hasShellTls(), tls: host?.tls, tlsOff: host?.tlsOff });
              return l ? <SetNote style={{ marginTop: 6, color: l.tone === "ok" ? "var(--ok)" : undefined }}>{l.tone === "ok" && <ShieldCheck size={13} style={{ verticalAlign: "-2px" }} />} {l.text}</SetNote> : null;
            })()}
            <SetNote style={{ marginTop: 10 }}><b>Only on these Wi-Fi networks</b>{ssids.length === 0 && ": none yet."}</SetNote>
            <div className="set-chips" style={{ marginTop: 4 }}>
              {ssids.map((s) => (
                <Button key={s} onClick={() => setSsids(ssids.filter((x) => x !== s))} aria-label={`remove ${s}`}>
                  <Wifi size={12} /> {s} <X size={12} />
                </Button>
              ))}
              {net && <Button onClick={() => void addCurrentWifi()}><Plus size={12} /> add current Wi-Fi</Button>}
            </div>
            {!net && (
              <SetNote>This app build cannot read the Wi-Fi name; a newer APK can.</SetNote>
            )}
            {ssidNote && <SetNote>{ssidNote}</SetNote>}
            {needLocation && (
              <Button onClick={() => void addCurrentWifi(true)}>allow location</Button>
            )}
            {lanBase && (
              <SetSwitch label="switch to LAN automatically" icon={Router} on={auto} onChange={() => setAuto(!auto)}
                note={ssids.length === 0 ? "Never switches until you add your home Wi-Fi." : undefined} />
            )}
          </details>
        )}

        {problem && <SetNote style={{ marginTop: 10, color: "var(--dead)" }}>{problem}</SetNote>}

        <SetLine style={{ marginTop: 14, flexWrap: "wrap", gap: 8 }}>
          {base ? (
            <>
              {/* Offered even on a failed probe: a desktop that is merely asleep
                  is the common case, and refusing to save the (correct) address
                  would strand someone on this screen with nothing to do. */}
              {mode === "first" && <Button variant="primary" onClick={() => save(true)}>connect</Button>}
              {mode === "add" && <Button variant="primary" onClick={() => save(true)}>add and switch</Button>}
              {mode === "add" && <Button onClick={() => save(false)}>add</Button>}
              {mode === "edit" && <Button variant="primary" onClick={() => save(false)}>save</Button>}
            </>
          ) : (
            <SetNote as="span">Type the desktop's address to test or save it.</SetNote>
          )}
          {onCancel && <Button onClick={onCancel}>cancel</Button>}
        </SetLine>
        </>)}

        {mode === "first" && (
          // Beside host setup, not instead of it: someone with no desktop to
          // hand (a store reviewer, a first look) can still see what this is.
          <div className="pair-demo">
            <SetNote>No desktop to hand? A pretend one inside this app — nothing connects and nothing runs.</SetNote>
            <Button onClick={() => tryDemo()}><FlaskConical size={13} /> Try the demo</Button>
          </div>
        )}

        {mode === "first" && (
          <SetNote style={{ marginTop: 14, opacity: 0.65 }}>
            Once connected, your queue, drafts and cached transcripts stay usable here
            even when the desktop is unreachable.
          </SetNote>
        )}
      </div>
    </div>
  );
}
