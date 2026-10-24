/**
 * The all-sessions scan, off the extension host's thread. A cold scan re-reads thousands of logs;
 * on the extension host that would stall every other extension in the window, so it runs here, in
 * a `worker_threads` Worker that `extension.ts` starts per scan and terminates when the panel goes.
 *
 * In:  workerData = { configDir, cacheFile, copilot? }. `copilot` = VS Code's `User` dir and the cache
 *      file for Copilot Chat's own token counts, folded into `CorpusDoc.copilot` (hundreds of MB of
 *      chat logs, so here and not on the host thread; per-file requests are cached across scans).
 * Out: { t: "progress", done, total }* then exactly one { t: "done", doc } or { t: "error", message }.
 * The store is loaded, refreshed, saved and folded here, so the per-file summaries never cross to
 * the host thread — only the folded CorpusDoc does, with the scan's own stats on it.
 */
import { readFile, writeFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import { CopilotLocalReader } from "../../extensions/copilot-usage/host/vscodelocal.mts";
import { foldCorpus } from "./data/corpus.js";
import { TokenStore } from "./data/store.js";
import type { CorpusDoc } from "./protocol.js";

export interface ScanJob { configDir: string; cacheFile: string; copilot?: { userDir: string; cacheFile: string } }
export type ScanMsg =
  | { t: "progress"; done: number; total: number }
  | { t: "done"; doc: CorpusDoc }
  | { t: "error"; message: string };

async function run(job: ScanJob): Promise<CorpusDoc> {
  const store = new TokenStore(job.cacheFile);
  await store.load();
  let last = 0;
  const stats = await store.refresh(job.configDir, (done, total) => {
    const now = Date.now();
    if (now - last < 250 && done < total) return;
    last = now;
    parentPort?.postMessage({ t: "progress", done, total } satisfies ScanMsg);
  });
  await store.save();
  const doc: CorpusDoc = foldCorpus(store.files, Date.now(), stats);
  if (job.copilot) doc.copilot = await copilotLedgerOf(job.copilot);
  return doc;
}

/** Copilot Chat's ledger; a failure is said in the ledger's own words, never a thrown scan. */
async function copilotLedgerOf(c: { userDir: string; cacheFile: string }): Promise<NonNullable<CorpusDoc["copilot"]>> {
  const reader = new CopilotLocalReader(c.userDir);
  try {
    const kept = JSON.parse(await readFile(c.cacheFile, "utf8")) as { v?: number; files?: unknown };
    if (kept.v === 1) reader.seed(kept.files);
  } catch { /* none yet, or unreadable: every log is read */ }
  try {
    const doc = await reader.ledger(Date.now());
    await writeFile(c.cacheFile, JSON.stringify({ v: 1, files: reader.cached() })).catch(() => undefined);
    return doc;
  } catch (e) {
    return { available: false, reason: `Copilot Chat's logs could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
}

if (parentPort) {
  run(workerData as ScanJob).then(
    (doc) => parentPort!.postMessage({ t: "done", doc } satisfies ScanMsg),
    (e: unknown) => parentPort!.postMessage({ t: "error", message: e instanceof Error ? e.message : String(e) } satisfies ScanMsg),
  );
}
