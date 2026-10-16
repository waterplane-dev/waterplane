import { useEffect } from "react";
import { installSettingsSync, onSettingsChange } from "../../settings";
import { loadHiddenRepos, loadLaunch } from "../../localState";
import { adoptRepoColors } from "../../repoColors";
import { LS } from "../../storage";
import type { Connection } from "../conn/useConnection";

/** The setters it adopts into. Arrows from App: both are declared AFTER this
 *  hook is called, and an arrow is only invoked from the effect. */
export interface SettingsAdoptionCtx {
  connRef: Connection["connRef"];
  setLaunch: (l: ReturnType<typeof loadLaunch>) => void;
  setHiddenRepoIds: (ids: Set<string>) => void;
}

/** The settings-sync install and the adopt switch (docs/notes/app-architecture.md):
 *  App's mount effect, verbatim, called where it was. */
export function useSettingsAdoption(ctx: SettingsAdoptionCtx) {
  const { connRef, setLaunch, setHiddenRepoIds } = ctx;
  /**
   * Settings that follow the USER, not the browser (see `settings.ts`).
   *
   * Two halves. The patch makes every write to a synced key push itself, so a
   * template saved on the phone reaches the host without any call site knowing
   * about sync. This effect is the READ half: these values are held in React
   * state seeded at mount, so a value adopted from another device would
   * otherwise sit in localStorage until the next reload — which is the exact
   * behaviour the feature replaces.
   */
  useEffect(() => {
    installSettingsSync((msg) => connRef.current.send(msg));
    return onSettingsChange((key) => {
      switch (key) {
        case LS.launch: setLaunch(loadLaunch()); break;
        case LS.hiddenRepos: setHiddenRepoIds(loadHiddenRepos()); break;
        // The device preferences that sync (launchAsk, enterSends, the
        // dictation terms, autoSend, serialSessions, confirmQueue, readerTools,
        // hints) re-read themselves: `core/prefs.ts` subscribes to this too.
        // The colours are held in `format.ts` as a module value (every
        // `repoAccentStyle` call site reads it mid-render), so an adopted copy
        // has to be pushed there and the two strips told — `repoColors.ts` does
        // both. Nothing here holds the value.
        case LS.repoColors: adoptRepoColors(); break;
        // The pad's CONTENT is read at sheet-mount time by PadSheet, which
        // subscribes itself; App needs nothing from it.
        // the fanout presets key is read at sheet-mount time by FanoutSheet.
        default: break;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only install; `connRef` is a ref and both setters are App's useState setters
  }, []);
}
