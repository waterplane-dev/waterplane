// First app, the PHONE half (first-app plan WP7), web path, in a real browser against a real host:
// first-run card → three questions → consent (only the lines the plan listed) → Go → the checklist
// fills from `onboard.progress` → the page lands in the new repo's outbox → "open the session"
// attaches it with the suggested prompt in the composer as a draft, unsent.
//
// The bundle is served by the page's own route handler, not by the host, so a scratch build can be
// tested without ever writing `packages/web/dist` (which ships to the phone over the air):
//   WATERPLANE_E2E_WEB_DIST=<dir>   default packages/web/dist (present after `npm run build`)
//   WATERPLANE_E2E_SHOTS=<dir>      write a screenshot per stage there (none by default)
// Without Playwright's Chromium, or without a bundle, this prints SKIP: and exits 0.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { bootHost } from "./lib-e2e.mjs";
import { E } from "./lib-brand.mjs";

const DIST = resolve(process.env[E.E2E_WEB_DIST] || "packages/web/dist");
const SHOTS = process.env[E.E2E_SHOTS] ? resolve(process.env[E.E2E_SHOTS]) : null;
if (!existsSync(join(DIST, "index.html"))) { console.log(`SKIP: no web bundle at ${DIST} (run npm run build, or set ${E.E2E_WEB_DIST})`); process.exit(0); }
let chromium;
try { ({ chromium } = await import("playwright")); } catch { console.log("SKIP: playwright is not installed"); process.exit(0); }
let browser;
// A document fulfilled by `page.route` has no address space, so Chromium treats it as public and
// blocks its socket to loopback (Local Network Access); the host it talks to IS loopback.
try { browser = await chromium.launch({ args: ["--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests"] }); } catch (e) { console.log(`SKIP: Playwright's Chromium will not start (${String(e?.message ?? e).split("\n")[0]})`); process.exit(0); }

const SUGGESTED = "Add a confetti burst on every tenth tap";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".txt": "text/plain" };

const h = await bootHost({ tag: "onboardphone", quiet: true });
let page = null;
const fail = async (m) => {
  console.error("FAIL:", m);
  if (page && SHOTS) await page.screenshot({ path: join(SHOTS, "onboard-fail.png") }).catch(() => {});
  if (page) console.error("screen text:", (await page.locator("body").innerText().catch(() => "?")).slice(0, 600));
  await browser.close(); await h.stop(); process.exit(1);
};
let n = 0;
const shot = async (page, name) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `onboard-${String(++n).padStart(2, "0")}-${name}.png`) });
};

try {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2 });
  page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  if (process.env.E2E_DEBUG) {
    page.on("console", (m) => console.log("[console]", m.type(), m.text().slice(0, 200)));
    page.on("websocket", (ws) => { console.log("[ws]", ws.url()); ws.on("close", () => console.log("[ws] closed")); ws.on("socketerror", (e) => console.log("[ws] error", e)); });
    page.on("requestfailed", (r) => console.log("[reqfail]", r.url(), r.failure()?.errorText));
  }
  // Everything that is not the API comes from DIST; the socket is never routed (it goes to the host).
  await page.route(`${h.base}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return route.continue();
    let file = join(DIST, decodeURIComponent(url.pathname));
    if (!file.startsWith(DIST) || !existsSync(file) || url.pathname === "/") file = join(DIST, "index.html");
    if (url.pathname === "/sw.js") return route.fulfill({ status: 404, body: "" });
    await route.fulfill({ status: 200, contentType: MIME[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
  await page.goto(h.base + "/");

  // ── The first-run card: a host that never opened a session ────────────────
  const card = page.locator('[data-card="first-run"]');
  await card.waitFor({ timeout: 20_000 }).catch(() => fail("no first-run card on a fresh host; page errors: " + errors.join(" | ")));
  for (const words of ["Build your first app", "Open an existing repo", "Try the demo"]) {
    if (!(await card.getByText(words).count())) await fail(`the card does not offer "${words}"`);
  }
  await shot(page, "card");
  await card.getByText("Build your first app").click();

  // ── Three questions: a browser preselects the web page ────────────────────
  const name = page.getByLabel("app name");
  await name.waitFor();
  if (!/^hello-[a-z]+$/.test(await name.inputValue())) await fail("the name is not prefilled hello-<word>: " + await name.inputValue());
  if (!(await page.locator(".onb-choice .key.active", { hasText: "web page" }).count())) await fail("web page is not preselected in a browser");
  await name.fill("hello-otter");
  await shot(page, "questions");
  await page.getByText("Next: see what this will do").click();

  // ── Consent: exactly the plan's lines; nothing exists before Go ───────────
  await page.locator('[data-line="repo"]').waitFor({ timeout: 10_000 }).catch(() => fail("no consent screen"));
  const lines = await page.locator("[data-line]").evaluateAll((els) => els.map((e) => e.getAttribute("data-line")));
  if (JSON.stringify(lines) !== JSON.stringify(["repo", "session"])) await fail("web consent lines: " + JSON.stringify(lines));
  if (existsSync(join(h.root, "hello-otter"))) await fail("something was created before Go");
  // Unticking a needed line replaces Go with the reason — never a greyed Go.
  await page.locator('[data-line="repo"] .onb-tick').click();
  if (await page.locator(".onb-go").count()) await fail("Go is still drawn with a needed line unticked");
  if (!(await page.getByText(/Go needs the line/).count())) await fail("no sentence saying why Go is missing");
  await page.locator('[data-line="repo"] .onb-tick').click();
  await shot(page, "consent");
  await page.locator(".onb-go").click();

  // ── Progress: the checklist fills from onboard.progress until ready ───────
  await page.locator('[data-step="scaffold"]').waitFor({ timeout: 10_000 }).catch(() => fail("no checklist after Go"));
  await shot(page, "progress");
  await page.getByText("hello-otter is ready.").waitFor({ timeout: 45_000 })
    .catch(async () => fail("the job never finished: " + await page.locator(".onb-check").innerText().catch(() => "?")));
  const page0 = join(h.root, "hello-otter", ".claude", "outbox", "hello-otter.html");
  if (!existsSync(page0)) await fail("the page did not land in the outbox: " + page0);
  for (const id of ["scaffold", "setup", "build", "session"]) {
    if (!(await page.locator(`[data-step="${id}"].done`).count())) await fail(`step ${id} is not done on the checklist`);
  }
  await shot(page, "ready");

  // ── Hand-off: the session opens with the suggested prompt as an unsent draft ─
  const open = page.getByText("open the session in hello-otter");
  let attached = false;
  for (let i = 0; i < 20 && !attached; i++) {
    await open.click();
    await page.waitForTimeout(500);
    attached = !(await open.count());
  }
  if (!attached) await fail("the session never opened from the hand-off");
  const box = page.locator("textarea:not(.xterm-helper-textarea)").first();
  await box.waitFor({ timeout: 10_000 }).catch(() => fail("no composer on the session screen"));
  const draft = await box.inputValue();
  if (!draft.includes(SUGGESTED)) await fail("the suggested prompt is not in the composer: " + JSON.stringify(draft));
  await shot(page, "session");
  if (errors.length) await fail("page errors: " + errors.join(" | "));

  console.log(`PASS onboard (phone, web): card → questions → consent → Go → ready → session with the draft${SHOTS ? `; ${n} screenshots in ${SHOTS}` : ""}`);
  await browser.close();
  await h.stop();
} catch (e) {
  await fail(e?.stack ?? String(e));
}
