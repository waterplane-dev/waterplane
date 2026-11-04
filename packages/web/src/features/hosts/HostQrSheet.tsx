/**
 * The `pairqr` overlay: "pair another phone". Mints a single-use code on the
 * host this page talks to (`POST /api/pair/mint`) and shows it three ways — a
 * QR of the landing URL (`host/pair.ts` renders that page: web version or
 * the APK), the code as text for typing into another phone's "pair with code",
 * and the landing address. A desktop with no tailnet shows the deep link
 * instead (`pairLinkOf`): its landing URL is a plain address, and opening that burns the code.
 * A desktop with both offers the same for a new phone with no Tailscale: the landing URL is a tailnet
 * address that phone cannot reach, and the sheet's QR never carried the deep link's `l=`.
 *
 * Works in the browser PWA too (D10): minting needs a trusted, signed-in
 * caller, which this page already is. The countdown runs from when THIS phone
 * got the answer, not from the host's `expiresAt` — the two clocks need not
 * agree, and a code that reads "expired" a few seconds early costs one tap on
 * "new code", while one that reads valid after it died costs a failed pairing.
 */
import { useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { PASSIVE_PAIR_NOTE, PAIR_TTL_MS, formatPairCode, type PairMintResponse } from "@waterplane/shared";
import { Baby, Clock, ExternalLink, Loader2, QrCode, RotateCw, Smartphone, Wifi } from "lucide-react";
import { Sheet } from "../../Sheet";
import { api } from "../../api";
import { isNativeShell } from "../../hostUrl";
import { openExternal } from "../../openExternal";
import { PairCopyRows } from "../../PairCopyRows";
import { pairLanOnly, pairLinkOf } from "../../pairShare";
import { useCore } from "../../sdk";
import { codeLeftText, qrPath } from "./logic";
import { Button } from "../../kit";
import { SetNote } from "../../SettingsKit";

const ICON = 16;
const QUIET = 4;
/** Tailscale's Android app, for the sentence under the code. */
const TAILSCALE_ANDROID = "https://play.google.com/store/apps/details?id=com.tailscale.ipn";

/**
 * This page is the browser on an Android phone, so the app being paired may be
 * on THIS phone: a QR it cannot scan and a code to retype are the long way round.
 * The shell itself never draws the button — it would only re-open itself.
 */
function appMayBeHere(): boolean {
  return !isNativeShell() && typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

type Minted = { s: "busy" } | { s: "bad"; why: string } | { s: "ok"; m: PairMintResponse; until: number };

function Qr({ text }: { text: string }) {
  const drawn = useMemo(() => {
    try {
      const qr = qrcode(0, "M");
      qr.addData(text);
      qr.make();
      const n = qr.getModuleCount();
      return { n, d: qrPath(n, (r, c) => qr.isDark(r, c)) };
    } catch { return null; }
  }, [text]);
  if (!drawn) return <SetNote>This address is too long to draw as a QR — use the code below.</SetNote>;
  const side = drawn.n + QUIET * 2;
  // Dark on paper in BOTH themes: an inverted code does not scan everywhere.
  return (
    <svg className="pair-qr" viewBox={`${-QUIET} ${-QUIET} ${side} ${side}`} role="img" aria-label="pairing QR code" shapeRendering="crispEdges">
      <rect x={-QUIET} y={-QUIET} width={side} height={side} style={{ fill: "var(--paper)" }} />
      <path d={drawn.d} style={{ fill: "var(--media-bg)" }} />
    </svg>
  );
}

export function HostQrSheet() {
  const c = useCore();
  const [minted, setMinted] = useState<Minted>({ s: "busy" });
  const [now, setNow] = useState(() => Date.now());
  // "Passive device": the phone this code pairs gets app updates and nothing
  // else until the PIN unlocks it (`shared/passive.ts`). A new code per flip —
  // the scope is the code's, decided when it is minted.
  const [passive, setPassive] = useState(false);
  // The new phone has no Tailscale: the QR and the copy rows hold `lanDeepLink`.
  const [wantLan, setWantLan] = useState(false);

  async function mint(asPassive = passive): Promise<void> {
    setMinted({ s: "busy" });
    try {
      const m = await api.pair.mint(asPassive);
      setMinted({ s: "ok", m, until: Date.now() + PAIR_TTL_MS });
    } catch (e) {
      setMinted({ s: "bad", why: (e as Error)?.message || "no answer" });
    }
  }

  useEffect(() => { void mint(); }, []);
  useEffect(() => {
    if (minted.s !== "ok") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [minted.s]);

  const left = minted.s === "ok" ? codeLeftText(minted.until - now) : null;

  const here = appMayBeHere();
  const overLan = wantLan && minted.s === "ok" && !!minted.m.lanDeepLink;

  return (
    <Sheet title="Pair another phone" icon={<QrCode size={ICON} />} onClose={() => c.nav.close("pairqr")}>
      <div className="sheet-body pair-sheet">
        <section className="pair-card">
          <label className="pair-passive" title="the new phone gets app updates only; a PIN unlocks the rest for 30 minutes">
            <input type="checkbox" checked={passive} onChange={(e) => { const on = e.target.checked; setPassive(on); c.say.track("action:hosts.pairPassive"); void mint(on); }} />
            <Baby size={15} /> Passive device — app updates only
          </label>
          {passive && <SetNote>{PASSIVE_PAIR_NOTE} Nothing else works on it until it is unlocked with the PIN (Settings › Connection › Paired devices sets the PIN).</SetNote>}
        </section>
        {minted.s === "busy" && (
          <div className="pair-state"><Loader2 size={18} className="spin" /> asking the desktop for a code…</div>
        )}
        {minted.s === "bad" && (
          <div className="pair-state">
            <div style={{ color: "var(--dead)" }}>The desktop did not give a code: {minted.why}</div>
            <Button onClick={() => void mint()}><RotateCw size={14} /> try again</Button>
          </div>
        )}
        {minted.s === "ok" && !left && (
          <div className="pair-state">
            <div>That code has expired — they last 10 minutes and work once.</div>
            <Button variant="primary" onClick={() => void mint()}><RotateCw size={14} /> new code</Button>
          </div>
        )}
        {minted.s === "ok" && left && (
          <>
            {here && (
              <section className="pair-card">
                <div className="pair-card-head"><Smartphone size={15} /> The app is on this phone</div>
                <Button variant="primary" className="pair-wide" onClick={() => { c.say.track("action:hosts.pairThisPhone"); window.location.href = minted.m.deepLink; }}>
                  <Smartphone size={15} /> open the app on this phone
                </Button>
                <SetNote>
                  It opens with this desktop and code filled in — tap pair there. If nothing opens, the app is not installed.
                </SetNote>
              </section>
            )}
            {here && <div className="pair-or">or on another phone</div>}
            <section className="pair-card pair-card-qr">
              <Qr text={pairLinkOf(minted.m, overLan)} />
              <div className="pair-code">{formatPairCode(minted.m.code)}</div>
              <div className="pair-ttl"><Clock size={12} /> {left} · works once</div>
              {minted.m.updateKeyFingerprint && (
                <SetNote className="pair-centre">
                  Update key, for the question the app asks after pairing: <code style={{ overflowWrap: "anywhere" }}>{minted.m.updateKeyFingerprint}</code>
                </SetNote>
              )}
              <SetNote className="pair-centre">
                Scan with the other phone's camera, or type the code into its "pair with code" with the address{" "}
                <code>{(overLan ? minted.m.lanBase ?? minted.m.base : minted.m.base).replace(/^https?:\/\//, "")}</code>.
              </SetNote>
              {minted.m.lanDeepLink && (
                <Button title="switches this QR and the link below between the tailnet and the Wi-Fi" onClick={() => setWantLan(!overLan)}>
                  <Wifi size={13} /> {overLan ? "it has Tailscale: show the usual QR" : "no Tailscale on it? show the Wi-Fi QR"}
                </Button>
              )}
            </section>
            <section className="pair-card">
              <PairCopyRows m={minted.m} hostName={null} overLan={overLan} />
            </section>
          </>
        )}
        {minted.s === "ok" && pairLanOnly(minted.m) ? (
          <div className="pair-foot">
            <SetNote>
              This desktop has no Tailscale address, so the QR opens the app and never a web page. Install the app
              first, and put the new phone on the same Wi-Fi as the desktop.
            </SetNote>
          </div>
        ) : overLan ? (
          <div className="pair-foot">
            <SetNote>
              This QR opens the app and never a web page. Install the app first, and put the new phone on the same
              Wi-Fi as the desktop.
            </SetNote>
          </div>
        ) : (
          <div className="pair-foot">
            <SetNote>The new phone needs Tailscale signed in to the same tailnet.</SetNote>
            <SetNote>
              No app needed: the QR opens a page with "use web version" — that address is the whole app,
              and on your tailnet it needs no code. The code is for the Android app's "pair with code".
            </SetNote>
            <Button onClick={() => { if (!openExternal(TAILSCALE_ANDROID)) c.say.toast("could not open the link"); }}>
              <ExternalLink size={13} /> Tailscale for Android
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
