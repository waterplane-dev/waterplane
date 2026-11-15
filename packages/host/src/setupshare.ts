/**
 * The desktop's half of the setup block (R-metrics-073, shared `agentseries/share.ts`): the repo's
 * identity as two people on it both know it, and writing an exported block into the repo's
 * `.claude/outbox/` so it can be downloaded or picked up from the gallery. Never git.
 *
 *  - Identity: the origin remote's URL AS WRITTEN (`gitRemoteUrl`, never `remote get-url`), keyed by
 *    shared `remoteKey` (one spelling for ssh/https/scp), then the first 64 bits of its sha-256 and
 *    its last path segment as the name. A local path or no remote identifies nothing: `null`.
 *  - The write takes the phone's text through the SAME strict parser an import uses, and writes the
 *    parser's canonical text: a field the parser does not name cannot reach the file.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, statSync } from "node:fs";
import { parseSetupShare, remoteKey, setupShareText, type SetupShareRepo } from "@waterplane/shared";
import { gitRemoteUrl } from "./git.js";
import { OUTBOX_SUBDIR } from "./files.js";
import { writeTextAtomic } from "./jsonstore.js";
import { containedReal } from "./paths.js";

/** The identity for a remote URL, or null when it names no shared remote. Pure. */
export function shareRepoOfUrl(url: string | null | undefined): SetupShareRepo | null {
  const k = url ? remoteKey(url) : null;
  if (!k) return null;
  const name = k.split("/").pop()!.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 100);
  if (!name) return null;
  return { name, key: createHash("sha256").update(k).digest("hex").slice(0, 16) };
}

export async function shareRepoOf(wt: string): Promise<SetupShareRepo | null> {
  return shareRepoOfUrl(await gitRemoteUrl(wt));
}

/** The file name a block is written under: the person's name as a slug and the window's last day. Pure. */
export function setupShareFileName(from: string, toDay: string): string {
  const slug = from.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").split(/[^a-z0-9]+/).filter(Boolean).join("-").slice(0, 32) || "block";
  return `setup-${slug}-${toDay}.json`;
}

export type SetupShareWrite = { ok: true; relPath: string; size: number; mtime: number } | { ok: false; error: string };

/** Validate the phone's text and write the canonical block into `<wt>/.claude/outbox/`. */
export function writeSetupShare(wt: string, text: string): SetupShareWrite {
  const p = parseSetupShare(text);
  if (!p.ok) return { ok: false, error: p.why };
  const relPath = `${OUTBOX_SUBDIR}/${setupShareFileName(p.block.from, p.block.days.to)}`;
  // The same guard every outbox writer uses (`newOutboxPath`): a committed `.claude/outbox -> <elsewhere>`
  // must not let the block leave the repo while the toast says it was saved here.
  const dir = containedReal(wt, OUTBOX_SUBDIR);
  if (dir === null) return { ok: false, error: "The block was not written: the outbox is not a plain folder in this repo (it links outside it)." };
  const abs = join(dir, setupShareFileName(p.block.from, p.block.days.to));
  try {
    mkdirSync(dir, { recursive: true });
    writeTextAtomic(abs, setupShareText(p.block) + "\n");
    const st = statSync(abs);
    return { ok: true, relPath, size: st.size, mtime: st.mtimeMs };
  } catch (err) {
    return { ok: false, error: `The block could not be written to ${OUTBOX_SUBDIR}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
