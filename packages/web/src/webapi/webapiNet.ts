import type { DeviceListResponse, DeviceRevokeResponse, PairMintResponse, PairRedeemRequest, TailnetPeersResponse, UiUsageDoc } from "@waterplane/shared";
import { nfetch, jget, jpost, jpostOk, jdel } from "./webapiFetch";
import { bgFetch, bgJson } from "./webapiBg";
import type { SpeedResult, PathKind, SpeedDebug } from "./webapiTypes";

/** Speed test, net stats, push, pairing, peers, devices. One slice of `api` (see api.ts). */
export const netApi = {
  // Speed test (bidirectional throughput + connection diagnostics).
  speedtest: {
    /** Download `bytes` from the host, streaming so we can report live progress. */
    download: async (bytes: number, onProgress?: (received: number) => void): Promise<SpeedResult> => {
      const t0 = performance.now();
      const r = await fetch(`/api/speedtest/download?bytes=${bytes}&_=${Date.now()}`, { cache: "no-store" });
      if (!r.ok || !r.body) throw new Error(`download ${r.status}`);
      const reader = r.body.getReader();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        onProgress?.(received);
      }
      const ms = performance.now() - t0;
      return { bytes: received, ms, mbps: mbps(received, ms) };
    },
    /** Upload `bytes` of random data to the host; reports client wall time + server receive time. */
    upload: async (bytes: number): Promise<SpeedResult> => {
      const body = new Uint8Array(bytes);
      for (let off = 0; off < bytes; off += 65536) crypto.getRandomValues(body.subarray(off, Math.min(off + 65536, bytes)));
      const t0 = performance.now();
      const r = await fetch("/api/speedtest/upload", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body,
      });
      const j = (await r.json()) as { ok: boolean; bytes?: number; ms?: number; error?: string };
      const ms = performance.now() - t0;
      if (!j.ok) throw new Error(j.error || "upload failed");
      return { bytes, ms, mbps: mbps(bytes, ms), serverMs: j.ms };
    },
    debug: () => jget<SpeedDebug>("/api/speedtest/debug"),
  },

  /** Link telemetry: the host's own view, and the reset behind NetHealthSheet. */
  netstats: {
    get: <T,>() => jget<T>("/api/netstats", undefined),
    reset: () => jdel("/api/netstats"),
    /** The per-minute rollup. Silent and `keepalive`, so a backgrounding phone
     *  still delivers the window it measured — see `netlog.ts`. */
    report: (body: unknown) =>
      bgFetch("/api/netstats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => undefined),
  },

  /** Web push subscription lifecycle. */
  push: {
    key: () => jget<{ key: string }>("/api/push/key"),
    subscribe: (sub: unknown) => jpost<unknown>("/api/push/subscribe", sub),
    unsubscribe: (endpoint: string) => jpost<unknown>("/api/push/unsubscribe", { endpoint }),
  },

  /** Feature-usage counters. The flush is silent by design — telemetry must
   *  never surface an error to the user, and never a spinner either. */
  uiUsage: {
    get: () => bgJson<UiUsageDoc>("/api/ui-usage"),
    flush: (body: string) =>
      bgFetch("/api/ui-usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      }),
    reset: () => bgFetch("/api/ui-usage", { method: "DELETE" }).catch(() => undefined),
  },

  /** The web bundle this device could update to, and its files. Silent: the
   *  check runs unprompted at boot. */
  webBundle: {
    manifest: <T,>() => bgJson<T>("/api/webbundle", { cache: "no-store" }),
    file: (path: string, buildId: string) =>
      bgFetch(
        `/api/webbundle/file?path=${encodeURIComponent(path)}&v=${encodeURIComponent(buildId)}`,
        { cache: "no-store" },
      ),
  },

  // LAN password gate.
  auth: {
    status: () => jget<{ kind: PathKind; authed: boolean; enabled: boolean; gateTailscale: boolean; canManage: boolean }>("/api/auth/status"),
    login: (password: string) => jpost<{ ok: boolean; error?: string }>("/api/auth/login", { password }),
    logout: () => jpost<{ ok: boolean }>("/api/auth/logout", {}),
  },

  /** Other waterplane desktops the connected one can see on the tailnet (`host/tailnetpeers.ts`). */
  tailnet: {
    peers: (signal?: AbortSignal) => jget<TailnetPeersResponse>("/api/tailnet/peers", 12_000, signal),
  },

  // Pairing another phone, and the device ledger (`host/pair.ts`, `host/authroutes.ts`).
  pair: {
    /** `passive`: the code pairs a kids'-phone device (`shared/passive.ts`). */
    mint: (passive = false) => jpostOk<PairMintResponse>("/api/pair/mint", passive ? { passive: true } : {}),
    /** To an ABSOLUTE base — the desktop being paired, which need not be the
     *  one in force. Resolves with the status and whatever body came back;
     *  `pairRedeem.readRedeemReply` reads it. Rejects only on transport. */
    redeem: async (base: string, req: PairRedeemRequest, held: string | null = null): Promise<{ status: number; body: unknown }> => {
      // `held`: this phone's token for that desktop already (a re-pair) — the
      // host swaps its old ledger row for the new one (`host/pair.ts`).
      const r = await nfetch(`${base}/api/pair/redeem`, {
        method: "POST", credentials: "omit", cache: "no-store",
        headers: held ? { "content-type": "application/json", authorization: `Bearer ${held}` } : { "content-type": "application/json" },
        body: JSON.stringify(req),
      }, 10_000);
      let body: unknown = null;
      try { body = await r.json(); } catch { /* not JSON: readRedeemReply says so */ }
      return { status: r.status, body };
    },
  },
  /**
   * The peer ledger (`host/peers/routes.ts`) of ONE named desktop — an ABSOLUTE
   * base and that desktop's own device token, because pairing writes to two
   * hosts at once and only one of them is the host this page talks to. The host
   * never sends a secret back: names, addresses and which way each row works.
   * Resolves with the status and whatever body came back; rejects only on
   * transport, so the sheet can say which side failed and why.
   */
  peers: {
    on: async (base: string, token: string | null, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["content-type"] = "application/json";
      if (token) headers.authorization = `Bearer ${token}`;
      const r = await nfetch(`${base}${path}`, {
        method, credentials: "omit", cache: "no-store", headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }, 10_000);
      let parsed: unknown = null;
      try { parsed = await r.json(); } catch { /* not JSON */ }
      return { status: r.status, body: parsed };
    },
  },
  devices: {
    list: () => jget<DeviceListResponse>("/api/devices"),
    revoke: (id: string) => jpostOk<DeviceRevokeResponse>("/api/devices/revoke", { id }),
  },
};

function mbps(bytes: number, ms: number): number {
  return ms > 0 ? (bytes * 8) / (ms / 1000) / 1e6 : 0;
}
