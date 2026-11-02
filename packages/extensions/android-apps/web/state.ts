/**
 * The Android apps extension's state and its ONE writer: the install log this phone holds (a cache of
 * the desktop's document, `installLog.ts` writes it) and the id of the sheet. The cache lives in
 * `extStorage` — per host, because the log is the desktop's and a second desktop has its own.
 *
 * **`toldAt` is the whole reason this is a state rather than a document.** An empty log and a log
 * nobody has sent are opposite facts, and only one of them is "nothing has installed itself". The
 * cache exists for the same rule `localState.ts` states about the build and schedule lists: a cold
 * start with the tunnel down must not answer a question it has not been told the answer to.
 */
import { createStore, extStorage, featureSheetId } from "@waterplane/sdk";
import type { InstallLogDoc } from "../shared/wire.mts";

/** The sheet's id; `index.ts` spells the same one literally (`tools/webshape.test.mjs` reads it). */
export const APPS_SHEET = featureSheetId("android-apps", "main");

export const mem = extStorage("android-apps");

export const EMPTY_LOG: InstallLogDoc = { entries: [], devices: [], total: 0 };

export interface InstallLogState {
  doc: InstallLogDoc;
  /** When the desktop last said this. Absent = it never has, on this phone. */
  toldAt?: number;
}

export const installLog = createStore<InstallLogState>({ doc: EMPTY_LOG });

let loaded = false;
/**
 * Read the cache once, lazily: the extension's keys are per HOST, and at module load the host may not
 * be chosen yet. Called by the manifest's `boot` (`startInstallLog`), by `readInstallLog` and by `setLog`, so
 * no screen shows an empty log that is in fact merely not read yet — and never from a render: it may
 * set the store, and an emit during render is a React warning.
 */
export function loadCachedLog(): void {
  if (loaded) return;
  loaded = true;
  const raw = mem.read<{ doc?: InstallLogDoc; at?: number }>("installLog", {});
  if (raw?.doc && Array.isArray(raw.doc.entries) && typeof raw.at === "number") {
    installLog.set({ doc: raw.doc, toldAt: raw.at });
  }
}

/** The desktop said this: hold it and keep it for the next cold start. */
export function setLog(doc: InstallLogDoc): void {
  loadCachedLog();
  const toldAt = Date.now();
  mem.write("installLog", { doc, at: toldAt });
  installLog.set({ doc, toldAt });
}
