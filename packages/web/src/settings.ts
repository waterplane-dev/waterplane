/**
 * The client half of "settings follow the user, not the browser".
 *
 * The keys and the reasoning are in `@waterplane/shared`'s `settings.ts`; this is the
 * runtime. Two decisions shape it:
 *
 * **localStorage is PATCHED, not wrapped.** Snippets, presets, header commands,
 * the toolbar config, launch flags and the pad are read and written from a
 * dozen places across `App.tsx` and five sheets, and new ones land regularly —
 * `headerCmds.ts` was added by copying `presets.ts` wholesale. A rule that only
 * holds where somebody remembered to call `syncedSet()` is a rule that breaks
 * silently three edits later, on the device you are not holding. Patching
 * `localStorage.setItem`/`removeItem` once at boot makes a `localStorage.setItem
 * (LS.snippets, …)` written next month correct the day it is written. This
 * is the same argument `hostUrl.ts` makes for patching `fetch`, and it is the
 * same trade: one surprising indirection in exchange for a rule that cannot be
 * forgotten.
 *
 * **The merge is last-write-wins on a timestamp this device stamps.** Local
 * write times live in `waterplane.syncTs` next to the values themselves. On every
 * `settings.all` (sent unprompted on hello, so: every reconnect) each key is
 * compared and the newer side wins — which is also what pushes writes made
 * while the tunnel was down, with no queue of its own.
 *
 * Adopting a remote value fires a `app:settings` window event carrying the
 * key. Components hold these in React state seeded at mount, so without it a
 * template written on the phone would sit in localStorage on the desktop and
 * appear at the next reload — which is the behaviour this replaces.
 */
import { noteLocalWrite, noteSuperseded, noteSynced } from "./syncState";
// The two push rules, stated where a node test can run them — this file patches
// `localStorage` and cannot be imported without a browser.
import { aheadValue, repushAfterAdopt } from "./settingsPush";
import { SYNCED_SETTING_KEYS, isSyncedKey, type ClientMessage, type SettingsDoc } from "@waterplane/shared";
import { deviceId } from "./link";
import { LS } from "./storage";

/** Where this device records WHEN it last wrote each synced key. */
const TS_KEY = LS.syncTs;
/**
 * Push debounce. The pad is written on every keystroke, and one socket frame
 * per character would be a genuinely bad idea on the link this app is for.
 */
const PUSH_DEBOUNCE_MS = 600;
/** Fired on the window whenever a remote value replaced a local one. */
export const SETTINGS_EVENT = "app:settings";

type Sender = (msg: ClientMessage) => void;

let send: Sender | null = null;
/** True while a REMOTE value is being written, so the patch doesn't echo it back. */
let applying = false;
let installed = false;
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();

function readTs(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(TS_KEY) || "{}") as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    return out;
  } catch { return {}; }
}

function writeTs(key: string, ts: number): void {
  try {
    const map = readTs();
    map[key] = ts;
    localStorage.setItem(TS_KEY, JSON.stringify(map));
  } catch { /* private mode — sync degrades to per-device, like everything else */ }
}

/** What this device currently holds. `null` = the key is not set here. */
function localValue(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/**
 * Told just before a REMOTE value replaces this device's copy of a key — and
 * allowed to say what should be written INSTEAD.
 *
 * Last-write-wins is right for a preference and lossy for a list: the whole
 * value is replaced, so a device pushing its pad replaced every note the other
 * one held. A store that cannot afford that registers here and returns the
 * MERGE of the two copies (the pad, in `outbox.ts` — the rule itself is
 * `shared/pad.ts`'s). Returning nothing means "just write what arrived", which
 * is what every other key does by not registering at all.
 *
 * A callback, not an import, because the owner of the store imports THIS file
 * (`announceSetting`) and the dependency must not run both ways.
 */
export type AdoptGuard = (incoming: string, current: string | null) => string | void;
const adoptGuards = new Map<string, AdoptGuard>();
export function onAdopt(key: string, fn: AdoptGuard): void { adoptGuards.set(key, fn); }

/**
 * Write a value with the patch held off — and say whether it LANDED.
 *
 * The answer is the whole point: everything that follows a write here decides
 * what to put on the wire, and `localStorage.setItem` throws on quota. A push
 * that assumes a write it did not get sends the value this device still holds,
 * which is the OLDER one, under a newer stamp. `wrote` is taken inside the
 * `try`, immediately after the store accepted it, and nowhere else.
 */
function writeWithoutEcho(key: string, final: string, ts: number): boolean {
  applying = true;
  let wrote = false;
  try {
    // The empty string is how a REMOVAL travels: `resetPresets()` and
    // `resetHeaderCmds()` delete the key so the shipped defaults come back, and
    // a delete that didn't sync would be undone by the next device to push.
    if (final === "") localStorage.removeItem(key);
    else localStorage.setItem(key, final);
    wrote = true;
    writeTs(key, ts);
  } catch { /* private mode */ } finally { applying = false; }
  return wrote;
}

/** Write a value the HOST won, without the patch pushing it straight back. */
function applyLocally(key: string, value: string, ts: number): void {
  const guard = adoptGuards.get(key);
  // Before the write, never after: the guard's whole job is to read what this
  // device is about to stop holding. It must not be able to break the merge —
  // a throwing guard falls back to the plain adoption rather than leaving the
  // two sides permanently out of step.
  let out: string | void = undefined;
  if (guard) { try { out = guard(value, localValue(key)); } catch { /* a merge is best effort */ } }
  const final = typeof out === "string" ? out : value;
  const wrote = writeWithoutEcho(key, final, ts);
  // The guard merged something in, so this device now holds words the host has
  // never seen. Nothing else would ever push them: the write above ran with
  // `applying` set, precisely so an adoption does not echo. Stamp it STRICTLY
  // newer than what arrived — an equal `ts` loses at the host, and a phone
  // whose clock is behind would otherwise park the merge for ever.
  // **Only if the merge actually landed** (`repushAfterAdopt`): the push reads
  // the store back, so pushing after a refused write sends the copy this device
  // failed to replace, freshly stamped, over a host copy that is newer than it.
  if (repushAfterAdopt(wrote, final, value)) {
    const stamp = Math.max(Date.now(), ts + 1);
    writeTs(key, stamp);
    noteLocalWrite(key, stamp);
    schedulePush(key);
  }
}

function pushNow(key: string): void {
  pushTimers.delete(key);
  // No sender yet (the merge can land before `App`'s install effect has run):
  // wait rather than drop, or the write this device made offline is lost on the
  // one connect that could have delivered it.
  if (!send) { schedulePush(key); return; }
  const value = localValue(key) ?? "";
  const ts = readTs()[key] ?? Date.now();
  send({ t: "settings.set", key, value, ts, device: deviceId() });
}

/**
 * Stamp a local write, push it, and RECORD that something of ours is now
 * outstanding.
 *
 * Written once because the patch below applies it in four places (instance and
 * prototype, set and remove) and the fourth is where somebody forgets. The
 * `noteLocalWrite` is what lets a screen say "this is still only on this
 * phone" — see `syncState.ts`; the confirmation half is in
 * `applyRemoteSetting` and `mergeSettingsDoc`.
 */
function stampAndPush(key: string): void {
  const ts = Date.now();
  writeTs(key, ts);
  noteLocalWrite(key, ts);
  schedulePush(key);
}

function schedulePush(key: string): void {
  const existing = pushTimers.get(key);
  if (existing) clearTimeout(existing);
  pushTimers.set(key, setTimeout(() => pushNow(key), PUSH_DEBOUNCE_MS));
}

/**
 * Patch localStorage so every write to a synced key is stamped and pushed.
 * Idempotent, and a total no-op when `localStorage` is unavailable (private
 * mode / a WebView with storage blocked) — the app already treats that as
 * "everything is per-device", which is exactly the old behaviour.
 */
export function installSettingsSync(sender: Sender): void {
  send = sender;
  if (installed) return;
  installed = true;
  let store: Storage;
  try { store = window.localStorage; } catch { return; }
  const rawSet = store.setItem.bind(store);
  const rawRemove = store.removeItem.bind(store);
  store.setItem = (key: string, value: string) => {
    rawSet(key, value);
    if (!applying && isSyncedKey(key)) { stampAndPush(key); }
  };
  store.removeItem = (key: string) => {
    rawRemove(key);
    if (!applying && isSyncedKey(key)) { stampAndPush(key); }
  };
  // If the engine refused the own-property assignment (some WebViews expose
  // `localStorage` with non-writable methods), fall back to the prototype —
  // guarded on the instance, so `sessionStorage`, which shares that prototype,
  // is untouched. A silent no-op here would look exactly like sync being off.
  if (store.setItem === rawSet) {
    const proto = Object.getPrototypeOf(store) as Storage;
    const protoSet = proto.setItem;
    const protoRemove = proto.removeItem;
    proto.setItem = function (this: Storage, key: string, value: string) {
      protoSet.call(this, key, value);
      if (this === store && !applying && isSyncedKey(key)) { stampAndPush(key); }
    };
    proto.removeItem = function (this: Storage, key: string) {
      protoRemove.call(this, key);
      if (this === store && !applying && isSyncedKey(key)) { stampAndPush(key); }
    };
  }
}

/**
 * One key changed somewhere; whoever renders it re-reads localStorage.
 *
 * Exported because a LOCAL write needs it too. The patch above stamps and
 * pushes a local write but deliberately does not announce it — the writer
 * usually holds the value in state already. The pad breaks that assumption: it
 * is written from more than one place (a rescue restored, a note dispatched)
 * while `PadSheet` may be open showing a copy read at mount, and a view that
 * shows fewer notes than exist is the screen this whole store is meant to make
 * trustworthy.
 */
export function announceSetting(key: string): void { announce(key); }
function announce(key: string): void {
  try { window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: { key } })); } catch { /* no DOM */ }
}

/**
 * Reconcile with the host's document. Called on `settings.all`, i.e. on every
 * connect — which is also what delivers writes made while the link was down.
 *
 * The one case with no right answer is a device that has never pushed (no entry
 * in `waterplane.syncTs`) holding a value the host also has: there is no timestamp to
 * compare, so the host wins. That is the correct default — the host is the
 * shared copy and the alternative is a device silently overwriting everyone
 * else's list on its first connect — but it does mean the SECOND device to
 * upgrade adopts the first one's lists. Its own values are still on disk under
 * the same keys until it writes again, and nothing here deletes them.
 */
export function mergeSettingsDoc(doc: SettingsDoc): void {
  const ts = readTs();
  for (const key of SYNCED_SETTING_KEYS) {
    const remote = doc[key];
    const localTs = ts[key] ?? 0;
    const value = localValue(key);
    if (remote && remote.ts > localTs) {
      if (remote.value !== (value ?? "")) { applyLocally(key, remote.value, remote.ts); noteSuperseded(key, remote.ts); announce(key); }
      else { writeTs(key, remote.ts); noteSynced(key, remote.ts); } // same content, just record that we're current
      continue;
    }
    // The host holds exactly what we hold: nothing of ours is outstanding.
    // This is also what makes a COLD START honest — `settings.all` arrives on
    // every connect, so the reload window in which `syncState` answers
    // `unknown` closes off the source rather than off a stored guess.
    if (remote && remote.ts === localTs) noteSynced(key, remote.ts);
    // We are ahead (or the host has never heard of this key and we hold
    // something): push. A first-ever push with no recorded time is stamped now.
    if (value != null && (!remote || localTs > remote.ts)) {
      let stamp = ts[key] || Date.now();
      if (!ts[key]) writeTs(key, stamp);
      // Ahead is not the same as complete. For a key with an adopt guard — a
      // LIST — pushing our copy over the host's drops whatever the other device
      // put there while we were offline, and the guard that unions the two is
      // already registered (`aheadValue`). Merge first, then push the union,
      // stamped strictly newer than both so the host takes it. A refused write
      // keeps the old stamp and pushes what we hold, which is the behaviour
      // this branch always had.
      const merged = remote ? aheadValue(value, remote.value, adoptGuards.get(key)) : null;
      if (remote && merged !== null) {
        const bumped = Math.max(Date.now(), stamp + 1, remote.ts + 1);
        if (writeWithoutEcho(key, merged, bumped)) { stamp = bumped; announce(key); }
      }
      noteLocalWrite(key, stamp);
      schedulePush(key);
    }
  }
}

/** A single key changed on another device (or our own write echoed back). */
export function applyRemoteSetting(key: string, value: string, ts: number): void {
  if (!isSyncedKey(key)) return;
  const known = readTs()[key] ?? 0;
  // **Our own echo is the receipt.** The host broadcasts `settings.update` to
  // every socket including the writer, precisely so this arrives; for years it
  // was recognised here and dropped on the next line, which is why no screen
  // could say whether anything had reached the desktop. Recording it is the
  // whole of the change — nothing new goes on the wire.
  if (ts <= known) { noteSynced(key, ts); return; }
  if ((localValue(key) ?? "") === value) { writeTs(key, ts); noteSynced(key, ts); return; }
  // A newer value from somewhere else replaced what this device held. Not a
  // failure — last-write-wins is the rule — but a person has to be able to see
  // it, which is the one thing the pad's silent overwrite never allowed.
  applyLocally(key, value, ts);
  noteSuperseded(key, ts);
  announce(key);
}

/**
 * Force this device's copy onto the host for every synced key.
 *
 * The escape hatch for last-write-wins. The merge rule is right by default and
 * wrong exactly once: a device that had never pushed adopts the host's copy on
 * its first connect, so the one client holding the list you actually want can
 * lose it to whichever client happened to connect first after the upgrade.
 * Nothing is destroyed when that happens — the values are still in this
 * browser's localStorage under the same keys — so the fix is to re-stamp them
 * as newest and push. Returns how many keys were sent.
 */
export function pushAllSettings(): number {
  let n = 0;
  const now = Date.now();
  for (const key of SYNCED_SETTING_KEYS) {
    if (localValue(key) == null) continue;
    writeTs(key, now + n); // distinct stamps keep the order stable if it matters
    schedulePush(key);
    n++;
  }
  return n;
}

/**
 * Subscribe to remote changes. `keys` empty = every synced key.
 * Returns the unsubscribe, so a `useEffect` can return it directly.
 */
export function onSettingsChange(handler: (key: string) => void, keys?: readonly string[]): () => void {
  const listener = (ev: Event) => {
    const key = (ev as CustomEvent<{ key: string }>).detail?.key;
    if (!key) return;
    if (keys && keys.length && !keys.includes(key)) return;
    handler(key);
  };
  window.addEventListener(SETTINGS_EVENT, listener);
  return () => window.removeEventListener(SETTINGS_EVENT, listener);
}
