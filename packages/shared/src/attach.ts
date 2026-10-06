/**
 * What became of the FILES a prompt names.
 *
 * A prompt written on a phone routinely says "look at
 * `.claude/inbox/1000074539-mtjv8u52a489a0.jpg`". That path is minted BEFORE the
 * bytes go anywhere (`plannedInboxPath`), because the text and the attachment are
 * queued in the same breath — so between writing it and sending it the file can
 * be in any of five states, and the path itself says nothing about which. Worse,
 * the name is a camera counter plus a random suffix: it does not even tell the
 * person who took the photo WHICH photo it was.
 *
 * That gap is where prompts died quietly. A send that gave up left its text in
 * the queue — its own row, its full words, `retireToPad` having been deleted —
 * naming an upload that had been canceled and its bytes deleted, so re-sending
 * it pointed the agent at a file nobody was ever going to write. Nothing on screen distinguished that from a prompt whose image
 * is already sitting in the repo.
 *
 * So the decision is made here, from facts rather than hope, and it is pure: the
 * caller gathers what it can see (the host's own listing, the send queue, the
 * bytes still parked on this device, the paths already known dead) and this says
 * what may be done about each file. Pinned by `scripts/e2e-attach.mjs` —
 * every branch is a different sentence in the UI and a different button.
 */

/**
 * What can still happen to one referenced file.
 *
 * Ordered by how good the news is, which is also the order the rules are applied
 * in: the host having the file outranks everything, including a local record
 * saying the upload died — a canceled upload and a file that arrived by some
 * other route (the agent wrote it, an earlier attempt DID land, a second device
 * sent it) are indistinguishable from here, and the one that can be checked wins.
 */
export type AttachState =
  /** The repo has it. The prompt is sendable as written. */
  | "host"
  /** Its bytes are in the send queue — it uploads before the prompt that names
   *  it (the lane rule), so this is also sendable, just not yet arrived. */
  | "sending"
  /** Its queue entry is gone but the bytes are still on THIS device: one tap
   *  re-queues the upload, and the path in the text stays valid. */
  | "kept"
  /** Something recorded why it is never coming (the upload was canceled, the
   *  host refused the file) and there are no bytes left to retry with. */
  | "dead"
  /** The host was asked and does not have it, and nothing local knows about it.
   *  Usually a path that outlived its upload on another device, or a hand-typed
   *  one that was always wrong. */
  | "missing"
  /** The host could not be asked (no link) and nothing local knows about it.
   *  Not the same as missing, and must not be reported as it. */
  | "unknown";

/** Everything the caller could find out about the files in one repo. */
export interface AttachFacts {
  /**
   * Repo-relative paths the host's own listing reported, or `null` when it could
   * not be asked at all. `null` is the whole reason `unknown` exists: an empty
   * array means "asked, it has none", which is a verdict, and conflating the two
   * turns a dead tunnel into "your image is gone".
   */
  onHost: string[] | null;
  /** Paths whose upload entry is still in the send queue (queued or in flight). */
  sending: string[];
  /** Paths whose bytes are retained on this device with no queue entry left. */
  kept: string[];
  /** Path → why it will never arrive, as recorded when its entry died. */
  dead: Record<string, string>;
}

export interface AttachStatus {
  relPath: string;
  state: AttachState;
  /** The recorded reason, for the states that have one (`dead`). */
  why?: string;
}

/** Where one referenced file stands. See `AttachState` for the ordering. */
export function attachState(relPath: string, f: AttachFacts): AttachState {
  if (f.onHost?.includes(relPath)) return "host";
  if (f.sending.includes(relPath)) return "sending";
  if (f.kept.includes(relPath)) return "kept";
  if (f.dead[relPath]) return "dead";
  return f.onHost === null ? "unknown" : "missing";
}

/** The same for a whole prompt's worth of paths, in the order they were named. */
export function attachStatuses(relPaths: string[], f: AttachFacts): AttachStatus[] {
  return relPaths.map((relPath) => {
    const state = attachState(relPath, f);
    return state === "dead" ? { relPath, state, why: f.dead[relPath] } : { relPath, state };
  });
}

/**
 * May this prompt be sent as written?
 *
 * Only when every file it names will exist by the time the agent reads it —
 * already there, or queued ahead of the prompt in the same lane. `kept` is
 * deliberately NOT sendable: the bytes are on the phone, but nothing is
 * uploading them, and a prompt sent now would race a re-attach that has not
 * been asked for. It is one tap from sendable, which is what the UI offers.
 */
export function attachmentsReady(states: AttachStatus[]): boolean {
  return states.every((s) => s.state === "host" || s.state === "sending");
}

/**
 * The states that need a decision before sending, in the order they should be
 * shown: the fixable one first (there is something to press), then the two that
 * can only be dropped, then the one that is merely unverified.
 *
 * A prompt with no blockers is sendable; one with blockers is exactly the case
 * "edit as new prompt" exists for.
 */
export function attachBlockers(states: AttachStatus[]): AttachStatus[] {
  const rank: Record<string, number> = { kept: 0, dead: 1, missing: 2, unknown: 3 };
  return states.filter((s) => s.state in rank).sort((a, b) => rank[a.state] - rank[b.state]);
}
