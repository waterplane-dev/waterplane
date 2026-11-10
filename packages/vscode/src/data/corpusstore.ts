/**
 * The last FINISHED corpus fold, kept next to the token store so a new window shows the All tab at
 * once (with its age) while the refresh scan runs, instead of an empty tab for the length of a scan.
 * The per-log summaries were always cached; their fold was not.
 *
 * A missing, corrupt, other-version, other-build (the extension's build stamp, so a changed doc shape is dropped without a bump) or other-config-dir file is ignored: the next scan rebuilds it.
 * Written atomically (temp file + rename) like `store.ts`.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CorpusDoc } from "../protocol.js";

/** The file format. Another version on disk is ignored. */
export const CORPUS_VERSION = 1;

interface Saved { v: number; configDir: string; build: string | null; doc: CorpusDoc }

/** The fields the webview dereferences unguarded. A fold missing one would crash the view, not just look old. */
function shaped(d: Partial<CorpusDoc>): boolean {
  const obj = (x: unknown) => !!x && typeof x === "object";
  return typeof d.scannedAt === "number" && obj(d.totals) && obj(d.cost) && obj(d.week) && obj((d.week as { totals?: unknown } | undefined)?.totals)
    && obj(d.spans) && Array.isArray(d.days) && Array.isArray(d.top) && Array.isArray(d.models) && Array.isArray(d.repos);
}

/** The saved fold for `configDir`, or null when there is none that can be trusted. */
export async function loadCorpus(file: string, configDir: string, build: string | null = null): Promise<CorpusDoc | null> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Partial<Saved>;
    if (raw?.v !== CORPUS_VERSION || raw.configDir !== configDir || (raw.build ?? null) !== build) return null;
    const doc = raw.doc;
    if (!doc || typeof doc !== "object" || !shaped(doc)) return null;
    return doc;
  } catch { return null; }
}

/** Write the fold atomically. Never throws: a cache that could not be written costs only the next open's wait. */
export async function saveCorpus(file: string, configDir: string, doc: CorpusDoc, build: string | null = null): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ v: CORPUS_VERSION, configDir, build, doc } satisfies Saved));
    await rename(tmp, file);
  } catch { /* see above */ }
}
