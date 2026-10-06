/**
 * Host-side store for the settings that follow the USER rather than the browser
 * — prompt templates (snippets), fan-out presets, header commands, the prompt
 * pad, the toolbar layout, the default launch flags.
 *
 * The whole rationale, the key allow-list and why each excluded key is excluded
 * live in `@waterplane/shared`'s `settings.ts`, because both ends check against the
 * same list. What is here is only the storage half, and it is deliberately
 * blind: a record is `{ value, ts }` where `value` is the client's RAW
 * localStorage string. The host never parses it, never migrates it and never
 * has an opinion about its shape — which is what lets the phone update its own
 * web bundle (`webbundle.ts`) and change these shapes without the daemon being
 * upgraded in lockstep.
 *
 * Conflict resolution is last-write-wins on the client's `ts`. Not a merge:
 * two devices editing one list at the same moment is rare (one person, one
 * phone in hand) and a wrongly merged prompt list is worse than a lost edit
 * that is still on screen in the other client until it reloads. An EQUAL
 * timestamp does not win — a re-sent write (the client pushes its whole set
 * after a reconnect) must not bump the record and re-broadcast to every other
 * socket for nothing.
 *
 * Persisted to <STATE_DIR>/settings.json — tmp+rename, debounced, flushed on
 * shutdown, same shape as `sentlog.ts`/`acks.ts`. On disk for the obvious
 * reason: an in-memory copy of the user's prompt library would be wiped by
 * `npm run restart`, and this feature exists precisely because losing it hurt.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MAX_SETTING_BYTES, MAX_SETTINGS_BYTES, currentKeyFor, isSyncedKey, type SettingRecord, type SettingsDoc } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

const SAVE_DEBOUNCE_MS = 500;
/** Device label cap — it is only ever shown in a "changed on <device>" note. */
const DEVICE_MAX = 40;

/** Why a write was refused, for the caller's log line. Null = accepted. */
export type SettingsReject = "unknown key" | "too big" | "store full" | "bad value" | "older" | null;

export class SettingsStore {
  private path: string;
  private doc: SettingsDoc = {};
  /**
   * Records still stored under a LEGACY brand prefix (`<old prefix>pad`), kept
   * verbatim and written back on every persist — never served, never counted.
   * They are what an older build reads if the host is rolled back; the cleanup
   * release after a rename drops them. `clear()` drops them too.
   */
  private legacy: Record<string, unknown> = {};
  private timer: NodeJS.Timeout | null = null;

  constructor(root: string) {
    this.path = join(hostStateDir(root), "settings.json");
    let adopted = false;
    try {
      if (existsSync(this.path)) {
        const parsed = readJsonGuarded<any>(this.path, null) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          // Sanitise on the way IN as well as on the way out: the file is
          // plain JSON on disk, and a key that is no longer synced (or a
          // record from a hand-edit) must not be handed back to clients.
          const entries = Object.entries(parsed as Record<string, unknown>);
          for (const [key, rec] of entries) {
            const clean = cleanRecord(rec);
            if (clean && isSyncedKey(key)) this.doc[key] = clean;
          }
          // A record stored under a legacy prefix (the phone wrote `<old>pad`
          // before the rename) is COPIED to the current name when that name
          // holds nothing — never over a value the current bundle wrote, which
          // is newer by construction. The legacy record stays as it is.
          for (const [key, rec] of entries) {
            const to = currentKeyFor(key);
            if (to === null) continue;
            this.legacy[key] = rec;
            const clean = cleanRecord(rec);
            if (clean && isSyncedKey(to) && !this.doc[to]) { this.doc[to] = clean; adopted = true; }
          }
        }
      }
    } catch { /* corrupt or unreadable → start empty rather than throw */ }
    if (adopted) this.persist();
  }

  /** Everything, for `settings.all`. A copy, so a caller cannot mutate the store. */
  all(): SettingsDoc {
    return JSON.parse(JSON.stringify(this.doc)) as SettingsDoc;
  }

  get(key: string): SettingRecord | undefined {
    return this.doc[key];
  }

  /**
   * Apply one client write. Returns the stored record when it WON (the caller
   * broadcasts that), or a rejection reason when it did not.
   *
   * `"older"` is not an error — it is the normal outcome of two devices holding
   * different versions, and the caller answers it by sending the winner back to
   * the loser rather than by complaining.
   */
  set(key: string, value: unknown, ts: unknown, device?: unknown): { record: SettingRecord } | { reject: SettingsReject } {
    if (!isSyncedKey(key)) return { reject: "unknown key" };
    if (typeof value !== "string") return { reject: "bad value" };
    if (Buffer.byteLength(value) > MAX_SETTING_BYTES) return { reject: "too big" };
    const stamp = typeof ts === "number" && Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : Date.now();
    const prev = this.doc[key];
    // Equal timestamps lose on purpose — see the header note on re-sends.
    if (prev && prev.ts >= stamp) return { reject: "older" };
    const record: SettingRecord = {
      value,
      ts: stamp,
      ...(typeof device === "string" && device.trim() ? { device: device.trim().slice(0, DEVICE_MAX) } : {}),
    };
    // The whole-document cap is checked against the doc this write WOULD make,
    // so an over-cap write is refused rather than accepted and then trimmed —
    // trimming would silently drop somebody else's key.
    const next = { ...this.doc, [key]: record };
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_SETTINGS_BYTES) return { reject: "store full" };
    this.doc = next;
    this.schedule();
    return { record };
  }

  /** Forget everything (the Settings "reset synced settings" action). */
  clear(): void {
    this.doc = {};
    this.legacy = {};
    this.flush();
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.persist();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.persist(); }, SAVE_DEBOUNCE_MS);
  }

  /** tmp + rename: a kill mid-write must not leave truncated JSON that the
   *  constructor's catch turns into an empty settings store — i.e. every
   *  device silently re-pushing whatever it happens to hold. */
  private persist(): void {
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      writeJsonAtomic(this.path, { ...this.legacy, ...this.doc });
    } catch { /* non-fatal — keep serving from memory */ }
  }
}

function cleanRecord(rec: unknown): SettingRecord | null {
  if (!rec || typeof rec !== "object") return null;
  const o = rec as Record<string, unknown>;
  if (typeof o.value !== "string" || Buffer.byteLength(o.value) > MAX_SETTING_BYTES) return null;
  const ts = typeof o.ts === "number" && Number.isFinite(o.ts) ? Math.floor(o.ts) : 0;
  if (ts <= 0) return null;
  return {
    value: o.value,
    ts,
    ...(typeof o.device === "string" && o.device.trim() ? { device: o.device.trim().slice(0, DEVICE_MAX) } : {}),
  };
}
