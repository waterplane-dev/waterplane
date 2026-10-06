/**
 * This device's preferences, as ONE store (`prefStore.ts` is the machinery).
 *
 * Every entry keeps the key and the reader/writer it always had — nothing here
 * invents a storage key (`storage.ts` owns them) and nothing bypasses a
 * module's own setter (`setThemeChoice` pushes the theme to `<html>`,
 * `setTermZoom` refits the terminal, `setPulseEnabled` drops the window…).
 * What changed is where the VALUE is held: once, here, instead of a `useState`
 * in App plus a ref mirror plus a write effect.
 *
 *  - read in a component: `usePref("theme")`
 *  - read in a long-lived callback (the queue pump, a socket handler):
 *    `prefRef("autoSend").current` — updated in the same call as the write, so
 *    it is never a render behind
 *  - write: `setPref("theme", "dark")` — saves, then publishes
 *
 * A synced key adopted from another device (`settings.ts`' `onSettingsChange`)
 * re-reads the pref naming it, here, so App no longer carries a `case` per key.
 * Dictation's three are re-read on `subscribeDictateLang`, because the
 * microphone's pill writes them mid-recording.
 *
 * Not here, on purpose: `toolbarOpen` (features/toolbarCfg owns it), `readMode`
 * (core/term), the launch defaults (a document, core/launch), and anything
 * about work in flight.
 */
import { createPrefs, flagText, onIfOne, onUnlessZero, sameList, type PrefDef } from "./prefStore.ts";
import { LS, lsBool, lsGet, lsSet, lsSetBool } from "../storage.ts";
import { dataSaver, setDataSaver } from "../media.ts";
import { setThemeChoice, themeChoice, type ThemeChoice } from "../theme.ts";
import { iconScale, readerZoom, setIconScale, setReaderZoom, setTermZoom, setTextScale, termZoom, textScale } from "../uiScale.ts";
import { pulseEnabled, setPulseEnabled } from "../link.ts";
import { localRtMode, setLocalRtMode, type LocalRtMode } from "../localRt.ts";
import { setTabsCount, setTabsEnabled, setTabsLimit, setTabsOrder, tabsCount, tabsEnabled, tabsLimit, tabsOrder, type TabOrder } from "../sessionTabs.ts";
import { readerToolsMode, setReaderToolsMode, type ReaderToolsMode } from "../transcriptUtil.ts";
import { hintMode, hintSeenCount, setHintMode, type HintMode } from "../hints.ts";
import {
  dictateLang, dictateTermsText, offeredLangCodes, setDictateLang, setDictateTermsText, setOfferedLangs,
  subscribeDictateLang,
} from "../dictateLang.ts";
import { onSettingsChange } from "../settings.ts";
import { track } from "../usage.ts";

export interface DevicePrefs {
  /** Data saver: smaller images, slower polling (`media.ts`). Per device. */
  saver: boolean;
  /** Drain the send queue by itself when the link returns. Default ON, synced. */
  autoSend: boolean;
  /** Queued opens for one repo run one session at a time. Default ON, synced. */
  serialSessions: boolean;
  /** Ask before text queued offline goes out. Default ON, synced. */
  confirmQueue: boolean;
  /** Ask backend + model before every fresh launch. Default OFF, synced. */
  launchAsk: boolean;
  /** Close an automatic session once its work is done. Default OFF, synced —
   *  read by the HOST; a backlog row's own answer overrides it. */
  closeWhenDone: boolean;
  /** Return sends (vs inserts a newline). Default ON, synced. */
  enterSends: boolean;
  /** The compose box is a raw key pipe. Per device, never synced. */
  cliMode: boolean;
  /** Button hints: the mode, and how many have been dismissed. */
  hints: { mode: HintMode; seen: number };
  /** The session header collapsed to give the terminal its rows. */
  headerCollapsed: boolean;
  /** Hide the chrome above the compose box while typing. */
  typingRoom: boolean;
  /** Close the keyboard after a send. Default ON, per device. */
  closeKbOnSend: boolean;
  /** The update-bar signature dismissed on this device. */
  dismissedUpdate: string;
  /** The connection strip. Per device. */
  netPulse: boolean;
  /** The local-runner strip's mode. Per device. */
  localRtBar: LocalRtMode;
  /** The session-tab strip: on, how many fit, which order, how many drawn. Per device. */
  tabsOn: boolean;
  tabsN: number;
  tabsSort: TabOrder;
  tabsMax: number;
  /** How much of a tool call the reader shows/downloads. Synced. */
  toolsMode: ReaderToolsMode;
  /** Light / dark / follow the OS. Per device. */
  theme: ThemeChoice;
  /** Text and icon size, and the two surfaces' own zooms (`uiScale.ts`). */
  txtScale: number;
  icScale: number;
  tZoom: number;
  rZoom: number;
  /** Dictation: the language, the languages the pill lists, the vocabulary. */
  dictLang: string;
  dictLangCodes: string[];
  dictTerms: string;
}

/** A `"1"`/`"0"` flag on one key, through `lsGet`/`lsSet`. */
function flag(key: string, parse: (raw: string | null) => boolean, synced = false): PrefDef<boolean> {
  return {
    load: () => parse(lsGet(key)),
    save: (v) => lsSet(key, flagText(v)),
    keys: synced ? [key] : undefined,
  };
}

/** Typing room's default splits on POINTER — a desktop keyboard costs no
 *  screen — and is read once, never re-derived on a resize. */
function loadTypingRoom(): boolean {
  const v = lsGet(LS.typingRoom);
  if (v != null) return v === "1";
  try { return window.matchMedia?.("(pointer: coarse)").matches ?? false; } catch { return false; }
}

export const prefs = createPrefs<DevicePrefs>({
  saver: { load: dataSaver, save: setDataSaver },
  autoSend: flag(LS.autoSend, onUnlessZero, true),
  serialSessions: flag(LS.serialSessions, onUnlessZero, true),
  confirmQueue: flag(LS.confirmQueue, onUnlessZero, true),
  // Default OFF, so `lsBool` and not `!== "0"`: a device that has never heard
  // of this key must not read its absence as "ask me".
  launchAsk: { load: () => lsBool(LS.launchAsk), save: (v) => lsSetBool(LS.launchAsk, v), keys: [LS.launchAsk] },
  // Default OFF for `launchAsk`'s reason: absent must read as "keep them open",
  // the default the person chose (`closeWhenDoneSetting` reads it the same way).
  closeWhenDone: { load: () => lsBool(LS.closeWhenDone), save: (v) => lsSetBool(LS.closeWhenDone, v), keys: [LS.closeWhenDone] },
  enterSends: flag(LS.enterSends, onUnlessZero, true),
  cliMode: flag(LS.cliMode, onIfOne),
  hints: {
    load: () => ({ mode: hintMode(), seen: hintSeenCount() }),
    // The mode is the only half a tap writes; `resetHints()` clears the seen
    // half itself and the caller RE-READS (`prefs.reload`) — a `setPref` there
    // wrote `waterplane.hints` a second time, one more sync push for nothing.
    save: (v) => setHintMode(v.mode),
    keys: [LS.hints],
    same: (a, b) => a.mode === b.mode && a.seen === b.seen,
  },
  headerCollapsed: flag(LS.headerCollapsed, onIfOne),
  closeKbOnSend: flag(LS.closeKbOnSend, onUnlessZero),
  typingRoom: { load: loadTypingRoom, save: (v) => lsSet(LS.typingRoom, flagText(v)) },
  dismissedUpdate: { load: () => lsGet(LS.dismissedUpdate) || "", save: (v) => lsSet(LS.dismissedUpdate, v) },
  netPulse: { load: pulseEnabled, save: setPulseEnabled },
  localRtBar: { load: localRtMode, save: setLocalRtMode },
  tabsOn: { load: tabsEnabled, save: setTabsEnabled },
  tabsN: { load: tabsCount, save: setTabsCount },
  tabsSort: { load: tabsOrder, save: setTabsOrder },
  tabsMax: { load: tabsLimit, save: setTabsLimit },
  toolsMode: { load: readerToolsMode, save: setReaderToolsMode, keys: [LS.readerTools] },
  theme: { load: themeChoice, save: setThemeChoice },
  txtScale: { load: textScale, save: setTextScale },
  icScale: { load: iconScale, save: setIconScale },
  tZoom: { load: termZoom, save: setTermZoom },
  rZoom: { load: readerZoom, save: setReaderZoom },
  dictLang: { load: dictateLang, save: setDictateLang, reread: true },
  dictLangCodes: { load: offeredLangCodes, save: setOfferedLangs, reread: true, same: sameList },
  dictTerms: { load: dictateTermsText, save: setDictateTermsText, keys: [LS.dictateTerms], reread: true },
});

export type PrefKey = keyof DevicePrefs;

/** Re-render on one preference. */
export function usePref<K extends PrefKey>(k: K): DevicePrefs[K] {
  return prefs.use(k);
}

/** Save one preference and publish it. */
export function setPref<K extends PrefKey>(k: K, v: DevicePrefs[K]): void {
  prefs.set(k, v);
}

/** The current value for a callback that runs outside a render. */
export function prefRef<K extends PrefKey>(k: K): { readonly current: DevicePrefs[K] } {
  return prefs.ref(k);
}

/**
 * One step of the console zoom, from the terminal's own corner or from
 * Settings. The applying is `uiScale.ts`'s, through the event `Terminal.tsx`
 * is subscribed to — which refits the grid and reports the new cols/rows, so
 * the host resizes the PTY and the CLI actually gets the room the zoom made.
 */
export function applyTermZoom(v: number): void {
  track("action:uiscale.term");
  setPref("tZoom", v);
}

/** The same step for the reader: one `--ui-font` override on its subtree
 *  (`readerScale`), one repaint and no re-render of anything below. */
export function applyReaderZoom(v: number): void {
  track("action:uiscale.reader");
  setPref("rZoom", v);
}

// Another device's copy of a synced key landed: re-read the pref naming it.
// Module-lifetime on purpose — the preference outlives any one screen.
onSettingsChange((key) => { prefs.adopt(key); });
// The microphone's pill writes dictation's three mid-recording; Settings
// redraws from the same store.
subscribeDictateLang(() => { for (const k of ["dictLang", "dictLangCodes", "dictTerms"] as const) prefs.reload(k); });
