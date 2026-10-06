/**
 * The only module in this tool that is allowed to spawn git.
 *
 * ── Why the spawning is fenced into one file ────────────────────────────────
 *
 * This working tree is shared. Several `claude` sessions edit the main checkout at
 * the same time and there are two dozen dirty files at any moment, so a tool
 * that measured the tree would measure whatever the other sessions happened to
 * be halfway through, and a tool that tried to get a clean tree — `git stash`,
 * `git checkout`, a worktree, `npm ci` — would destroy their work to do it.
 * Every reader here therefore addresses a COMMITTED OBJECT by sha and never
 * touches the index, HEAD, or a file on disk. Keeping that rule in one module
 * makes it checkable: the whole tool contains exactly one `child_process`
 * import, and the argv arrays below are the complete list of what it runs.
 *
 * ── Why the specific commands are pinned ────────────────────────────────────
 *
 * Three of them are pinned against a failure that was measured on this repo,
 * and each would otherwise be silent:
 *
 *   - `%ci`, not `%ct`, decides the day. 22 of 157 commits here are in the
 *     22:00 hour; deriving a day with `new Date(ts * 1000)` puts them on one
 *     date on this desktop and the next date on a machine an hour east, so the
 *     per-day series would reshape itself by where it ran.
 *   - `-c diff.renames=false` on the numstat log. With rename detection on,
 *     git emits `packages/web/src/{a => b}.tsx` as a single path — 8 of them in
 *     this history — and every consumer downstream then holds a path that
 *     matches no file in any tree.
 *   - `--diff-merges=first-parent` is passed EXPLICITLY on the numstat log.
 *     Since git 2.31 `--first-parent` implies it, so on this desktop leaving it
 *     out reads the same; on an older git a merge commit emits no diff at all
 *     and the two merges in this history contribute zero touches — a re-touch
 *     rate, a co-change median and a fixture that all quietly differ by where
 *     they were computed. A fixture whose whole job is to still reproduce years
 *     later on another machine cannot depend on a default that changed once.
 *   - `cat-file --batch` is parsed as BYTES. The stream is a header line, then
 *     exactly `size` bytes, then a newline. Splitting it on `\n` as a string is
 *     wrong twice over: a multibyte character makes the byte count and the
 *     character count disagree, and this repo contains blobs whose own text has
 *     a line shaped like a batch header.
 *
 * ── Why the blob cache is not an optimisation ───────────────────────────────
 *
 * The backfill reads one tree per commit. Across the 155 first-parent commits
 * those trees name only ~2,000 distinct blobs, because most of a tree is
 * unchanged from its parent — so a per-oid cache turns ~50,000 blob reads into
 * ~2,000. That is the difference between a backfill measured in seconds and one
 * measured in minutes, which is the difference between a tool that gets re-run
 * and one that does not. A blob oid is a content hash, so the cache can never
 * return the wrong bytes for a key.
 */
import { execFileSync, spawnSync } from "node:child_process";

/**
 * A single `cat-file --batch` of one tree runs to several MB and the numstat
 * log is ~3k lines; node's 1MB default would truncate both with an exception
 * that reads like a git failure rather than a buffer one.
 */
const MAX_BUFFER = 512 * 1024 * 1024;

/** Process-lifetime, keyed by content hash — see the header. oid -> Buffer. */
const BLOBS = new Map();

/** Text output. argv only: no string is ever handed to a shell. */
function gitText(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * The sentence for a root that cannot be read at all.
 *
 * Both entry points into this module — `listCommits`, which is the first git
 * call of every subcommand, and `listHeadPaths`, which is the first call the
 * census makes — hit this before anything else does, so it is where "you
 * pointed the engine at something that is not a repository" is found. The
 * engine is now run against trees it does not live in, and git's own message
 * for both cases is a sentence about the current directory, which names a path
 * the reader never typed. Say which root, and say which of the two it is: an
 * empty repo is a repo, and the answer there is "commit something", not "this
 * is not a repo".
 */
function notARepo(root, err) {
  const said = `${err.stderr ?? ""}`;
  if (/unknown revision|does not have any commits|bad revision|not a valid object name/i.test(said)) {
    return new Error(`no commits yet in ${root} — there is nothing to measure until the first one.`);
  }
  return new Error(`not a git repository: ${root}`);
}

/**
 * The identity half of every commit, first-parent, oldest first.
 *
 * `filesTouched` and `batch` are deliberately NOT filled here: they come from
 * the numstat log, and inventing an empty array for them would hand callers a
 * commit that truthfully claims to have changed nothing. `readHistory` returns
 * the completed commits and is what everything else should use.
 *
 * @param {string} root
 * @returns {{sha: string, ts: number, day: string, subject: string}[]}
 */
export function listCommits(root) {
  let out;
  try {
    out = gitText(root, [
      "rev-list",
      "--reverse",
      "--first-parent",
      "--format=%H%x00%ct%x00%ci%x00%s",
      "HEAD",
    ]);
  } catch (err) {
    throw notARepo(root, err);
  }
  const commits = [];
  for (const line of out.split("\n")) {
    // rev-list --format interleaves a bare `commit <sha>` line before each
    // record; only the record carries NULs.
    if (!line.includes("\0")) continue;
    const [sha, ts, ci, ...rest] = line.split("\0");
    commits.push({
      sha,
      ts: Number(ts),
      day: ci.slice(0, 10), // the commit's OWN offset; never the machine's
      subject: rest.join("\0"),
    });
  }
  return commits;
}

/**
 * `<mode> SP <type> SP <oid> SP<padding><size> TAB <path>` — the `-l` form.
 * `size` is right-aligned in a fixed column and is `-` for anything but a blob.
 */
const TREE_ENTRY = /^(\d+) (\S+) ([0-9a-f]+)\s+(\S+)\t([\s\S]*)$/;

/**
 * Every blob of one commit's tree.
 *
 * ── Why there is no pathspec any more ──────────────────────────────────────
 *
 * This read used to be limited to `packages .claude CLAUDE.md AGENTS.md
 * scripts package.json`, on the argument that everything else was noise. That
 * argument held for exactly one repo. A pathspec here is a claim about where
 * a project keeps its code, and it is made BEFORE any metric runs and before
 * any pack has seen a single extension — so a Kotlin repo with an `app/`
 * module, or a Python project with a `src/` at the root, had its entire source
 * tree filtered away by a list written about a TypeScript monorepo. Nothing
 * errored. The repo simply measured as empty.
 *
 * What bounds the read now is the SELECTION, not the listing. `listTree`
 * returns entry metadata — a path, an oid and a size per blob, no contents —
 * and `snapshot.mjs` then asks `readBlobs` for only the entries some active
 * pack calls source, a test, a skill or a manifest. So the cost that grew is
 * one line of text per tree entry: waterplane's HEAD is 808 entries against the 732
 * the pathspecs let through, and the largest repo in this fleet is 1,176. The
 * cost that did NOT grow is blob decoding, which is what the backfill's time
 * actually goes on, and which the per-oid cache in this file already bounds to
 * the distinct blobs of the whole history.
 *
 * @param {string} root
 * @param {string} sha
 * @returns {{path: string, oid: string, size: number}[]}
 */
export function listTree(root, sha) {
  const out = gitText(root, ["ls-tree", "-r", "-z", "-l", sha]);
  const entries = [];
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    const m = TREE_ENTRY.exec(rec);
    if (!m || m[2] !== "blob") continue; // submodule gitlinks have no bytes to read
    entries.push({ path: m[5], oid: m[3], size: Number(m[4]) });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

/**
 * Every path in the tree at HEAD, as names alone.
 *
 * `census.mjs`'s one git call: it counts extensions to decide which language
 * packs the repo activates, and it needs no oids, no sizes and no contents to
 * do it.
 *
 * `ls-tree`, never `ls-files`. The rule the header states — every reader here
 * addresses a committed object and never the index — is not a stylistic
 * preference in this case, it is what makes the pack list reproducible. This
 * working tree is shared, several sessions edit it at once, and there are two
 * dozen dirty files at any moment; `ls-files` would activate a pack on a file
 * another session had not committed and drop one on a deletion nobody had
 * either, so the answer would depend on the minute the tool ran.
 *
 * HEAD and not a sha: activation is a fact about what the repo IS now, not
 * about what it was at each commit. Deriving it per sha would mean a repo's
 * early history was measured under a different definition than its recent
 * history — which is the mixed-version failure `series.mjs` exists to refuse,
 * manufactured on purpose.
 *
 * @param {string} root
 * @returns {string[]} repo-relative paths, sorted.
 */
export function listHeadPaths(root) {
  let out;
  try {
    out = gitText(root, ["ls-tree", "-r", "-z", "--name-only", "HEAD"]);
  } catch (err) {
    throw notARepo(root, err);
  }
  const paths = out.split("\0").filter((p) => p.length > 0);
  paths.sort();
  return paths;
}

/**
 * Blob contents, by oid, in one batch — see the header for why the stream is
 * sliced by the byte length in each header rather than split on newlines.
 *
 * @param {string} root
 * @param {Iterable<string>} oids
 * @returns {Map<string, Buffer>}
 */
export function readBlobs(root, oids) {
  const want = [...new Set(oids)];
  const missing = want.filter((oid) => !BLOBS.has(oid));
  if (missing.length) {
    const res = spawnSync("git", ["cat-file", "--batch"], {
      cwd: root,
      input: missing.join("\n") + "\n",
      maxBuffer: MAX_BUFFER,
      // No `encoding`: stdout must stay a Buffer or the slicing below is
      // character-indexed against a byte length.
    });
    if (res.status !== 0) {
      throw new Error(`git cat-file --batch failed: ${res.stderr?.toString("utf8") ?? res.error}`);
    }
    const buf = res.stdout;
    let pos = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl < 0) break;
      const header = buf.toString("utf8", pos, nl);
      const parts = header.split(" ");
      if (parts.length < 3) {
        // `<oid> missing` — cannot happen for oids we just read out of a tree,
        // but a silent skip here would look like an empty file.
        throw new Error(`git cat-file: unexpected header ${JSON.stringify(header)}`);
      }
      const size = Number(parts[2]);
      const start = nl + 1;
      BLOBS.set(parts[0], buf.subarray(start, start + size));
      pos = start + size + 1; // the batch stream puts one LF after the payload
    }
  }
  const out = new Map();
  for (const oid of want) {
    const buf = BLOBS.get(oid);
    if (buf) out.set(oid, buf);
  }
  return out;
}

/** Exposed so a caller can report the saving; the cache itself is never cleared. */
export function blobCacheSize() {
  return BLOBS.size;
}

/** A numstat row: `<added> TAB <deleted> TAB <path>`, with `-` for binary. */
const NUMSTAT_ROW = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;

/**
 * The whole first-parent history with the files each commit touched.
 *
 * One `log` call, joined by sha onto `listCommits` — the day and subject are
 * not available in a numstat log without a second format, and a second walk of
 * the history is a second chance for the two to disagree.
 *
 * `core.quotePath=false` so a non-ASCII path arrives as itself rather than as
 * octal escapes inside quotes; there are none today, and one appearing later
 * should not quietly become a path that matches no tree entry.
 *
 * A binary row is `-\t-\t<path>`: it is a real touch with no line count, so the
 * path is recorded and the counts are left null rather than counted as 0.
 *
 * @param {string} root
 * @returns {import("./types.mjs").History & {lines: Map<string, Map<string, {add: number|null, del: number|null}>>}}
 */
export function readHistory(root, prereg) {
  const commits = listCommits(root);
  const out = gitText(root, [
    "-c",
    "diff.renames=false",
    "-c",
    "core.quotePath=false",
    "log",
    "--first-parent",
    // Implied by `--first-parent` since git 2.31 and stated anyway — see the
    // header: without it an older git gives a merge commit no diff at all.
    "--diff-merges=first-parent",
    "--numstat",
    "--format=%H%x00%ct",
  ]);

  /** @type {Map<string, Set<string>>} */
  const touched = new Map();
  /** @type {Map<string, Map<string, {add: number|null, del: number|null}>>} */
  const lines = new Map();
  let sha = null;
  for (const line of out.split("\n")) {
    if (!line) continue;
    if (line.includes("\0")) {
      sha = line.slice(0, line.indexOf("\0"));
      if (!touched.has(sha)) touched.set(sha, new Set());
      if (!lines.has(sha)) lines.set(sha, new Map());
      continue;
    }
    const m = NUMSTAT_ROW.exec(line);
    if (!m || !sha) continue;
    touched.get(sha).add(m[3]);
    lines.get(sha).set(m[3], {
      add: m[1] === "-" ? null : Number(m[1]),
      del: m[2] === "-" ? null : Number(m[2]),
    });
  }

  const cutoff = prereg.BATCH_FILES;
  /** @type {Map<string, string[]>} */
  const touches = new Map();
  const batch = new Set();
  for (const c of commits) {
    const paths = [...(touched.get(c.sha) ?? [])].sort();
    touches.set(c.sha, paths);
    c.filesTouched = paths;
    c.batch = paths.length >= cutoff;
    if (c.batch) batch.add(c.sha);
  }

  // `lines` is an extension beyond the `History` typedef: the numstat numbers
  // are read anyway, throwing them away would mean a second log to get them
  // back, and a metric that wants churn has nowhere else to find it.
  return { commits, touches, batch, lines };
}
