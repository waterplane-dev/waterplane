import { useState } from "react";
import { Gauge, Download, Upload, Wifi, AlertTriangle, CheckCircle2, Copy } from "lucide-react";
import { api, copyText, type SpeedDebug, type SpeedResult } from "./api";
import { track } from "./usage";
import { SheetHead } from "./Sheet";
import { Button } from "./kit/Button";
import { SetNote, SetLine } from "./SettingsKit";
import { Hint } from "./kit/Hint";

interface Props {
  onClose: () => void;
}

/** MB size presets for a run. Bigger = more accurate, more data burned. */
const SIZES = [8, 32, 128];

type Phase = "idle" | "down" | "up" | "debug" | "done";

function fmtMbps(v: number): string {
  return v >= 100 ? v.toFixed(0) : v.toFixed(1);
}
function fmtMBs(mbps: number): string {
  return (mbps / 8).toFixed(1); // megabits → megabytes
}

/**
 * Bidirectional speed test + connection diagnostics. Answers "why is the file
 * feature slow": measures host→phone and phone→host throughput over whatever
 * origin the app was loaded from (so the numbers reflect the real path), and —
 * when "capture debug info" is on — reports whether this connection is a direct
 * path or relayed through a Tailscale DERP server, plus the host's LAN IPs so
 * you can hit http://<lanIp>:8770 to bypass the tunnel.
 */
export function SpeedTestSheet({ onClose }: Props) {
  const [sizeMB, setSizeMB] = useState(32);
  const [withDebug, setWithDebug] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [pct, setPct] = useState(0);
  const [down, setDown] = useState<SpeedResult | null>(null);
  const [up, setUp] = useState<SpeedResult | null>(null);
  const [debug, setDebug] = useState<SpeedDebug | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const busy = phase !== "idle" && phase !== "done";
  const bytes = sizeMB * 1024 * 1024;

  async function run() {
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

  return (
    <div className="sheet">
      <SheetHead title={<><Gauge size={18} style={{ verticalAlign: "-3px", marginRight: 6 }} />Speed test</>} onClose={onClose} />

      <div className="form">
        <Hint>
          Measures throughput both directions over the address you loaded the app
          from — so the numbers reflect the real path (Tailscale tunnel or LAN).
        </Hint>

        {/* size presets */}
        <div className="annot-tools">
          {SIZES.map((s) => (
            <Button
              key={s}
              className={sizeMB === s ? "active" : ""}
              disabled={busy}
              onClick={() => setSizeMB(s)}
            >{s} MB</Button>
          ))}
        </div>

        <Hint as="label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={withDebug} disabled={busy} onChange={(e) => setWithDebug(e.target.checked)} />
          Capture debug info (Tailscale route, DERP relay, host LAN IPs)
        </Hint>

        <button className="send" onClick={run} disabled={busy}>
          {phase === "down" ? `Downloading… ${pct}%`
            : phase === "up" ? "Uploading…"
            : phase === "debug" ? "Probing connection…"
            : busy ? "Running…" : "Run test"}
        </button>

        {error && <Hint style={{ color: "var(--dead)" }}>Error: {error}</Hint>}

        {/* results */}
        {(down || up) && (
          <div className="set-group" style={{ marginTop: 4 }}>
            {down && (
              <SetLine style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                <span><Download size={14} style={{ verticalAlign: "-2px" }} /> Download</span>
                <strong>{fmtMbps(down.mbps)} Mbps <span style={{ opacity: 0.6, fontWeight: 400 }}>· {fmtMBs(down.mbps)} MB/s</span></strong>
              </SetLine>
            )}
            {up && (
              <SetLine style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                <span><Upload size={14} style={{ verticalAlign: "-2px" }} /> Upload</span>
                <strong>{fmtMbps(up.mbps)} Mbps <span style={{ opacity: 0.6, fontWeight: 400 }}>· {fmtMBs(up.mbps)} MB/s</span></strong>
              </SetLine>
            )}
          </div>
        )}

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
