/**
 * "Scan for large files": a plain `find` over $HOME — no model call, no `claude -p`, zero tokens.
 * One filesystem (`-xdev`), the folders the lists already cover pruned, killed at its time bound
 * with whatever it found so far reported as PARTIAL. Show-only: nothing here has a delete path.
 */
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { LARGE_TOP, type LargeFile } from "../shared/wire.mjs";
import { coveredPaths, tilde, type Roots } from "./candidates.mjs";
import { pool } from "./run.mjs";

export interface LargeOutcome { items: LargeFile[]; found: number; stoppedAfterS: number | null; tookMs: number; error?: string }

export function findArgs(r: Roots): string[] {
  const prune = coveredPaths(r).flatMap((p, i) => (i ? ["-o", "-path", p] : ["-path", p]));
  return [r.home, "-xdev", "(", ...prune, ")", "-prune", "-o", "-type", "f", "-size", r.largeMinSize, "-print"];
}

export function findLarge(r: Roots): Promise<LargeOutcome> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const paths: string[] = [];
    let buf = "";
    let stopped = false;
    let spawnError: string | undefined;
    const child = spawn(r.findBin, findArgs(r), { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => { stopped = true; child.kill("SIGKILL"); }, r.largeLimitMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) if (l) paths.push(l);
    });
    child.on("error", (e) => { spawnError = e.message; });
    child.on("close", async () => {
      clearTimeout(timer);
      if (buf && !stopped) paths.push(buf); // a half line from a killed find is dropped
      const stats = await pool(paths, 8, async (p): Promise<LargeFile | null> => {
        try { const s = await stat(p); return { path: tilde(p, r.home), sizeKb: Math.round(s.size / 1024), mtime: s.mtimeMs }; } catch { return null; }
      });
      const items = stats.filter((x): x is LargeFile => x != null).sort((a, b) => b.sizeKb - a.sizeKb);
      resolve({
        items: items.slice(0, LARGE_TOP), found: items.length, tookMs: Date.now() - t0,
        stoppedAfterS: stopped ? Math.round(r.largeLimitMs / 1000) : null,
        ...(spawnError ? { error: `find could not run: ${spawnError}` } : {}),
      });
    });
  });
}
