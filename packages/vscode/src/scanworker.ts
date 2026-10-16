/**
 * The all-sessions scan, off the extension host's thread. A cold scan re-reads thousands of logs;
 * on the extension host that would stall every other extension in the window, so it runs here, in
 * a `worker_threads` Worker that `extension.ts` starts per scan and terminates when the panel goes.
 *
 * In:  workerData = { configDir, cacheFile }.
 * Out: { t: "progress", done, total }* then exactly one { t: "done", doc } or { t: "error", message }.
 * The store is loaded, refreshed, saved and folded here, so the per-file summaries never cross to
 * the host thread — only the folded CorpusDoc does, with the scan's own stats on it.
 */
import { parentPort, workerData } from "node:worker_threads";
import { foldCorpus } from "./data/corpus.js";
import { TokenStore } from "./data/store.js";
import type { CorpusDoc } from "./protocol.js";

export interface ScanJob { configDir: string; cacheFile: string }
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
  return foldCorpus(store.files, Date.now(), stats);
}

if (parentPort) {
  run(workerData as ScanJob).then(
    (doc) => parentPort!.postMessage({ t: "done", doc } satisfies ScanMsg),
    (e: unknown) => parentPort!.postMessage({ t: "error", message: e instanceof Error ? e.message : String(e) } satisfies ScanMsg),
  );
}
