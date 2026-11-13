/**
 * The pins, on disk: `<config dir>/links.json`, `{ "links": PinnedLink[] }`. Hand-editable — a row
 * that does not validate is kept out of the list and NAMED, never rewritten away: while the file has
 * any problem it is not written at all (`writable: false`) — a pin or edit then refuses in words.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { LINK_ENVS, PIN_ID_RE, isHttpUrl, type LinkEnv, type PinnedLink } from "../shared/wire.mjs";

export const REPO_RE = /^[\w.-]{1,128}$/;
export const cleanLabel = (s: unknown): string | null => {
  if (typeof s !== "string") return null;
  const t = s.replace(/\s+/g, " ").trim().slice(0, 120);
  return t || null;
};
export const isEnv = (e: unknown): e is LinkEnv => typeof e === "string" && (LINK_ENVS as readonly string[]).includes(e);

function valid(r: unknown): PinnedLink | null {
  const o = r as Partial<PinnedLink> | null;
  if (!o || typeof o !== "object" || typeof o.id !== "string" || !PIN_ID_RE.test(o.id)) return null;
  const label = cleanLabel(o.label);
  if (!label) return null;
  const hasUrl = isHttpUrl(o.url), hasPort = Number.isInteger(o.port) && o.port! > 0 && o.port! < 65536;
  if (hasUrl === hasPort) return null;
  const repo = typeof o.repo === "string" && REPO_RE.test(o.repo) ? o.repo : null;
  const p: PinnedLink = { id: o.id, label, repo, env: isEnv(o.env) ? o.env : "dev" };
  if (hasUrl) p.url = o.url; else p.port = o.port;
  if (typeof o.from === "string" && o.from.length < 300) p.from = o.from;
  return p;
}

export interface Loaded { links: PinnedLink[]; problems: string[]; writable: boolean }

export async function loadPins(file: string): Promise<Loaded> {
  let text: string;
  try { text = await readFile(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { links: [], problems: [], writable: true };
    return { links: [], problems: [`${file} could not be read: ${(e as Error).message}`], writable: false };
  }
  let d: unknown;
  try { d = JSON.parse(text); } catch { return { links: [], problems: [`${file} is not JSON — nothing in it is shown, and nothing is written over it until it parses.`], writable: false }; }
  const rows = Array.isArray((d as { links?: unknown })?.links) ? (d as { links: unknown[] }).links : null;
  if (!rows) return { links: [], problems: [`${file} has no "links" list — nothing is written over it until it has one.`], writable: false };
  const links: PinnedLink[] = [];
  let bad = 0;
  for (const r of rows) { const v = valid(r); if (v) links.push(v); else bad++; }
  if (!bad) return { links, problems: [], writable: true };
  return { links, writable: false, problems: [`${bad} row${bad === 1 ? "" : "s"} in ${file} did not read as a link and ${bad === 1 ? "is" : "are"} not shown — pins are not changed from the phone until the file is fixed by hand.`] };
}

export async function savePins(file: string, links: readonly PinnedLink[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ links }, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}
