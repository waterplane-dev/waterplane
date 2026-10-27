/**
 * Which build each artifact last was — read off `<repo state dir>/versions.jsonl`, the line a
 * build appends whether a build button ran it or an agent did (`scripts/build-record.mjs`; the
 * format and its wording are `@waterplane/shared`'s `buildstamp.ts`). Read-only here: the host
 * never writes a record, because only the build knows what it baked into the artifact.
 *
 * Bounded: only the file's last `TAIL_BYTES` are read (the first, likely torn, line of that tail
 * is skipped by the parser like any other unreadable line). Absent or unreadable ⇒ no versions,
 * never an error on the build list.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { parseBuildRecords, recordsByName, type BuildRecord } from "@waterplane/shared";
import { repoStateDir } from "./branddirs.js";

const TAIL_BYTES = 256 * 1024;
/** Builds kept per artifact name on the wire. */
const KEEP = 10;

export function buildVersions(repoDir: string): Record<string, BuildRecord[]> {
  let fd: number | null = null;
  try {
    fd = openSync(join(repoStateDir(repoDir), "versions.jsonl"), "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return recordsByName(parseBuildRecords(buf.toString("utf8")), KEEP);
  } catch {
    return {};
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
