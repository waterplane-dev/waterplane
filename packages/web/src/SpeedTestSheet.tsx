import { useEffect, useRef, useState } from "react";
import { Gauge, Download, Upload, Wifi, AlertTriangle, CheckCircle2, Copy, Activity, Timer } from "lucide-react";
import { api, copyText, type SpeedDebug, type SpeedResult } from "./api";
import { track } from "./usage";
import { SheetHead } from "./Sheet";
import { Button } from "./kit/Button";
import { SetNote, SetLine } from "./SettingsKit";
import { Hint } from "./kit/Hint";
import { useStore } from "./sdk";
import { DEFAULT_SPEED_MB, connTestStart, openNetHealth } from "./connTest";
import { latencyVerdict, summarizeLatency, throughputBasis, type LatencySummary } from "./connTestWords";

interface Props {
  onClose: () => void;
}

/** MB size presets for a run. Bigger = more accurate, more data burned. */
const SIZES = [8, 32, 128];
/** Round trips in one connection test, after one warm-up that is not counted (it pays for the TLS handshake). */
const PINGS = 20;

type Phase = "idle" | "ping" | "down" | "up" | "debug" | "done";

function fmtMbps(v: number): string {
  return v >= 100 ? v.toFixed(0) : v.toFixed(1);
}
function fmtMBs(mbps: number): string {
  return (mbps / 8).toFixed(1); // megabits → megabytes
}
function ms(v: number | null): string {
  return v == null ? "—" : `${Math.round(v)} ms`;
}

/**
 * Two tests of the link to the desktop, each on its own tap.
 *
 * CONNECTION TEST: twenty 1-byte HTTP round trips — how long a tap waits for an
 * answer, how much that wobbles, and how many get none. HTTP, not the socket the
 * strip pings over, so it is the path a file or a page load takes; the strip's
 * history is on Connection health, one tap away.
 *
 * SPEED TEST: host→phone and phone→host throughput over whatever origin the
 * app was loaded from (so the numbers reflect the real path), and — when
 * "capture debug info" is on — whether this connection is a direct path or
 * relayed through a Tailscale DERP server, plus the host's LAN IPs.
 *
 * A door (`connTest.ts`) may open this sheet with one of the two already
 * running: that tap was the ask.
 */
export function SpeedTestSheet({ onClose }: Props) {
  const [sizeMB, setSizeMB] = useState(DEFAULT_SPEED_MB);
  const [withDebug, setWithDebug] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [pct, setPct] = useState(0);
  const [lat, setLat] = useState<LatencySummary | null>(null);
  const [down, setDown] = useState<SpeedResult | null>(null);
  const [up, setUp] = useState<SpeedResult | null>(null);
  const [debug, setDebug] = useState<SpeedDebug | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const start = useStore(connTestStart);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const busy = phase !== "idle" && phase !== "done";
  const bytes = sizeMB * 1024 * 1024;

  // The door's ask, taken once: cleared before the run so a re-render never starts a second.
  useEffect(() => {
    if (!start) return;
    connTestStart.set(null);
    void (start === "ping" ? ping() : run());
  }, [start]); // eslint-disable-line react-hooks/exhaustive-deps -- fires only on a new ask; ping/run are this render's, so nothing stale

  async function ping() {
    if (busy) return;
    track("action:speedtest.ping");
    setError(null);
    setLat(null);
    setPhase("ping");
    setPct(0);
    await api.speedtest.ping(); // warm-up: opens the connection, not counted
    const samples: (number | null)[] = [];
    for (let i = 0; i < PINGS && live.current; i++) {
      samples.push(await api.speedtest.ping());
      setPct(Math.round(((i + 1) / PINGS) * 100));
    }
    setLat(summarizeLatency(samples));
    setPhase("done");
  }

  async function run() {
    if (busy) return;
    track("action:speedtest.run");
    setError(null);
    setDown(null);
    setUp(null);
    setDebug(null);
    setPct(0);
    try {
      setPhase("down");
      const d = await api.speedtest.download(bytes, (recv) => setPct(Math.round((recv / bytes) * 100)));
      setDown(d);

      setPhase("up");
      setPct(0);
      const u = await api.speedtest.upload(bytes);
      setUp(u);

      if (withDebug) {
        setPhase("debug");
        setDebug(await api.speedtest.debug().catch(() => null));
      }
      setPhase("done");
    } catch (e) {
      setError(String((e as Error).message || e));
      setPhase("done");
    }
  }

  async function copy(text: string, label: string) {
    if (await copyText(text)) {
      setCopied(label);
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500);
    }
  }

  const relayed = debug?.clientKind === "tailscale" && debug.route === "derp";
  const running = phase === "ping" ? `Testing the connection… ${pct}%`
    : phase === "down" ? `Downloading… ${pct}%`
    : phase === "up" ? "Uploading…"
    : phase === "debug" ? "Probing connection…"
    : null;

  return (
    <div className="sheet">
      <SheetHead title={<><Gauge size={18} style={{ verticalAlign: "-3px", marginRight: 6 }} />Connection & speed test</>} onClose={onClose}>
        <Button title="the link's history: ping, losses, what is not on the desktop yet" onClick={openNetHealth}><Activity size={16} /> health</Button>
      </SheetHead>

      <div className="form">
        <section className="set-group">
          <h3 className="set-title">Connection test</h3>
          <Hint>
            {PINGS} round trips to the desktop, one after another: how long a tap waits for an answer, how much
            that varies, and how many get none. Uses almost no data.
          </Hint>
          <SetLine>
            <Button variant="primary" onClick={() => void ping()}><Timer size={14} /> {phase === "ping" ? running : "run connection test"}</Button>
          </SetLine>
          {busy && phase !== "ping" && <SetNote>Waiting for the speed test to finish first.</SetNote>}
          {/* Nothing answered: the sentence says so; three tiles of dashes would say it again. */}
          {lat && lat.median == null && <SetNote>{latencyVerdict(lat)}</SetNote>}
          {lat && lat.median != null && (
            <>
              <div className="nh-stats">
                <div className="nh-stat"><span className="nh-stat-v">{ms(lat.median)}</span><span className="nh-stat-l">median round trip</span></div>
                <div className="nh-stat"><span className="nh-stat-v">{ms(lat.jitter)}</span><span className="nh-stat-l">jitter</span><span className="nh-stat-n">best {ms(lat.best)} · worst {ms(lat.worst)}</span></div>
                <div className="nh-stat"><span className="nh-stat-v">{lat.lost} of {lat.sent}</span><span className="nh-stat-l">no answer</span><span className="nh-stat-n">within 3 s</span></div>
              </div>
              <SetNote>{latencyVerdict(lat)}</SetNote>
            </>
          )}
        </section>

        <section className="set-group">
          <h3 className="set-title">Speed test</h3>
          <Hint>
            Throughput both directions over the address you loaded the app from — so the numbers reflect the
            real path (Tailscale tunnel or LAN). Moves the size below each way.
          </Hint>

          {/* size presets */}
          <div className="annot-tools">
            {SIZES.map((s) => (
              <Button
                key={s}
                className={sizeMB === s ? "active" : ""}
                onClick={() => { if (!busy) setSizeMB(s); }}
              >{s} MB</Button>
            ))}
          </div>

          <Hint as="label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={withDebug} onChange={(e) => { if (!busy) setWithDebug(e.target.checked); }} />
            Capture debug info (Tailscale route, DERP relay, host LAN IPs)
          </Hint>

          <SetLine>
            <Button onClick={() => void run()}><Gauge size={14} /> {running && phase !== "ping" ? running : `run speed test · ${sizeMB} MB each way`}</Button>
          </SetLine>
          {phase === "ping" && <SetNote>Waiting for the connection test to finish first.</SetNote>}

          {error && <Hint style={{ color: "var(--dead)" }}>Error: {error}</Hint>}

          {/* results */}
          {(down || up) && (
            <div style={{ marginTop: 4 }}>
              {down && (
                <SetLine style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                  <span><Download size={14} style={{ verticalAlign: "-2px" }} /> Download <span style={{ opacity: 0.6 }}>· {throughputBasis(down.bytes, down.ms)}</span></span>
                  <strong>{fmtMbps(down.mbps)} Mbps <span style={{ opacity: 0.6, fontWeight: 400 }}>· {fmtMBs(down.mbps)} MB/s</span></strong>
                </SetLine>
              )}
              {up && (
                <SetLine style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                  <span><Upload size={14} style={{ verticalAlign: "-2px" }} /> Upload <span style={{ opacity: 0.6 }}>· {throughputBasis(up.bytes, up.ms)}</span></span>
                  <strong>{fmtMbps(up.mbps)} Mbps <span style={{ opacity: 0.6, fontWeight: 400 }}>· {fmtMBs(up.mbps)} MB/s</span></strong>
                </SetLine>
              )}
            </div>
          )}
        </section>

        {/* diagnostics */}
        {debug && (
          <div className="set-group" style={{ marginTop: 8 }}>
            <Hint
              style={{
                display: "flex", gap: 8, alignItems: "flex-start",
                color: relayed ? "var(--dead)" : undefined,
              }}
            >
              {relayed ? <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                       : <CheckCircle2 size={16} style={{ flexShrink: 0, marginTop: 1 }} />}
              <span>{debug.verdict}</span>
            </Hint>

            <SetNote>
              <Wifi size={12} style={{ verticalAlign: "-2px" }} /> phone seen as {debug.clientIp} ({debug.clientKind})
              {debug.dialedHost && <> · dialed {debug.dialedHost}</>}
              {debug.route !== "unknown" && <> · route {debug.route}{debug.derpRegion ? `(${debug.derpRegion})` : ""}</>}
            </SetNote>

            {/* bypass links: hit these on the same WiFi to skip the tunnel */}
            {debug.lanIps.length > 0 && (
              <SetNote>
                Bypass the tunnel on same WiFi:
                {debug.lanIps.map((ip) => {
                  const urlStr = `http://${ip}:8770`;
                  return (
                    <Button key={ip} style={{ margin: "4px 6px 0 0" }} onClick={() => copy(urlStr, ip)}>
                      <Copy size={12} /> {urlStr}{copied === ip ? " ✓" : ""}
                    </Button>
                  );
                })}
              </SetNote>
            )}
            {debug.tailscaleIp && (
              <SetNote>tailscale IP: {debug.tailscaleIp}</SetNote>
            )}
            {!debug.tailscaleCli && (
              <SetNote style={{ opacity: 0.7 }}>No <code>tailscale</code> CLI on the host — route detection skipped.</SetNote>
            )}

            {/* raw probe output */}
            {(debug.raw.ping || debug.raw.netcheck || debug.raw.status) && (
              <details style={{ marginTop: 6 }}>
                <Hint as="summary" style={{ cursor: "pointer" }}>Raw tailscale output</Hint>
                {debug.raw.ping && <><SetNote>ping</SetNote><pre className="mono" style={{ overflowX: "auto", fontSize: 11 }}>{debug.raw.ping}</pre></>}
                {debug.raw.netcheck && <><SetNote>netcheck</SetNote><pre className="mono" style={{ overflowX: "auto", fontSize: 11 }}>{debug.raw.netcheck}</pre></>}
                {debug.raw.status && <><SetNote>status</SetNote><pre className="mono" style={{ overflowX: "auto", fontSize: 11 }}>{debug.raw.status}</pre></>}
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
