/**
 * The `web` backend — a real browser, resolved at runtime, pointed at a dev
 * server somebody else started.
 *
 * ── Playwright is never a dependency of this repo ──────────────────────────
 *
 * It downloads browsers. Adding it to the host's `package.json` would put a
 * multi-hundred-megabyte install in the path of every `npm install` on every
 * machine, for a feature most repos never use — the same argument `thumbs.ts`
 * makes about `sharp`, with a bigger number on it. So it is resolved through
 * `createRequire` with a VARIABLE specifier: the target repo's own
 * `node_modules` first (a web project that wants this already has Playwright as
 * a dev dependency), then the host's, then nothing — at which point `probe()`
 * answers a sentence the phone renders as text and the other three backends
 * keep working. The specifier has to be a variable for `tsc` to leave it alone;
 * a literal `import("playwright")` fails module resolution at type-check on
 * every machine that has not installed it.
 *
 * ── Capture never starts a dev server ──────────────────────────────────────
 *
 * Nothing applies itself. When the url does not answer, this refuses in words
 * and names the Build sheet as the place to start one. Spawning `npm run dev`
 * from a screenshot button would leave a server nobody knows about running on a
 * port nobody chose, and "the capture started your dev server" is a side effect
 * a person did not ask for.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { DEFAULT_CAPTURE_VIEWPORT } from "@waterplane/shared";
import type { CaptureBackendInfo, CaptureTarget, CaptureTheme } from "@waterplane/shared";
import type {
  CaptureBackend, CaptureCtx, CapturePass, CaptureSession, FrameResult, OracleReading,
  PwBrowser, PwContext, PwModule, PwPage,
} from "./types.js";

/** Console/network lines kept in the sidecar. The tail of a chatty app is not
 *  evidence, and the sidecar is a document the phone downloads. */
const MAX_LINES = 20;
/** How long to wait for the url to answer at all before refusing in words. */
const PROBE_MS = 5_000;
const GOTO_MS = 30_000;

const hostRequire = createRequire(import.meta.url);

/** Load Playwright out of `repoDir` first, then out of the host. Null = absent. */
function loadPlaywright(repoDir?: string): { mod: PwModule; where: string } | null {
  const specs = ["playwright", "playwright-core"];
  const tries: { req: NodeRequire; where: string }[] = [];
  if (repoDir) {
    try { tries.push({ req: createRequire(join(repoDir, "package.json")), where: "this repo" }); }
    catch { /* no package.json there — fall through to the host's */ }
  }
  tries.push({ req: hostRequire, where: "the host" });
  for (const t of tries) {
    for (const spec of specs) {
      try {
        const mod = t.req(spec) as PwModule;
        if (mod && mod.chromium) return { mod, where: `${spec} in ${t.where}` };
      } catch { /* not there */ }
    }
  }
  return null;
}

/** Loopback-only, lexically. A capture of something on another machine is a
 *  capture of a screen this daemon cannot account for. */
function isLocalUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0"
    || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** `web:<port>` — two runs against one dev server would fight over its state. */
function portOf(raw: string): string {
  try {
    const u = new URL(raw);
    return u.port || (u.protocol === "https:" ? "443" : "80");
  } catch {
    return "?";
  }
}

class WebSession implements CaptureSession {
  private consoleLines: string[] = [];
  private errors = 0;
  private warnings = 0;
  private netLines: string[] = [];
  private failed = 0;

  constructor(
    private browser: PwBrowser,
    private ctx: PwContext,
    private page: PwPage,
  ) {
    page.on("console", (m: any) => {
      let type = "log", text = "";
      try { type = String(m.type()); text = String(m.text()); } catch { /* a message we cannot read is still a count */ }
      if (type === "error") this.errors++;
      else if (type === "warning" || type === "warn") this.warnings++;
      else return;
      if (this.consoleLines.length < MAX_LINES) this.consoleLines.push(`${type}: ${text}`.slice(0, 300));
    });
    page.on("pageerror", (e: any) => {
      this.errors++;
      if (this.consoleLines.length < MAX_LINES) this.consoleLines.push(`pageerror: ${String(e?.message ?? e)}`.slice(0, 300));
    });
    page.on("requestfailed", (r: any) => {
      this.failed++;
      let url = "", why = "";
      try { url = String(r.url()); why = String(r.failure()?.errorText ?? ""); } catch { /* still counted */ }
      if (this.netLines.length < MAX_LINES) this.netLines.push(`${why || "failed"} ${url}`.slice(0, 300));
    });
    page.on("response", (r: any) => {
      let status = 0, url = "";
      try { status = Number(r.status()); url = String(r.url()); } catch { return; }
      if (status < 400) return;
      this.failed++;
      if (this.netLines.length < MAX_LINES) this.netLines.push(`${status} ${url}`.slice(0, 300));
    });
  }

  async frame(absPath: string): Promise<FrameResult> {
    await this.page.screenshot({ path: absPath, fullPage: false, animations: "disabled" });
    return { path: absPath };
  }

  async oracle(): Promise<OracleReading> {
    let text: string | undefined;
    let html = "";
    // A string expression, not a closure: the host has no DOM lib and must not
    // acquire one for four words of JavaScript that run in the browser.
    //
    // An EMPTY answer is still an answer. `text` is left undefined only when
    // the evaluate THREW — nobody could be asked. A page that genuinely has no
    // text (a canvas-only app) answers with `""`, which `oracleAnswered()`
    // accepts, so its anchors are recorded as wanted-and-not-found. Collapsing
    // the two with `text || undefined` made the sidecar OMIT the anchor record
    // for such a page — and an absent record is documented as "the target named
    // none", so "asked, and there is nothing on screen to answer with" printed
    // exactly like "nobody asked".
    try { text = String(await this.page.evaluate("document.body ? document.body.innerText : ''")); } catch { /* unreadable */ }
    try { html = await this.page.content(); } catch { /* unreadable */ }
    return {
      text,
      html: html || undefined,
      console: { errors: this.errors, warnings: this.warnings, lines: this.consoleLines.slice() },
      network: { failed: this.failed, lines: this.netLines.slice() },
    };
  }

  async end(): Promise<void> {
    try { await this.page.close(); } catch { /* already gone */ }
    try { await this.ctx.close(); } catch { /* already gone */ }
    try { await this.browser.close(); } catch { /* already gone */ }
  }
}

export const webBackend: CaptureBackend = {
  id: "web",

  async probe(repoDir?: string): Promise<CaptureBackendInfo> {
    const pw = loadPlaywright(repoDir);
    if (!pw) {
      return {
        id: "web",
        available: false,
        reason: "web capture needs Playwright, which is not installed here — "
          + "run `npm i -D playwright && npx playwright install chromium` in the repo you want to capture.",
      };
    }
    return { id: "web", available: true, reason: `using ${pw.where}` };
  },

  leaseKey(t: CaptureTarget): string | null {
    return `web:${portOf(t.url ?? "")}`;
  },

  validate(t: CaptureTarget): string | null {
    if (!t.url || !t.url.trim()) return "this web target has no url yet — set one in the Capture sheet.";
    if (!isLocalUrl(t.url)) {
      return `"${t.url}" is not a local address. Web capture only drives a dev server on this machine `
        + "(localhost or 127.x), because a picture of somebody else's host is not evidence about this repo.";
    }
    return null;
  },

  passes(t: CaptureTarget): CapturePass[] {
    const viewports = (t.viewports ?? []).filter((v) => v && v.w > 0 && v.h > 0);
    const vs = viewports.length ? viewports : [DEFAULT_CAPTURE_VIEWPORT];
    const pref = t.theme ?? "dark";
    const themes: CaptureTheme[] = pref === "both" ? ["light", "dark"] : [pref];
    const out: CapturePass[] = [];
    for (const v of vs) for (const theme of themes) out.push({ label: `${v.w}x${v.h} ${theme}`, viewport: v, theme });
    return out;
  },

  async open(t: CaptureTarget, ctx: CaptureCtx): Promise<CaptureSession> {
    const pw = loadPlaywright(ctx.cwd);
    if (!pw) throw new Error((await webBackend.probe(ctx.cwd)).reason ?? "Playwright is not installed here.");
    const url = t.url!;

    // Ask the url whether anything is listening BEFORE paying for a browser. A
    // 404 is an answer — a server is up and the target's path is wrong, which
    // the frame itself will show. Only a refused connection is the refusal.
    try {
      await fetch(url, { method: "GET", signal: AbortSignal.timeout(PROBE_MS) });
    } catch (e) {
      throw new Error(
        `nothing is answering at ${url} (${String((e as Error)?.message ?? e)}). Capture does not start dev servers — `
        + "start it from the Build sheet (or by hand), then run this target again.",
      );
    }

    const browser = await pw.mod.chromium.launch({ headless: true });
    let pctx: PwContext;
    let page: PwPage;
    try {
      // `deviceScaleFactor: 2` means the PNG is TWICE the viewport in each
      // direction — a 390x844 pass writes a 780x1688 file. Both numbers are
      // true and the sidecar carries both, labelled: `viewport` is what was
      // asked for in device-independent pixels, `files[].w`/`h` is what the
      // file actually is (`wire/capture.ts` says so on both fields). Nothing
      // here may quietly start reporting one as the other.
      // Playwright's viewport is `{width,height}`; ours is `{w,h}` (`wire/capture.ts`).
      // `newContext` is typed `unknown` here — the minimal local typings in
      // `capture/types.ts` deliberately do not restate Playwright's API — so
      // handing it our shape type-checked on every machine and threw
      // "viewport.width: expected integer, got undefined" on the one machine
      // that had Playwright installed. Map it at the boundary, once.
      const vp = ctx.pass.viewport ?? DEFAULT_CAPTURE_VIEWPORT;
      pctx = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        colorScheme: ctx.pass.theme ?? "dark",
        deviceScaleFactor: 2,
      });
      page = await pctx.newPage();
    } catch (e) {
      try { await browser.close(); } catch { /* already gone */ }
      throw e;
    }

    const session = new WebSession(browser, pctx, page);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: GOTO_MS });
    } catch (e) {
      await session.end();
      throw new Error(`${url} did not load: ${String((e as Error)?.message ?? e)}`);
    }
    ctx.log(`[capture] ${ctx.pass.label} — loaded ${url}`);
    return session;
  },
};
