/**
 * What a capture target is allowed to say, what an error overlay looks like,
 * and which backends this machine can run. Split out of `capture.ts` (move only).
 */
import { isAbsolute, normalize } from "node:path";
import { CAPTURE_BACKEND_IDS } from "@waterplane/shared";
import type { CaptureBackendId, CaptureBackendInfo, CaptureOverlayKind, CaptureTarget, CaptureViewport } from "@waterplane/shared";
import { BACKENDS, ENABLED, MAX_SETTLE_MS, OFF_TEXT, PROBE_TTL_MS } from "./capturekit.js";

/** The markers, in the order they are tried. Vite's overlay is a custom element
 *  by that exact tag name; Next's dev overlay mounts into `nextjs-portal`;
 *  CRA/webpack's boundary overlay is an iframe with that id. */
const OVERLAYS: { kind: CaptureOverlayKind; re: RegExp; body: RegExp[] }[] = [
  {
    kind: "vite-hmr",
    re: /vite-error-overlay/i,
    body: [/class="message-body"[^>]*>([^<]{1,400})/i, /class="message"[^>]*>([\s\S]{1,400}?)</i],
  },
  {
    kind: "next-error",
    re: /nextjs-portal|nextjs__container_errors/i,
    body: [/id="nextjs__container_errors_desc"[^>]*>([\s\S]{1,400}?)</i, /class="[^"]*error-message[^"]*"[^>]*>([\s\S]{1,400}?)</i],
  },
  {
    kind: "react-boundary",
    re: /react-error-overlay|webpack-dev-server-client-overlay/i,
    body: [/<pre[^>]*>([\s\S]{1,400}?)<\/pre>/i],
  },
];

/**
 * Is this page showing a failure overlay rather than the app?
 *
 * A red Vite box is a perfectly sharp, perfectly stable, perfectly non-blank
 * screenshot — it passes every other check in this file. It is also not the
 * screen anybody asked for, so it is the VERDICT (`error-overlay:vite-hmr`) and
 * the run fails. The frame is still written; see the module header.
 *
 * `text` is ABSENT when the overlay was recognised by its marker but its
 * message could not be read out. Recognised-but-unreadable and clean are not
 * the same thing, and the sidecar's optional `text` is what keeps them apart.
 */
export function classifyOverlay(html: string | undefined | null): { kind: CaptureOverlayKind; text?: string } | null {
  if (!html) return null;
  for (const o of OVERLAYS) {
    if (!o.re.test(html)) continue;
    for (const b of o.body) {
      const m = b.exec(html);
      const text = m ? tidy(m[1]) : "";
      if (text) return { kind: o.kind, text };
    }
    return { kind: o.kind };
  }
  return null;
}

function tidy(s: string): string {
  return s.replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** What `cleanTarget()` answers. A refusal carries the SENTENCE, because the
 *  only useful thing to do with a bad row is tell somebody what is wrong with
 *  it — `null` would make `run()` say "unknown target" about a target that is
 *  sitting right there in the file. */
export type CleanTargetResult =
  | { ok: true; target: CaptureTarget }
  | { ok: false; reason: string };

/**
 * Sanitize one persisted capture target — `builds.ts`'s `cleanConfig`, with
 * refusals that can speak.
 *
 * An unknown `backend` is refused NAMING THE KNOWN IDS and never coerced:
 * `window` is the whole desktop, so a typo quietly defaulting would hand back a
 * real-looking picture of the wrong thing and nothing would say so. A `dir`
 * that is absolute or climbs out of the repo is refused here lexically; the
 * REAL guard is `contained()` against the worktree at run time, and both stay.
 *
 * Backend-specific fields are NOT required here. A `web` target with no url is
 * kept and refused by the backend when somebody runs it — dropping it would
 * delete a half-configured target out from under the person typing it.
 */
export function cleanTarget(v: unknown, i: number): CleanTargetResult {
  const raw = (v && typeof v === "object" ? v : null) as Record<string, any> | null;
  if (!raw) return { ok: false, reason: `capture target #${i + 1} is not an object.` };

  const backend = raw.backend;
  if (!CAPTURE_BACKEND_IDS.includes(backend)) {
    const who = typeof raw.name === "string" && raw.name.trim() ? `"${raw.name.trim()}"` : `#${i + 1}`;
    return {
      ok: false,
      reason: `capture target ${who} has backend ${JSON.stringify(backend ?? null)}, which is not one of `
        + `${CAPTURE_BACKEND_IDS.join(", ")}.`,
    };
  }

  let dir: string | undefined;
  if (typeof raw.dir === "string" && raw.dir.trim()) {
    const d = raw.dir.trim();
    if (isAbsolute(d) || normalize(d).split(/[\\/]/)[0] === "..") {
      return { ok: false, reason: `capture target "${raw.name ?? raw.id}" has a working dir outside the repo: ${d}` };
    }
    dir = d;
  }

  const str = (x: unknown, cap: number) => (typeof x === "string" && x.trim() ? x.trim().slice(0, cap) : undefined);
  const num = (x: unknown, lo: number, hi: number) =>
    (typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi ? x : undefined);

  const anchor = Array.isArray(raw.anchor)
    ? [...new Set(raw.anchor.filter((a: unknown) => typeof a === "string" && a.trim()).map((a: string) => a.trim().slice(0, 200)))]
    : undefined;

  const viewports = Array.isArray(raw.viewports)
    ? raw.viewports
      .map((p: any) => ({ w: num(p?.w, 1, 10_000), h: num(p?.h, 1, 10_000) }))
      .filter((p): p is CaptureViewport => p.w !== undefined && p.h !== undefined)
      .slice(0, 8)
    : undefined;

  const theme = raw.theme === "light" || raw.theme === "dark" || raw.theme === "both" ? raw.theme : undefined;

  return {
    ok: true,
    target: {
      id: str(raw.id, 64) ?? `t_${i}`,
      name: str(raw.name, 120) ?? "capture",
      backend: backend as CaptureBackendId,
      dir,
      anchor: anchor?.length ? anchor : undefined,
      settleMs: num(raw.settleMs, 0, MAX_SETTLE_MS),
      diffPct: num(raw.diffPct, 0, 100),
      url: str(raw.url, 2000),
      viewports: viewports?.length ? viewports : undefined,
      theme,
      serial: str(raw.serial, 120),
      screen: str(raw.screen, 120),
      device: str(raw.device, 120),
      windowTitle: str(raw.windowTitle, 200),
    },
  };
}

/**
 * Which backends this machine can run, and — when it cannot — the sentence the
 * phone renders as TEXT.
 *
 * Never a bare boolean: a greyed-out button with no explanation is the failure
 * `Unavailable.tsx` exists to prevent, and a `title` attribute is invisible on
 * a touch screen. Repo-scoped because the answer for `web` is: Playwright lives
 * in the TARGET repo's `node_modules`.
 */
const probeCache = new Map<string, { at: number; info: CaptureBackendInfo[] }>();

export async function probeCaptureBackends(repoDir?: string): Promise<CaptureBackendInfo[]> {
  if (!ENABLED) {
    return CAPTURE_BACKEND_IDS.map((id) => ({
      id, available: false, reason: OFF_TEXT,
    }));
  }
  const key = repoDir ?? "";
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.info;
  const info = await Promise.all(CAPTURE_BACKEND_IDS.map(async (id) => {
    try { return await BACKENDS[id].probe(repoDir); } catch (e) {
      return { id, available: false, reason: `could not be checked: ${String((e as Error)?.message ?? e)}` };
    }
  }));
  probeCache.set(key, { at: Date.now(), info });
  return info;
}
