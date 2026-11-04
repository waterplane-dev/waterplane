// What a person does on a real WebView, for the e2e-android-* scripts: touch the composer, type through
// Android's input system, touch Send, and read the words off the tmux pane.
//
// A script must not stand in for this with `value = ...` and `.click()`. The first visible <textarea> in a
// session is xterm's helper, not the composer: item c of e2e-android-oldshell.mjs wrote there, read the same
// box back ("the prompt stayed in the composer") and pressed Send on an empty composer. So these taps are
// `adb shell input tap` at the element's on-screen coordinates, and each one is checked from the page: the
// pointerdown must be trusted and must land inside the element it was aimed at.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";

export const COMPOSER = 'textarea[placeholder^="Message"]';
export const SEND = 'button.send[title^="Send to this session"]';
const QUEUE_WORDS = /not delivered|sending \u201c|\d queued \u2014|confirming it ran/i;

/** Every pane on the script's private tmux servers (`lib-tmuxiso.mjs`), scrollback included. */
export function tmuxPanes() {
  const dir = process.env.TMUX_TMPDIR;
  let text = "";
  for (const d of readdirSync(dir)) {
    for (const s of readdirSync(join(dir, d))) {
      const sock = join(dir, d, s);
      const ids = spawnSync("tmux", ["-S", sock, "list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
      for (const p of ids) text += "\n" + spawnSync("tmux", ["-S", sock, "capture-pane", "-p", "-S", "-2000", "-t", p], { encoding: "utf8" }).stdout;
    }
  }
  return text;
}

// A pane wraps at the phone's column count, so words are compared with the whitespace gone.
const squeezed = (s) => s.replace(/\s+/g, "");
export const paneHas = (words) => squeezed(tmuxPanes()).includes(squeezed(words));

/**
 * Did Return follow the words? A pane showing them proves only the echo: the host types, reads the echo
 * back and presses Return after that, so a word on the input line is not yet a prompt that ran.
 * `stubLog` is the stub TUI's `STUB_LOG`, every byte it was sent.
 */
export function submittedTo(stubLog, words) {
  if (!existsSync(stubLog)) return false;
  const bytes = readFileSync(stubLog, "latin1");
  const at = bytes.indexOf(words);
  return at >= 0 && bytes.indexOf("\r", at + words.length) >= 0;
}

/**
 * `sh` runs on the device, `ev` runs a function body in the page (its failures come back as `{__error}`).
 * `stubLog` is the file the host's stub writes (`STUB_LOG`). Every tap and read is written to `raw`.
 */
export function personInput({ sh, ev, until, sleep, raw, stubLog }) {
  let origin = null;
  /** Where the WebView sits on screen, in device pixels: a page's coordinates start at its top left. */
  const webviewOrigin = () => {
    if (origin) return origin;
    sh("uiautomator dump /sdcard/wp-ui.xml", 20_000);
    const found = sh("cat /sdcard/wp-ui.xml", 10_000).match(/class="android\.webkit\.WebView"[^>]*?bounds="\[(\d+),(\d+)\]/);
    if (found) { origin = { x: Number(found[1]), y: Number(found[2]) }; raw(`webview origin ${JSON.stringify(origin)}`); }
    return origin ?? { x: 0, y: 0 }; // a page that never idles has no dump: the first tap measures it instead
  };
  const armAndMeasure = (sel) => ev(`const e=document.querySelector(${sel});if(!e||!e.offsetParent)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();window.__wpTap=null;if(!window.__wpTapOn){window.__wpTapOn=1;addEventListener('pointerdown',(p)=>{window.__wpTap=p},true);}return{x:r.left+r.width/2,y:r.top+r.height/2,dpr:devicePixelRatio}`);
  const readTap = (sel) => until(() => ev(`const p=window.__wpTap;if(!p)return null;return{x:p.clientX,y:p.clientY,trusted:p.isTrusted,inside:!!p.target.closest(${sel}),on:p.target.tagName+'.'+String(p.target.className).slice(0,40)}`), 5000, 150);
  const tap = async (selector) => {
    const sel = JSON.stringify(selector);
    for (let attempt = 0; ; attempt++) {
      const at = webviewOrigin();
      const box = await armAndMeasure(sel);
      if (!box || box.__error) throw new Error(`nothing visible matches ${selector}: ${JSON.stringify(box)}`);
      sh(`input tap ${Math.round(at.x + box.x * box.dpr)} ${Math.round(at.y + box.y * box.dpr)}`);
      const landed = await readTap(sel);
      raw(`tap ${selector}: ${JSON.stringify(landed)}`);
      if (landed?.trusted && landed.inside) return landed;
      if (attempt > 0 || origin || !landed?.trusted) throw new Error(`the tap on ${selector} did not land on it: ${JSON.stringify(landed)}`);
      origin = { x: Math.round((box.x - landed.x) * box.dpr), y: Math.round((box.y - landed.y) * box.dpr) };
      raw(`webview origin measured from the first tap ${JSON.stringify(origin)}`);
    }
  };
  const composerValue = () => ev(`const t=document.querySelector(${JSON.stringify(COMPOSER)});return t?t.value:null`);

  /** Type `words` (letters and spaces) and send them; resolves to what happened, for the caller to check. */
  const prompt = async (words) => {
    await tap(COMPOSER);
    const focused = await until(async () => (await ev(`return document.activeElement===document.querySelector(${JSON.stringify(COMPOSER)})`)) === true, 5000, 150);
    sh(`input text ${words.replace(/ /g, "%s")}`, 30_000);
    const typed = await until(async () => (await composerValue()) === words, 15_000, 200);
    const box = await composerValue();
    await sleep(1200); // the keyboard has moved the bar: the button is read where it is now
    // The "newer build is ready" bar floats over the bottom of the screen and can sit on Send. What a
    // person does is close it, so this does too, and the result says it had to.
    const covered = await ev(`const r=document.querySelector(${JSON.stringify(SEND)}).getBoundingClientRect();return !!document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('.staged-bar')`);
    if (covered === true) { await tap(".staged-bar-x"); await sleep(1200); }
    const send = await tap(SEND);
    // Send during a running turn asks "now or when it's free?" and keeps the words in the box until it is
    // answered. A session just opened can read as working for its first seconds. A person answers it.
    await sleep(1500);
    const asked = (await ev("return document.querySelector('.confirm-modal .bl-modal-title')?.innerText??null")) ?? null;
    if (asked) await tap(".confirm-modal .confirm-go");
    const reached = !!(await until(() => paneHas(words), 20_000, 500));
    const submitted = !!(await until(() => submittedTo(stubLog(), words), 20_000, 500));
    const left = await composerValue();
    // The phone's own receipt, read before anything closes the session: the row must leave the queue.
    const settled = !!(await until(async () => !QUEUE_WORDS.test(await ev("return document.body.innerText")), 30_000, 700));
    const said = String(await ev("return document.body.innerText")).split("\n").find((l) => QUEUE_WORDS.test(l)) ?? null;
    const result = { focused: !!focused, typed: !!typed, box, covered: covered === true, send, asked, reached, submitted, left, settled, said };
    raw(`prompt ${JSON.stringify(words)}: ${JSON.stringify(result)}`);
    if (!reached) raw("page when the words did not arrive:\n" + String(await ev("return document.body.innerText")).slice(0, 1800));
    return result;
  };
  return { tap, prompt, composerValue };
}

/** Close every live session as the phone would, so the next page opens on the repo list. */
export async function closeSessions(port, protocol) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [protocol]);
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  const list = new Promise((res) => ws.on("message", (m) => { const j = JSON.parse(m.toString()); if (j.t === "session.list") res(j.sessions); }));
  ws.send(JSON.stringify({ t: "session.remove", id: "no-such-session" })); // answered with the list
  const sessions = await list;
  for (const s of sessions) ws.send(JSON.stringify({ t: "session.kill", id: s.id }));
  await new Promise((r) => setTimeout(r, 1500));
  ws.close();
  return sessions.length;
}

export const delivered = (r) => r.focused && r.typed && r.reached && r.submitted && r.left === "" && r.settled;
