/**
 * **"Your code is about to leave this machine" — said once, on this device,
 * before the first session that would actually do it.**
 *
 * ── The hole this closes ────────────────────────────────────────────────────
 *
 * `ModelField` already carries a non-dismissible hosted disclaimer, and it is
 * the right control to carry it: it is where somebody browses models and picks
 * one. But it is a SETTINGS surface. The new-session defaults are chosen once
 * and then never looked at again — that is the entire point of a default — and
 * `waterplane.launchAsk` is OFF by default, so the ordinary shape of this app is:
 * pick a hosted model on a Tuesday, and every launch from then on is a tap on a
 * repo row with no model control anywhere on the path. From that tap the agent
 * starts reading files and sending them to somebody else's servers, and the
 * last time anything on screen said so was a Tuesday.
 *
 * So the disclaimer needed a second home that is not a picker: one
 * acknowledgement, keyed to the WORDS that were shown, collected on the launch
 * itself. After that it never appears again until the words change.
 *
 * ── Nothing here applies itself ─────────────────────────────────────────────
 *
 * This is a person's acknowledgement, collected client-side, and it is the only
 * thing it is. The host NEVER refuses a spawn over it; there is no wire field,
 * no server-side record, and no way for an un-acked device to be blocked from
 * anything. A queued create that drains from another phone is not gated by this
 * phone's answer. It is a sentence somebody read, not a permission.
 *
 * ── The load-bearing rule: unknown is NEVER folded into hosted ──────────────
 *
 * `BackendInfo.models.where` is a MAP and not a boolean precisely so that
 * "somewhere else" and "we could not tell" stay apart (`shared/wire/backend.ts`,
 * and `modelGroups`' third bucket). Only an explicit `"hosted"` gates. Every
 * other shape answers FALSE:
 *
 *   - no map at all — claude's descriptor names no locality, and an older host
 *     sent none. Reading that silence as "hosted" would put a notice about
 *     sending source code to somebody's server in front of every single claude
 *     launch on every desktop that predates the field.
 *   - no model in the launch — the backend's own default. Unknown, see below.
 *   - `"local"` — the model on the desk. Gating it would be a lie.
 *   - `"unknown"`, an id the map does not name, or a value a NEWER host
 *     invented — all the same answer, because a value this build cannot read is
 *     a value this build must not interpret.
 *
 * Defaulting the other way is not a harmless over-warning: it would gate a
 * LOCAL launch behind a notice about transmitting code to a third party, which
 * is waterplane asserting something untrue in its own voice about where somebody's
 * repo went. That is the same failure `HOSTED_DISCLAIMER` is worded to avoid,
 * arrived at from the other side.
 *
 * A consequence worth naming because it is a guarantee and not an accident: a
 * claude launch and a local launch can never reach this sheet STRUCTURALLY —
 * claude's descriptor has no `where` map, and a local model's entry says
 * `"local"`. Neither depends on anybody remembering to skip it.
 *
 * ── KNOWN RESIDUAL, stated rather than closed with a false positive ─────────
 *
 * **A create queued before the `backends` frame arrives.** On a cold start —
 * a notification tap, a launch replayed the moment the socket opens — the
 * descriptor list is still `null`, so `needsHostedAck` answers false and a
 * hosted launch in that window is never asked about. That is the
 * unknown-is-never-hosted rule doing exactly what it is for (a `null` list is
 * also every claude-only desktop that has not upgraded), and the alternative —
 * holding the tap until a frame lands — would make the gate an interlock on the
 * launch path, which is the one thing it must never be. Same two-partial-covers
 * answer: `ModelField` is where the choice was made and its disclaimer does not
 * depend on a frame having arrived.
 *
 * A hosted model reached through the backend's OWN UNNAMED DEFAULT slips this
 * gate. `LaunchOpts.model` is absent, this app is not told which id the binary
 * will pick, and the only way to gate it would be to treat "no model" as hosted
 * — which is the unknown-folded-into-hosted mistake above, applied to every
 * claude session ever started. So the gate declines to guess, and that surface
 * is covered by the other half of the pair: `ModelField`'s hosted disclaimer is
 * non-dismissible and is drawn whenever the group is open or the current value
 * is hosted. Two partial covers that each degrade to silence beat one that
 * degrades to a wrong sentence.
 *
 * Pure except for the three storage helpers at the bottom, so
 * `hostedAck.test.mjs` runs it under `node --test` straight over the TypeScript.
 */
import type { LaunchOpts } from "@waterplane/shared";
import { backendInfo, type BackendList } from "./backendCaps.ts";
import { LS, lsDel, lsJson, lsSetJson } from "./storage.ts";

/**
 * The version of the TEXT that was acknowledged.
 *
 * Bump it when what the sheet SAYS changes materially — and only then. An
 * acknowledgement is a statement about words somebody read; carrying it forward
 * over different words turns a consent record into a fiction, so a bump re-asks
 * rather than inheriting. A wording tidy-up is not a bump; a new consequence is.
 */
export const HOSTED_ACK_VERSION = 1;

/** What is stored: when it was accepted, and which text version. */
export interface HostedAckRecord {
  /** Epoch ms of the acceptance, so the settings row can say when. */
  at: number;
  /** `HOSTED_ACK_VERSION` as it stood when the words were shown. */
  v: number;
}

/**
 * Should this launch stop and show the hosted notice first?
 *
 * @param list   every backend this host described, or null (old desktop).
 * @param launch the launch that is ABOUT TO RUN — the answered one where the
 *               per-launch ask fired, the caller's own otherwise. Never the
 *               stored defaults when those are not what will be sent.
 * @param acked  what this device has on file, or null.
 */
export function needsHostedAck(
  list: BackendList,
  launch: LaunchOpts | null | undefined,
  acked: { v: number } | null | undefined,
): boolean {
  // Already agreed to THESE words. A record at any other version — older, or
  // one a newer bundle wrote — falls through and asks again, which is the
  // direction that cannot silently inherit an agreement to something else.
  if (acked?.v === HOSTED_ACK_VERSION) return false;
  const model = launch?.model;
  if (!model) return false; // the backend's own default — see the residual above
  const where = backendInfo(list, launch?.backend)?.models.where;
  if (!where) return false; // claude, an old host, a probe that could not say
  // The ONE gating value. Not `!== "local"`, which would sweep up unknown and
  // anything a later host invents.
  return where[model] === "hosted";
}

/** What this device has on file, or null. Never throws — `storage.ts` owns the
 *  private-mode and quota swallowing. */
export function readHostedAck(): HostedAckRecord | null {
  const r = lsJson<HostedAckRecord | null>(LS.hostedAck, null);
  return r && typeof r.v === "number" ? r : null;
}

/** Record the acceptance, stamped with the version of the text that was shown.
 *  Written BEFORE the deferred launch is resumed, or the launch re-enters the
 *  gate and asks a second time for the same tap. */
export function writeHostedAck(now = Date.now()): HostedAckRecord {
  const r: HostedAckRecord = { at: now, v: HOSTED_ACK_VERSION };
  lsSetJson(LS.hostedAck, r);
  return r;
}

/** Forget it, so the next hosted launch asks again. The settings row's whole
 *  job — a person may want to re-read what they agreed to, or hand the phone to
 *  somebody who has agreed to nothing. */
export function clearHostedAck(): void {
  lsDel(LS.hostedAck);
}
