/**
 * The demo's git and file-tree answers (spec D12). The demo desktop has no git and no worktree,
 * but the Changes, History and Browse screens must open on something a person can read, and every
 * verb on them must answer in the ONE refusal sentence, never a bare 404. Reads give a small
 * fixed sample; writes refuse with `notInDemo(what)`.
 */
import type { GitCommit, GitLog, GitStatus } from "@waterplane/shared";
import { notInDemo } from "./verdict.ts";
import type { DemoHttpRequest, DemoHttpResponse } from "./types.ts";

const json = (v: unknown, status = 200): DemoHttpResponse =>
  ({ status, contentType: "application/json", body: JSON.stringify(v) });

const DIFF = [
  `${"dif"}f --git a/README.md b/README.md`, // git's own header word, not a screen name
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,3 +1,4 @@",
  " # Demo repo",
  " ",
  "-A sample project.",
  "+A sample project, now with a short description.",
  "+It only exists in the demo.",
  "",
].join("\n");

const FILES: Record<string, string> = {
  "README.md": "# Demo repo\n\nA sample project, now with a short description.\nIt only exists in the demo.\n",
  "package.json": "{\n  \"name\": \"demo-repo\",\n  \"version\": \"0.1.0\"\n}\n",
  "src/index.ts": "export const hello = () => \"hello from the demo\";\n",
  "src/util.ts": "export const double = (n: number) => n * 2;\n",
};

const commit = (n: number, subject: string, ago: number, now: number): GitCommit =>
  ({ sha: `${n}`.repeat(40).slice(0, 40), short: `${n}`.repeat(7), author: "You", at: now - ago, subject });

/** The write verbs, by the last path segment(s) after `/git/`, and what each would do. */
const WRITES: Record<string, string> = {
  stage: "stage that file for the next commit",
  commit: "commit your staged changes",
  check: "run your pre-push checks on that commit",
  fetch: "fetch from the remote",
  pull: "pull new commits from the remote",
  push: "push your commits to the remote",
  pushto: "push your commits up to that one",
  branch: "create or delete that branch",
  checkout: "switch the checkout to that branch",
  message: "have Claude write a commit message from your changes",
  explain: "have Claude write a short brief of your changes",
  "prs/lease": "hold this pull request while you work on it",
  "prs/merge": "merge this pull request",
  "prs/automerge": "merge this pull request once its checks pass",
  "prs/close": "close this pull request",
  "prs/log": "show the log of this pull request's check",
};

/** Answer a `/api/repos/:id/git/*` or `/tree*` request, or null when this is not one of those. */
export function demoGitTree(req: DemoHttpRequest, now: number, repoKnown: (id: string) => boolean): DemoHttpResponse | null {
  const m = /^\/api\/repos\/([^/]+)\/(git\/(.+)|tree(?:\/(file))?)$/.exec(req.path);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  if (!repoKnown(id)) return json({ error: "That is not one of the demo's repos." }, 404);
  const q = req.query ?? {};
  const git = m[3];
  if (git !== undefined) {
    if (req.method === "GET") {
      switch (git) {
        case "status": {
          const s: GitStatus = {
            branch: "main", upstream: "origin/main", ahead: 1, behind: 0, fetchedAt: now - 3_600_000,
            files: [{ path: "README.md", code: "M", staged: false }, { path: "src/util.ts", code: "A", staged: true }],
            clean: false,
          };
          return json(s);
        }
        case "diff": return json({ diff: DIFF });
        case "log": {
          const l: GitLog = {
            branch: "main", upstream: "origin/main",
            incoming: [], incomingTotal: 0,
            outgoing: [commit(3, "Add the double helper", 7_200_000, now)], outgoingTotal: 1,
            shared: [commit(2, "Add a short README", 86_400_000, now), commit(1, "First commit", 172_800_000, now)],
            fetchedAt: now - 3_600_000,
          };
          return json(l);
        }
        case "branches": return json({ branches: [{ name: "main", current: true, upstream: "origin/main", inUseElsewhere: false }] });
        case "show": return req.query?.path
          ? json({ diff: DIFF })
          : json({ body: "Add a short README\n\n README.md | 1 +\n 1 file changed, 1 insertion(+)\n", files: [{ path: "README.md", status: "M" }] });
        case "push": return json({ push: null });
        case "explain": return json({ explain: null });
        default: return null; // blob and text stay accepted gaps: the viewer reads a 404 as "no such side"
      }
    }
    const what = WRITES[git];
    if (what && (req.method === "POST" || req.method === "DELETE")) {
      const msg = notInDemo(what);
      return git === "message" ? json({ reason: msg }) : json({ ok: false, error: msg });
    }
    return null;
  }
  // Tree
  if (m[4]) {
    const p = String(q.path ?? "");
    if (req.method === "PUT") return json({ ok: false, code: "refused", error: notInDemo("save that file back into your repo") });
    const body = FILES[p];
    if (req.method !== "GET") return null;
    if (body === undefined) return json({ error: "That file is not in the demo's sample repo." }, 404);
    return json({ path: p, size: body.length, mtime: now - 5 * 3_600_000, body, sha: "demo", editable: true });
  }
  if (req.method !== "GET") return null;
  const dir = String(q.path ?? "").replace(/\/$/, "");
  const query = typeof q.q === "string" ? q.q.toLowerCase() : "";
  const all = Object.keys(FILES);
  const mtime = now - 5 * 3_600_000;
  if (query) {
    const entries = all.filter((f) => f.toLowerCase().includes(query))
      .map((f) => ({ name: f.split("/").pop() as string, path: f, dir: false, size: FILES[f].length, mtime }));
    return json({ path: "", entries, truncated: false, query: q.q });
  }
  const prefix = dir ? `${dir}/` : "";
  const seen = new Set<string>();
  const entries: { name: string; path: string; dir: boolean; size: number; mtime: number; count?: number; status?: string }[] = [];
  for (const f of all) {
    if (!f.startsWith(prefix)) continue;
    const rest = f.slice(prefix.length);
    const head = rest.split("/")[0];
    if (rest.includes("/")) {
      if (seen.has(head)) continue;
      seen.add(head);
      entries.push({ name: head, path: `${prefix}${head}`, dir: true, size: 0, mtime, count: all.filter((g) => g.startsWith(`${prefix}${head}/`)).length });
    } else {
      entries.push({ name: head, path: f, dir: false, size: FILES[f].length, mtime, ...(f === "README.md" ? { status: "M" } : {}) });
    }
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  return json({ path: dir, entries, truncated: false });
}
