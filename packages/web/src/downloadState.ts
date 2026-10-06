/**
 * **What a download button says, and what a tap on it does** — as pure rules.
 *
 * Split out of `download.ts` (which owns the transfers and the toasts) for the
 * same reason `contextPlot.ts` is split out of its chart: this half is the part
 * that is easy to get subtly wrong and impossible to notice — a button that
 * offers *download* for a file already on the phone, one that says *save* for
 * bytes that were evicted last week, or a *retry* that quietly starts a second
 * copy of a transfer already running.  `node --test` pins all of it with no
 * DOM, and no BUTTON re-derives any of these sentences (a queue row adds what
 * only a clock can know: a rate, an ETA, a countdown to the next attempt).
 *
 * One vocabulary, so the gallery, the build sheet, a notification and the
 * Downloads sheet cannot word the same state four ways.
 */
import type { PullRecord } from "./pull";

/** Where a file is, from the button's point of view. */
export type DownloadPhase =
  /** Not on this phone (or its bytes were evicted): a tap starts the transfer. */
  | "idle"
  /** Waiting its turn, backing off, or paused. */
  | "queued"
  /** Bytes are moving right now. */
  | "downloading"
  /** Every attempt failed; a tap tries again from where it stopped. */
  | "failed"
  /** Downloaded, but not yet handed to the phone's own file storage. */
  | "have"
  /** Downloaded AND saved out; the row can say where it went. */
  | "saved";

export interface DownloadStatus {
  phase: DownloadPhase;
  /** 0..100 when some of the file is here, else null. Never a percentage of
   *  nothing: "0%" and "we have no idea yet" are different claims. */
  pct: number | null;
  /** Button label. Imperative when a tap does something, descriptive when the
   *  button is reporting on work already in flight. */
  label: string;
  /** The longer sentence — a title, a hint, the row's own status line. */
  detail: string;
}

/** What a tap should DO. Kept as data so the decision is testable and the
 *  performing half (`download.ts`) holds no policy. */
export type DownloadAction =
  /** Start (or resume) the transfer. */
  | "start"
  /** Hand the bytes already here to the phone. */
  | "save"
  /** It is already moving — show the queue rather than poking it. */
  | "open";

function percent(rec: PullRecord): number {
  const total = rec.item.size || rec.received;
  return total > 0 ? Math.min(100, Math.round((rec.received / total) * 100)) : 0;
}

export function downloadStatus(rec: PullRecord | undefined): DownloadStatus {
  // An evicted record IS a download that happened — but the bytes are gone, so
  // the only honest offer is to fetch it again.
  if (!rec || (rec.state === "done" && rec.evicted)) {
    return {
      phase: "idle", pct: null, label: "download",
      detail: rec?.evicted
        ? "downloaded before — the bytes were cleared to save space; fetch it again"
        : "fetch it to this phone — it resumes by itself if the link drops",
    };
  }
  const pct = percent(rec);
  if (rec.state === "downloading") {
    return { phase: "downloading", pct, label: `downloading · ${pct}%`, detail: "open Downloads to watch, pause or cancel it" };
  }
  if (rec.state === "queued" || rec.state === "paused") {
    return {
      phase: "queued",
      pct: rec.received > 0 ? pct : null,
      label: rec.state === "paused" ? "paused" : "queued",
      detail: rec.received > 0
        ? `${pct}% is already here — it resumes from there`
        : "waiting its turn — open Downloads",
    };
  }
  if (rec.state === "failed") {
    return {
      phase: "failed", pct: rec.received > 0 ? pct : null, label: "retry download",
      detail: rec.error ? `the last attempt failed: ${rec.error}` : "the last attempt failed",
    };
  }
  // done, bytes present
  if (rec.savedAt && !rec.saveError) {
    // "Handed to the browser" is not "landed": a programmatic download the
    // browser could not tie to a gesture is refused SILENTLY, and this row is
    // the only place that could be honest about it. The bytes are still here
    // either way, so the offer to hand them over again stands.
    if (rec.saveVia === "browser") {
      return {
        phase: "saved", pct: 100, label: "save again",
        detail: `on this phone · handed to ${rec.savedTo} — tap to hand it over again if it never arrived`,
      };
    }
    // The folder was ASKED (`pull.ts`'s `verifySaved`), and answered.
    if (rec.savedPresent === true) {
      return {
        phase: "saved", pct: 100, label: "in Downloads",
        detail: `in ${rec.savedTo} · nothing to do — a second save would only make another copy beside it`,
      };
    }
    if (rec.savedPresent === false) {
      return {
        phase: "saved", pct: 100, label: "save again",
        detail: `it was saved to ${rec.savedTo}, and is not in Downloads any more · still on this phone — tap to put it back`,
      };
    }
    // Nobody could ask: a browser, or an APK whose plugin predates `find`.
    // Say what was done, never where the file is now.
    return {
      phase: "saved", pct: 100, label: "save again",
      detail: `on this phone · saved to ${rec.savedTo}`,
    };
  }
  // Handed over, and the phone has not answered yet. A separate sentence from
  // both of the others, because it is a separate fact: `saveError` is read
  // everywhere as *the save failed*, and the wait that ends here is BOUNDED —
  // an answer that did not arrive in eight seconds is not a failure, and the
  // file is very often in Downloads by the time this is read.
  if (rec.saveHandedAt && !rec.saveError) {
    return {
      phase: "have", pct: 100, label: "check Downloads",
      detail: "on this phone · handed to Downloads, and the phone has not said where it went — open Downloads to look",
    };
  }
  return {
    phase: "have", pct: 100, label: "save to phone",
    detail: rec.saveError
      ? `on this phone — saving it out failed: ${rec.saveError}`
      : "on this phone — put it where a file manager can see it",
  };
}

/**
 * What a tap on that button means, given the same record.
 *
 * The one case worth stating: a file the folder confirms is THERE is not an
 * offer to save. MediaStore does not overwrite, it renames, so "save" on a
 * file already in Downloads makes `app-debug (6).apk` beside the five that
 * came before it — which is what the button did, every time, because nothing
 * ever asked the folder.
 */
export function downloadAction(rec: PullRecord | undefined): DownloadAction {
  const { phase } = downloadStatus(rec);
  if (phase === "saved" && rec?.savedPresent === true) return "open";
  if (phase === "have" || phase === "saved") return "save";
  if (phase === "downloading" || phase === "queued") return "open";
  return "start";
}

/**
 * Should the automatic hand-off put this finished download into Downloads?
 *
 * `autoSave` is set by a tap (`download.ts`); `all` is the preference that says
 * every finished download goes to the folder, tap or not — which is what a
 * person who turned auto-download ON meant by it, and the whole reason the save
 * button existed to be pressed 28 times.
 *
 * The four refusals are each a way of saving the same file twice: bytes that
 * are gone, a save already reported, a save that already FAILED and would
 * otherwise retry itself on every repaint of the queue, and one the phone has
 * been handed and not yet answered for. A record the folder
 * says is present is likewise finished business.
 */
export function autoSaveEligible(rec: PullRecord, all: boolean): boolean {
  if (rec.state !== "done" || rec.evicted) return false;
  if (!rec.autoSave && !all) return false;
  if (rec.savedAt || rec.saveError) return false;
  // Already handed over and still unanswered. Not a failure — see
  // `downloadStatus` — but equally finished business for the automatic pump,
  // which would otherwise re-publish the same file on the next repaint and make
  // the second copy MediaStore renames rather than overwrites.
  if (rec.saveHandedAt) return false;
  return true;
}

/**
 * Must a tap on an EXISTING record actually put the transfer back in the queue?
 *
 * The trap this exists for: an evicted record is `done` — it WAS downloaded —
 * so a "not done ⇒ retry" test silently declines to fetch it, the pump only
 * ever picks `queued`, and the button toasts "downloading…" over a row that
 * will never move. Kept here, beside the label that promises the same thing, so
 * the two are pinned by one test rather than agreeing by luck.
 */
export function needsFetch(rec: PullRecord): boolean {
  if (rec.state === "downloading") return false;      // already moving; a second start is the bug
  if (rec.state === "done") return !!rec.evicted;     // bytes here ⇒ nothing to fetch
  return true;                                        // queued (kick it), paused, failed
}

/**
 * Is this record the file a caller is asking about?
 *
 * `exact` = the same repo, path AND mtime — one version of one file, which is
 * what the host's own `pullId` keys on. `loose` = the same repo and path where
 * one side does not KNOW the mtime; a notification carries none, and refusing
 * to match would start a second transfer of the file the phone is already
 * fetching. What must never be `loose` is two sides that both know an mtime and
 * disagree: that is a REBUILT artifact, and treating it as the same row is how
 * "download" hands over last week's APK and calls it today's.
 */
export function fileMatch(
  rec: PullRecord,
  repoId: string,
  relPath: string,
  mtime?: number,
): "exact" | "loose" | null {
  if (rec.item.repoId !== repoId || rec.item.relPath !== relPath) return null;
  const want = Math.round(mtime ?? 0);
  const have = Math.round(rec.item.mtime ?? 0);
  if (want && have) return want === have ? "exact" : null;
  // The caller has no mtime (a notification, a file a prompt named): it cannot
  // tell versions apart, so the row it means is the row for that path.
  if (!want) return "loose";
  // The RECORD has none, and the caller does. While the transfer is still
  // unfinished the bytes are whatever the host is serving now, so this is that
  // file and adopting the mtime is right. Once it is DONE the bytes are frozen
  // at some unknown moment: claiming they are this version is how a tap on
  // today's build hands over last week's, and how the grid then marks today's
  // file "downloaded". Unknown vintage ⇒ a different file, fetched fresh.
  return rec.state === "done" && !rec.evicted ? null : "loose";
}

/**
 * Would `sync()` keep this record when the host's queue no longer names it?
 *
 * Three keeps, three different reasons: a `local` row is this device's own ask
 * and not the host's to withdraw; a `done` row holds the bytes you came for;
 * and the running one must not be yanked out from under its own transfer.
 */
export function syncKeeps(rec: PullRecord, liveOnHost: boolean, isActive: boolean): boolean {
  return liveOnHost || !!rec.local || rec.state === "done" || isActive;
}

/**
 * May the pump start this record right now?
 *
 * The auto switch governs what the HOST queued on its own. A file a person
 * tapped is not unattended work, so a `local` row runs with the switch off —
 * otherwise "download" started once and then sat still for ever the first time
 * the link blinked. `force` is a tap, and outranks the backoff as well.
 */
/**
 * A row that CLAIMS to be downloading while nothing is carrying it.
 *
 * `state: "downloading"` is a claim about an engine, and the engine lives
 * somewhere this record cannot see: in the page (`rangeFetch`, tracked by the
 * in-memory `active`), in the browser (Background Fetch), or in the native
 * service (`nativeOwned`). Lose the carrier and the record is stranded — and it
 * is stranded in the one state nothing will ever pick up again, because
 * `pumpEligible` only takes `queued`, `watchdog` returns early when there is no
 * `active`, and `whyIdle` only inspects queued/paused/failed. The row then reads
 * "waiting to start" for ever with nothing anywhere to act on, which is exactly
 * how it was reported: a 24 MB APK at `0 B of 24.4 MB`, three hours old.
 *
 * `start()` already unstrands these at BOOT. This is the same question asked
 * while the page is still running, so the answer is "it fixes itself on the next
 * heartbeat" rather than "restart the app".
 *
 * `bgLive` is the caller's answer to "is the browser still carrying this one" —
 * asked of the Background Fetch registration, not guessed here, because a false
 * yes strands the row for another page-life and a false no starts a second copy
 * of a live transfer.
 */
export function strandedDownload(
  rec: PullRecord | undefined,
  opts: { activeId: string | null; bgLive?: boolean; nativeSupported?: boolean },
): boolean {
  if (!rec || rec.state !== "downloading") return false;
  if (opts.activeId === rec.item.id) return false;        // this page is running it
  if (rec.nativeOwned) return false;                       // the service holds it
  // A native transfer outlives the page by design; only say it is stranded once
  // the platform that would be carrying it is not even there.
  if (rec.engine === "native" && opts.nativeSupported !== false) return false;
  if (rec.engine === "bgfetch" && opts.bgLive !== false) return false;
  return true;
}

export function pumpEligible(
  rec: PullRecord | undefined,
  opts: { auto: boolean; force: boolean; maxAttempts: number; now: number },
): boolean {
  if (!rec || rec.state !== "queued") return false;
  // A row the native download service already holds is not this page's to
  // start, and this one is NOT waived by `force`: the service's enqueue is
  // idempotent but clears the give-up count, so a tap that re-hands a row
  // backing off is fine (that is what `retry` does, by clearing the flag first)
  // while a pump that does it every heartbeat forgives every attempt and makes
  // a dead link retry for ever.
  if (rec.nativeOwned) return false;
  if (!opts.force && !opts.auto && !rec.local) return false;
  if (!opts.force && rec.attempts >= opts.maxAttempts) return false;
  if (!opts.force && rec.nextRetryAt && rec.nextRetryAt > opts.now) return false;
  return true;
}

/**
 * Does this phone actually have NO network?
 *
 * `navigator.onLine` is the only offline signal a browser offers and it is a
 * poor one: the file above already says a phone on 5G reports `true` while the
 * Tailscale path is dead, which is why it gates nothing on its own. The
 * opposite error is what this function exists for — in the Android WebView
 * (and behind a VPN interface that comes up after the page loads) it goes
 * STALE at `false` while the socket is carrying traffic, and the download
 * queue then sat at "waiting to start" saying *the phone reports no network*
 * with the header a centimetre above it showing a 17 ms round trip. Every tap
 * on the row started the transfer immediately, which is what a false claim of
 * being offline looks like from the outside: a button that is "broken" until
 * you press it.
 *
 * So `onLine: false` is a SUSPICION, and an open socket REFUTES it: bytes are
 * moving over that link this second. The two together are the only thing this
 * device may call offline — a closed socket beside a browser that claims to be
 * online stays "online" here, because a dead host is not a dead phone and the
 * attempt is what tells the difference.
 */
export function noNetwork(navOnline: boolean, linkOpen: boolean): boolean {
  return !navOnline && !linkOpen;
}
