import { useEffect, useState } from "react";
import { nativePlugin } from "./shellBridge";
import { BRAND, envName, PROTOCOL_VERSION, normalizeHostBase, normalizeHostName, normalizeSsid, defaultHostName, type PairTarget, type SavedHost } from "@waterplane/shared";
import { CheckCircle2, FlaskConical, KeyRound, Loader2, Plug, Plus, Router, Wifi, X, XCircle } from "lucide-react";
import { SetNote, SetSwitch } from "./SettingsKit";
import { PairForm } from "./PairForm";
import { FoundDesktops } from "./FoundDesktops";
import { passwordSentence } from "./hostDiscover";
import { lanSettingsSaved } from "./lanLink";
import { askConfirm } from "./Confirm";
import { LOCATION_DISCLOSURE, LOCATION_SKIPPED_TEXT } from "./shellNet";
import { tryDemo } from "./demoEntry";
import { activeHostId, addAndActivate, addHost, browserKV, updateHost, type HostInput } from "./hosts";
import { Button } from "./kit/Button";

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
 * brings the address, the device token and the LAN identity in one step. A
 * `<scheme>://pair` link opens it prefilled (`pair` + `pairFromLink`).
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
  | { s: "ok"; root: string; protocol: number }
  | { s: "bad"; why: string; hint?: string };

const PROBE_TIMEOUT_MS = 6000;

export type HostSetupMode = "first" | "add" | "edit";

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

export function HostSetup({ mode, host, lanSuggest = [], pair, pairFromLink, onDone, onCancel }: {
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
}) {
  const [name, setName] = useState(host?.name ?? "");
  const [text, setText] = useState(host?.base ?? "");
  const [lanText, setLanText] = useState(host?.lan?.base ?? "");
  const [ssids, setSsids] = useState<string[]>(host?.lan?.ssids ?? []);
  const [auto, setAuto] = useState(host?.lan?.auto ?? false);
  const [probe, setProbe] = useState<Probe>({ s: "idle" });
  const [problem, setProblem] = useState<string | null>(null);
  const [ssidNote, setSsidNote] = useState<string | null>(null);
  const [needLocation, setNeedLocation] = useState(false);
  const [pairing, setPairing] = useState(mode !== "edit" && (mode === "first" || !!pair));
  // A desktop found on the tailnet that has a password: the pair form, on its address.
  const [found, setFound] = useState<{ target: PairTarget; note: string } | null>(null);
  const base = normalizeHostBase(text);
  const lanBase = lanText.trim() ? normalizeHostBase(lanText) : null;
  const net = shellNet();

  useEffect(() => { if (pair && mode !== "edit") setPairing(true); }, [pair, mode]);

  // Typing invalidates a previous verdict — a green tick next to an edited
  // address is worse than no tick.
  useEffect(() => { setProbe({ s: "idle" }); setProblem(null); }, [text]);

  async function test(): Promise<boolean> {
    if (!base) return false;
    setProbe({ s: "busy" });
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
      setProbe({ s: "ok", root: d.root || "?", protocol: d.protocol ?? 0 });
      return true;
    } catch (e) {
      const aborted = (e as Error)?.name === "AbortError";
      setProbe({
        s: "bad",
        why: aborted ? "no answer within 6s" : "could not reach that address",
        hint: aborted
          ? "The desktop may be asleep, or Tailscale is not up on this phone."
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
    };
  }

  /** Save. `activate`: make it the active host (reloads). */
  function save(activate: boolean): void {
    const kv = browserKV();
    if (!kv) { setProblem("This phone's storage is not available."); return; }
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

  return (
    <div className={mode === "first" ? "auth-gate" : undefined}>
      <div className={mode === "first" ? "auth-card" : "form"}>
        {mode === "first" && (
          <div className="auth-title pair-title"><span className="pair-title-icon"><Plug size={18} /></span> {title}</div>
        )}
        {mode === "add" && !pair && (
          <FoundDesktops onPassword={(b, n) => { setFound({ target: { base: b, code: "" }, note: passwordSentence(n) }); setPairing(true); }} />
        )}
        {found && pairing && (
          <div className="set-note warn" style={{ marginBottom: 10 }}>{found.note}</div>
        )}
        {mode !== "edit" && !(pairFromLink && pair) && (
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
            />
            {onCancel && (
              <div className="set-row" style={{ marginTop: 10 }}>
                <Button onClick={onCancel}>cancel</Button>
              </div>
            )}
          </>
        ) : (<>
        <div className="set-note" style={{ marginBottom: 12 }}>
          The address the {BRAND.name} daemon prints at boot — usually its Tailscale IP.
          Port {" "}
          <code>8770</code> is assumed unless you type another one.
        </div>

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

        {base && <div className="set-note" style={{ marginTop: 8, opacity: 0.75 }}>will use <code>{base}</code></div>}
        {text.trim() && !base && (
          <div className="set-note" style={{ marginTop: 8, color: "var(--dead)" }}>
            Not an address. Use a host name or IP, optionally with a port — http or https only.
          </div>
        )}

        <input
          className="auth-input"
          style={{ marginTop: 10 }}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={`name — ${namePlaceholder}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        {probe.s === "busy" && (
          <div className="set-note" style={{ marginTop: 10 }}>
            <Loader2 size={13} className="spin" style={{ verticalAlign: "-2px" }} /> checking…
          </div>
        )}
        {probe.s === "ok" && (
          <div className="set-note" style={{ marginTop: 10, color: "var(--ok)" }}>
            <CheckCircle2 size={13} style={{ verticalAlign: "-2px" }} /> daemon found — root <code>{probe.root}</code>
            {probe.protocol !== PROTOCOL_VERSION && ` · protocol ${probe.protocol}, this app speaks ${PROTOCOL_VERSION}`}
          </div>
        )}
        {probe.s === "bad" && (
          <div className="set-note" style={{ marginTop: 10, color: "var(--dead)" }}>
            <XCircle size={13} style={{ verticalAlign: "-2px" }} /> {probe.why}
            {probe.hint && <div style={{ opacity: 0.8, marginTop: 4 }}>{probe.hint}</div>}
          </div>
        )}

        {mode !== "first" && (
          <details style={{ marginTop: 14 }} open={!!host?.lan}>
            <summary className="set-note"><Router size={13} style={{ verticalAlign: "-2px" }} /> on the same Wi-Fi (optional)</summary>
            <div className="set-note" style={{ marginTop: 6 }}>
              The desktop's address on your home network. The app uses it only on the Wi-Fi names
              below, only after the desktop proves who it is, and only when the switch is on.
            </div>
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
              <div className="set-note" style={{ marginTop: 6, color: "var(--dead)" }}>Not an address.</div>
            )}
            {lanSuggest.length > 0 && (
              <div className="set-chips" style={{ marginTop: 6 }}>
                {lanSuggest.map((ip) => (
                  <Button key={ip} onClick={() => setLanText(ip)}>{ip}</Button>
                ))}
              </div>
            )}
            <div className="set-chips" style={{ marginTop: 8 }}>
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
                note={ssids.length === 0 ? "No Wi-Fi name yet, so it never switches — add the one at home." : undefined} />
            )}
          </details>
        )}

        {problem && <div className="set-note" style={{ marginTop: 10, color: "var(--dead)" }}>{problem}</div>}

        <div className="set-row" style={{ marginTop: 14, flexWrap: "wrap", gap: 8 }}>
          {base ? (
            <>
              {probe.s !== "busy" && <Button onClick={() => void test()}>test</Button>}
              {/* Offered even on a failed probe: a desktop that is merely asleep
                  is the common case, and refusing to save the (correct) address
                  would strand someone on this screen with nothing to do. */}
              {mode === "first" && <Button variant="primary" onClick={() => save(true)}>connect</Button>}
              {mode === "add" && <Button variant="primary" onClick={() => save(true)}>add and switch</Button>}
              {mode === "add" && <Button onClick={() => save(false)}>add</Button>}
              {mode === "edit" && <Button variant="primary" onClick={() => save(false)}>save</Button>}
            </>
          ) : (
            <span className="set-note">Type the desktop's address to test or save it.</span>
          )}
          {onCancel && <Button onClick={onCancel}>cancel</Button>}
        </div>
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
          <div className="set-note" style={{ marginTop: 14, opacity: 0.65 }}>
            This app keeps its interface inside the APK, so it stays usable — queue,
            drafts, cached transcripts — even when the desktop is unreachable.
          </div>
        )}
      </div>
    </div>
  );
}
