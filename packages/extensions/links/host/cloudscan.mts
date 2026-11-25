/**
 * One look at Google Cloud with ONE sign-in: every project it lists, its Cloud Run services, its
 * Firebase Hosting sites. Who owns a row is the engine's business — this only reads.
 *
 * `token` null = this desktop's own gcloud sign-in. A token is handed to gcloud by environment, never
 * on a command line.
 */
import type { FoundLink } from "../shared/wire.mjs";
import { parseHostingSites, parseRunServices } from "./parse.mjs";
import { firstLine, pool, type Runner } from "./run.mjs";

export interface CloudScan {
  projects: string[];
  rows: FoundLink[];
  notes: string[];
  /** The projects could not be listed: why, and whether it is the sign-in. Null = they were. */
  failed: { why: string; signIn: boolean } | null;
}

/** gcloud's ways of saying "nobody is signed in here" — and not "the network is down". */
const SIGN_IN_RE = /valid credentials|auth login|activate-service-account|do(?:es)? not (?:currently )?have an active account|invalid_grant|reauthenticat/i;

export async function scanCloud(r: { run: Runner; gcloudBin: string; fetch: typeof fetch }, token: string | null): Promise<CloudScan> {
  const env = token ? { CLOUDSDK_AUTH_ACCESS_TOKEN: token } : undefined;
  const gcloud = (argv: string[], timeoutMs: number) => r.run(r.gcloudBin, [...argv, "--quiet"], { timeoutMs, env });
  const notes: string[] = [], rows: FoundLink[] = [];
  const pl = await gcloud(["projects", "list", "--format=value(projectId)"], 30_000);
  const projects = pl.stdout.split("\n").map((s) => s.trim()).filter((s) => /^[a-z][a-z0-9-]{4,62}$/.test(s));
  if (pl.code !== 0) {
    const why = firstLine(pl.stderr) || (pl.timedOut ? "no answer within 30 s" : pl.error) || "no reason given";
    return { projects: [], rows, notes, failed: { why, signIn: SIGN_IN_RE.test(pl.stderr) } };
  }
  const tok = token || !projects.length ? null : await gcloud(["auth", "print-access-token"], 20_000);
  const bearer = token ?? (tok?.code === 0 ? firstLine(tok.stdout) : "");
  await pool(projects, 3, async (p) => {
    const s = await gcloud(["run", "services", "list", `--project=${p}`, "--format=json"], 60_000);
    if (s.code === 0) rows.push(...parseRunServices(s.stdout, p));
    else if (!/not been used|not enabled|SERVICE_DISABLED/i.test(s.stderr)) notes.push(`Cloud Run in ${p} did not answer: ${firstLine(s.stderr) || (s.timedOut ? "timed out after 60 s" : s.error) || "no reason"}`);
    if (!bearer) return;
    try {
      const res = await r.fetch(`https://firebasehosting.googleapis.com/v1beta1/projects/${encodeURIComponent(p)}/sites`, {
        headers: { authorization: `Bearer ${bearer}`, "x-goog-user-project": p }, signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) rows.push(...parseHostingSites(await res.text(), p));
    } catch { /* hosting not set up, or unreachable: no row, said by its absence */ }
  });
  if (projects.length && !bearer) notes.push("gcloud gave no access token — Firebase Hosting sites are not looked for.");
  return { projects, rows, notes, failed: null };
}

/** Several sign-ins' looks as one: a project both can see is listed once, and the one that failed is said. */
export function mergeScans(scans: readonly CloudScan[]): CloudScan {
  const rows = new Map<string, FoundLink>();
  for (const s of scans) for (const row of s.rows) if (!rows.has(row.key)) rows.set(row.key, row);
  const bad = scans.filter((s) => s.failed);
  return {
    projects: [...new Set(scans.flatMap((s) => s.projects))], rows: [...rows.values()],
    notes: [...new Set([...scans.flatMap((s) => s.notes), ...(bad.length < scans.length ? bad.map((s) => `One Google sign-in did not list its projects: ${s.failed!.why}`) : [])])],
    failed: bad.length === scans.length ? bad[0]?.failed ?? { why: "no sign-in was given", signIn: true } : null,
  };
}
