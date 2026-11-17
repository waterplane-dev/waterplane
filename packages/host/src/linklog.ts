/**
 * A timestamped record of the APK's background link, the socket that carries
 * an approval or a prompt to a phone whose app is not on screen.
 *
 * `netstats.ts` COUNTS sockets. That cannot answer "the fingerprint card came
 * a minute late — was the link down?", which needs WHEN: when the link
 * dropped, when it came back, and when an alert went out with no link open to
 * carry it. The host log has no timestamps, so this writes its own: one JSON
 * line per event in `<state dir>/link-events.jsonl` (rotated at 256 KB) and a
 * console line with an ISO time.
 *
 * The PHONE's side arrives as `phone` rows: the APK's `ShellLinkLog` keeps a ring of what
 * its link saw (dial, open, fail, close, the retry wait, network up/lost, an alert shown) and
 * sends it in one `link.log` frame per reconnect; each row is written with `at` moved onto
 * this host's clock (`cleanLinkLog`) and the skew beside it, so both sides sort together.
 *
 * Only sockets with a non-full role (`notify`, `relay`) are recorded; a page's
 * socket opening and closing as the app goes in and out of view would bury the
 * link in noise. Logging never throws into the socket path.
 */
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { logTag, cleanLinkLog } from "@waterplane/shared";
import { keepLastLines } from "./jsonstore.js";
import { hostStateDir } from "./branddirs.js";

export const LINK_LOG = "link-events.jsonl";
const ROTATE_BYTES = 256 * 1024;
const KEEP_LINES = 2000;

export type LinkEvent =
  | { ev: "open"; role: string; via: "user-agent" | "hello"; device?: string; peer?: string }
  | { ev: "close"; role: string; code: number; openMs: number; device?: string }
  /** An attention alert went out; `links` is how many background links were open to carry it (0 ⇒ none). */
  | { ev: "alert"; kind: string; plugin?: string; links: number }
  /** What the phone's link saw, `what` its word (`LinkLogEvent.ev`), `at` already on this host's clock. */
  | { ev: "phone"; what: string; d?: string; device?: string; skewMs: number };

export type LinkLog = ReturnType<typeof createLinkLog>;

/** The link log for one host; `root` absent ⇒ console only (tests). `main.ts` builds it at boot. */
export function createLinkLog(root: string | undefined, clock: () => number = Date.now) {
  /** When each recorded link opened, for the `openMs` on its close. */
  const openedAt = new WeakMap<object, number>();

  function append(lines: string[]): void {
    if (!root || !lines.length) return;
    const dir = hostStateDir(root);
    const file = join(dir, LINK_LOG);
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, lines.join(""));
    if (statSync(file).size > ROTATE_BYTES) keepLastLines(file, KEEP_LINES);
  }

  /** Appends one event (with `at`) to the log and the console. */
  function event(e: LinkEvent): void {
    try {
      const at = new Date(clock()).toISOString();
      const parts = Object.entries(e).filter(([k, v]) => k !== "ev" && v !== undefined).map(([k, v]) => `${k}=${v}`);
      console.log(`${logTag} ${at} link ${e.ev} · ${parts.join(" ")}`);
      append([JSON.stringify({ at, ...e }) + "\n"]);
    } catch { /* logging must never break the host */ }
  }

  /** A `link.log` frame from a phone's background link: each event one `phone` row, on this
   *  host's clock; one console line for the batch. Returns how many rows were written. */
  function phone(device: string | undefined, raw: unknown, sentAt: unknown): number {
    try {
      const { skewMs, events } = cleanLinkLog(raw, sentAt, clock());
      if (!events.length) return 0;
      const rows = events.map((e) => {
        const row: { at: string } & LinkEvent = { at: new Date(e.at).toISOString(), ev: "phone", what: e.ev, d: e.d, device, skewMs };
        return JSON.stringify(row) + "\n";
      });
      console.log(`${logTag} ${new Date(clock()).toISOString()} link phone · ${events.length} event(s) device=${device ?? "-"} skewMs=${skewMs}`);
      append(rows);
      return events.length;
    } catch { return 0; /* logging must never break the host */ }
  }

  /** A socket became a background link: record it and remember when (a second call for the same socket is ignored). */
  function opened(ws: object, e: Omit<Extract<LinkEvent, { ev: "open" }>, "ev">): void {
    if (openedAt.has(ws)) return;
    openedAt.set(ws, clock());
    event({ ev: "open", ...e });
  }

  /** A socket closed: recorded only if it had been recorded as a background link. */
  function closed(ws: object, e: { role: string | undefined; code: number; device?: string }): void {
    const at = openedAt.get(ws);
    if (at === undefined) return;
    openedAt.delete(ws);
    event({ ev: "close", role: e.role ?? "unknown", code: e.code, openMs: clock() - at, device: e.device });
  }

  return { event, opened, closed, phone };
}
