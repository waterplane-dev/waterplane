/**
 * HTTP routes about the desktop and every repo at once: the repo listing,
 * what the desktop is holding (storage), the cross-repo artifact search,
 * `/api/host/*` (setup preferences, machine stats, screenshot, clipboard, the
 * highlighter's text reader, dictation), scaffolding and the write-only
 * secrets. Moved out of `api.ts` (host-architecture.md, "api.ts — the HTTP
 * routes as tables").
 */
import { statSync } from "node:fs";
import { ASK_RULE_BACKENDS, ASK_RULES_STALE, SUGGESTED_ASK_RULES, type AskRulesReply, DICTATE_MAX_BYTES, DICTATE_MAX_SECONDS, envName, type HostSetupFixResult, type HostSetupReport, type RootInfo, type RootPostReply } from "@waterplane/shared";
import { discoverTargets, findTarget, listTargets } from "../repos.js";
import { countOutbox, outboxSeenAt, discoverArtifactsAsync, newOutboxPath, type ArtifactKind } from "../files.js";
import { hostStat, takeScreenshot, setHostClipboard } from "../host.js";
import { dictateStatusLive, transcribe } from "../dictate.js";
import { ocrStatus, readImageLocal } from "../ocrlocal.js";
import { cloneRepo, newFolder, newRepo, newWorktree, type TemplateId } from "../scaffold.js";
import { changedCountsWithin, gitRunningIn } from "../git.js";
import { buildFailedFor, gitFailedFor } from "../attentionstore.js";
import { listWriteTargets, setSecret } from "../secrets.js";
import { setupPrefsStore } from "../setupprefs.js";
import { askRulesStore } from "../askrules.js";
import { ASK_RULES_SCOPE, browserOriginRefusal, confirmGate } from "../confirmgate.js";
import { hostChecks, hostFixes } from "../plugins/setupcontrib.js";
import { canReadRepoHealth } from "../repohealth.js";
import { surveyTransport } from "../transportsurvey.js";
import { clearHostStore, hostStoreReport } from "../hoststore.js";
import { worktreeOwners } from "../worktreeowner.js";
import { ROOT_PICKED } from "../env.js";
import { requestPeerKind } from "../net.js";
import { restartSelf } from "../updates/restart.js";
import { cleanRootInput, hostSupervisor, readChosenRoot, rootCandidates, rootChoicePath, writeChosenRoot } from "../rootchoice.js";
import { json, readBody, readJson } from "./apiio.js";
import { route, type ApiEntry, type ApiHandler } from "./apitable.js";

/** How long the repo listing waits for its git counts before answering with the last ones. */
const CHANGED_BUDGET_MS = 2500;
/** …and when every worktree already has a count: long enough for a local disk's fresh answer. */
const CHANGED_REFRESH_MS = 400;
/** A whole phone photo, sent once at the size the phone holds it. */
const MAX_LOCAL_OCR_BYTES = 24 * 1024 * 1024;

// One dictation, as 16 kHz mono PCM — exactly 32 kB per second of speech, so
// this ceiling IS `DICTATE_MAX_SECONDS` expressed in the unit the transport
// can refuse on before the body has been read. `shared/dictate.ts` owns the
// number; this is the same fact, not a second opinion about it.
const MAX_DICTATE_BYTES = DICTATE_MAX_BYTES;

// ── Desktop host introspection ──────────────────────────────────────
// The setup checklist's host-wide choices (today: the auto-compact window
// its fix writes). Read by Settings; the POST refuses in words and stores
// nothing for a value outside the range, `null` goes back to the default.
const setupPrefs: ApiHandler = async ({ req, res, method }) => {
  const store = setupPrefsStore();
  if (!store) { json(res, { ok: false, error: "no setup-preferences store on this host" }, 503); return true; }
  if (method === "POST") {
    const body = await readJson(req);
    const r = store.setAutoCompactDefault(body?.autoCompactDefault ?? null);
    if (!r.ok) { json(res, { ok: false, error: r.error }, 400); return true; }
  }
  const d = store.autoCompactDefault();
  json(res, { ok: true, autoCompactDefault: d.value, chosen: d.chosen });
  return true;
};

// ── Ask rules (`askrules.ts`, agent-authority §2) ──────────────────
// The permission rules every claude launch is given as `permissions.ask`. GET reads and
// mints a one-shot confirm bound to the list's `rev`; PUT replaces the whole list and
// needs BOTH `confirmgate.ts` gates: (a) a browser `Origin` and (b) that confirm, for the
// CURRENT rev. A forged Origin alone no longer deletes the rule that asks about the
// forger, and a phone holding an older copy is refused instead of overwriting a list it
// never saw. The token is consumed only by a save that landed; its reply carries a fresh one.
const askRules: ApiHandler = async ({ req, res, method }) => {
  const store = askRulesStore();
  if (!store) { json(res, { ok: false, error: "no ask-rules store on this host" }, 503); return true; }
  let dropped: number | undefined;
  if (method === "PUT") {
    const why = browserOriginRefusal(req);
    if (why) { json(res, { ok: false, error: `${why} — the ask rules were not changed` }, 403); return true; }
    const body = await readJson(req);
    const sent = body && typeof body === "object" && Array.isArray(body.rules) ? body.rules : null;
    if (!sent) { json(res, { ok: false, error: "send { rules: [...] } — the ask rules were not changed" }, 400); return true; }
    if (typeof body.rev !== "string") { json(res, { ok: false, error: "send the rev the list was read at — reopen the ask rules; nothing was changed" }, 400); return true; }
    const rev = store.rev();
    if (body.rev !== rev) { json(res, { ok: false, error: ASK_RULES_STALE, stale: true }, 409); return true; }
    const refused = confirmGate.check(body.confirm, ASK_RULES_SCOPE, rev);
    if (refused) { json(res, { ok: false, error: `${refused} — the ask rules were not changed` }, 403); return true; }
    let kept;
    try { kept = store.set({ rules: sent }); } catch (e: any) {
      json(res, { ok: false, error: `the ask rules could not be saved (${e?.message ?? e}) — nothing was changed` }, 500);
      return true;
    }
    confirmGate.consume(body.confirm);
    dropped = sent.length - kept.rules.length;
    // The confirm gate's promise: an accepted change leaves a line saying it happened.
    console.log(`[askrules] list replaced from ${req.headers.origin}: ${kept.rules.length} rule(s)` +
      (dropped ? `, ${dropped} dropped` : "") + ` (rev ${rev} → ${store.rev()})`);
  }
  const rev = store.rev();
  const reply: AskRulesReply = {
    ok: true, doc: store.get(), suggested: SUGGESTED_ASK_RULES, honouredBy: ASK_RULE_BACKENDS,
    rev, confirm: confirmGate.mint(ASK_RULES_SCOPE, rev),
    ...(dropped !== undefined ? { dropped } : {}),
    ...(store.lost() ? { lost: store.lost()! } : {}),
  };
  json(res, reply);
  return true;
};

// ── The code folder (`rootchoice.ts`) ──────────────────────────────
// What the running host scans, how it came about, and the usual folders that
// exist — for the phone's one-time dialog and its Settings row. A POST checks
// a folder (`save` absent) or keeps it in `<config dir>/root.json`; only the
// trusted path may (loopback + Tailscale, the LAN-password rule), because the
// root is what the phone can reach. Read once at boot, so a save restarts the
// host when a supervisor will bring it back, and says "restart it" otherwise.
const isDirNow = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
const countRepos = async (dir: string): Promise<number> => {
  try { return (await discoverTargets(dir)).length; } catch { return 0; }
};

const rootInfo: ApiHandler = async ({ req, res }, ctx) => {
  const chosen = ROOT_PICKED === "named" ? undefined : readChosenRoot();
  const candidates = await Promise.all(rootCandidates().map(async (path) => ({ path, repos: await countRepos(path) })));
  const rootExists = isDirNow(ctx.root);
  const info: RootInfo = {
    ok: true,
    root: ctx.root,
    picked: ROOT_PICKED,
    rootExists,
    repos: rootExists ? await countRepos(ctx.root) : 0,
    pending: chosen && chosen !== ctx.root ? chosen : null,
    choicePath: rootChoicePath(),
    envName: envName("ROOT"),
    canChange: !!ctx.canManage?.(requestPeerKind(req.socket.remoteAddress, req.headers)),
    restart: hostSupervisor() ? "auto" : "manual",
    candidates,
  };
  json(res, info);
  return true;
};

const rootPost: ApiHandler = async ({ req, res }, ctx) => {
  const reply = (r: RootPostReply, status = 200): true => (json(res, r, status), true);
  if (!ctx.canManage?.(requestPeerKind(req.socket.remoteAddress, req.headers))) {
    return reply({ ok: false, error: "The code folder can only be changed from this desktop or over Tailscale." }, 403);
  }
  const body = await readJson(req);
  const c = cleanRootInput(body?.path);
  if (!c.ok) return reply({ ok: false, error: c.error }, 400);
  const repos = await countRepos(c.root);
  if (body?.save !== true) return reply({ ok: true, root: c.root, repos });
  if (ROOT_PICKED === "named") {
    return reply({ ok: false, error: `${envName("ROOT")} is set where the host is started, and it wins over a choice made here — change it there.` }, 409);
  }
  try { writeChosenRoot(c.root); } catch (e) {
    return reply({ ok: false, error: `Could not save it: ${(e as Error).message}` }, 500);
  }
  console.log(`[root] code folder chosen: ${c.root} (${rootChoicePath()})`);
  if (c.root === ctx.root) return reply({ ok: true, root: c.root, repos, saved: true, restart: "none" });
  // After the reply is out: the SIGTERM flush (`shutdown.ts`) runs as for any restart, and
  // launchd/systemd start the host again, which reads the new folder at boot.
  const sup = hostSupervisor();
  if (sup) console.log(`[root] restarting under ${sup} to scan it`);
  return reply({ ok: true, root: c.root, repos, saved: true, restart: restartSelf(null) });
};

export const HOST_ROUTES: readonly ApiEntry[] = [
  route("GET", "/api/repos", async ({ res }, ctx) => {
    const targets = await listTargets(ctx.root);
    for (const t of targets) {
      t.outboxCount = countOutbox(t.worktreePath);
      // The EDGE the count was taken at, so a tap on the badge can cut the
      // gallery to exactly what it counted rather than to a guess at it.
      if (t.outboxCount > 0) t.outboxSeenAt = outboxSeenAt(t.worktreePath);
    }
    // Read the setup verdict from the sweep's store, never by inspecting here:
    // a repo listing is fetched on every launcher open, and running six git
    // subprocesses per repo per fetch would make the list slower than the thing
    // it is listing. Unchecked worktrees carry no `setup` at all.
    for (const t of targets) t.setup = ctx.setup.stateFor(t.worktreePath);
    // Whether ANY engine can read this worktree — the repo's own
    // `tools/repohealth.mjs` if it carries one, else this desktop's bundled
    // engine pointed at it with `--root=`. Still one `existsSync` per repo and
    // deliberately not a run of it. This used to be "does this repo carry the
    // tool", which was false for twelve of the thirteen repos here and hid the
    // control on every one of them; `false` now means the DESKTOP has no
    // engine, which is a real fault and says so in `repoHealthUnavailableText`.
    for (const t of targets) t.hasRepoHealth = canReadRepoHealth(t.worktreePath);
    // The health index from the watcher's cache only — the engine never runs in this request.
    for (const t of targets) { const h = ctx.health?.summaryFor(t.worktreePath); if (h) t.healthIndex = h; }
    // Which live session spawned each agent worktree, so the launcher draws
    // it under that session. Off the CLI's own subagent records.
    const owners = worktreeOwners(ctx.sessions.list());
    for (const t of targets) { const o = !t.isPrimary && owners.get(t.worktreePath); if (o) t.ownerSessionId = o; }
    // Within a budget: a repo whose `git status` is still running (WSL on `/mnt/c` can take a
    // minute) keeps its last count, or none yet — never holds the whole list (`changedCountsWithin`).
    const counts = await changedCountsWithin(targets.map((t) => t.worktreePath), CHANGED_BUDGET_MS, CHANGED_REFRESH_MS);
    for (const t of targets) {
      const c = counts.get(t.worktreePath);
      if (!c) continue;
      t.changedCount = c.changed;
      if (c.ahead !== undefined) { t.ahead = c.ahead; t.behind = c.behind; }
      if (c.hasOrigin !== undefined) t.hasOrigin = c.hasOrigin;
    }
    // A push or pull in flight, off the jobs' own maps — no subprocess.
    for (const t of targets) { const g = gitRunningIn(t.worktreePath); if (g) t.gitRunning = g; }
    // A failed pull/push or build still waiting on the person, off the attention
    // store — the ONE predicate (`needsYou`) the bell counts with, so the chip
    // and the count cannot disagree. Memory reads, no subprocess.
    if (ctx.attention) for (const t of targets) {
      const g = gitFailedFor(ctx.attention, t.id); if (g) t.gitFailed = g;
      const b = buildFailedFor(ctx.attention, t.id); if (b) t.buildFailed = b;
    }
    // A build command in flight, off the intent rows that are its runs.
    for (const t of targets) { const b = ctx.builds?.runningIn(t.worktreePath); if (b) t.buildRunning = b; }
    json(res, { targets });
    return true;
  }),

  // ── What the DESKTOP is holding ───────────────────────────────────────────
  //
  // Beside `/api/search` and deliberately NOT under `/api/repos/…`: the branch
  // below treats the segment after `/api/repos/` as a repo id, and these three
  // are about every repo at once and about the daemon's own store.
  //
  // The survey is a pure read, so GET is correct under the security model; the
  // clear deletes, so it is POST — a side-effecting endpoint must not be a GET
  // (CLAUDE.md), and `origin.ts` checks both on `Origin` and `Host` either way.
  route("GET", "/api/storage/transport", async ({ res }, ctx) => {
    json(res, await surveyTransport(ctx.root));
    return true;
  }),

  // Every Android app's repo half of "installs itself", across every repo — the Apps
  // screen's checklist joins it with the phone's half. A pure read, so GET.
  route("GET", "/api/apps/readiness", async ({ res }, ctx) => {
    if (!ctx.appReadiness) return false;
    json(res, await ctx.appReadiness());
    return true;
  }),

  route("GET", "/api/storage/host", ({ res }, ctx) => {
    json(res, hostStoreReport(ctx.root));
    return true;
  }),

  // Takes a catalogue ID and an INSTANT — never a path. `hoststore.ts` states
  // the whole guard; the short version is that no filename in this directory
  // ever comes from a request, and `at` is what keeps the clear inside the
  // reading the person actually looked at.
  route("POST", "/api/storage/host/clear", async ({ req, res }, ctx) => {
    const body = await readJson(req);
    const store = typeof body?.store === "string" ? body.store : "";
    const at = Number(body?.at);
    if (!store || !Number.isFinite(at) || at <= 0) {
      json(res, { error: "store (a catalogue id) and at (the instant the report was read) are both required" }, 400);
      return true;
    }
    // 200 even when it refused: the body says what became of the request, and a
    // non-2xx would collapse "this is never clearable" — a sentence a person
    // should read — into the phone's generic error state.
    json(res, clearHostStore(ctx.root, store, at));
    return true;
  }),

  // Cross-repo artifact search. Walks every discovered repo (or a supplied
  // subset via ?repos=id1,id2 — the phone passes its non-hidden repo ids) and
  // aggregates matching images/documents, newest first.
  route("GET", "/api/search", async ({ res, url }, ctx) => {
    const query = url.searchParams.get("q") || undefined;
    const fkind = (url.searchParams.get("kind") as ArtifactKind) || undefined;
    const scope = (url.searchParams.get("scope") as "repo" | "outbox") || "repo";
    const since = Number(url.searchParams.get("since") || 0) || undefined;
    const limit = Math.min(Number(url.searchParams.get("limit") || 0) || 300, 1000);
    const reposParam = url.searchParams.get("repos");
    const allowed = reposParam ? new Set(reposParam.split(",").map((s) => s.trim()).filter(Boolean)) : null;

    const targets = await discoverTargets(ctx.root);
    const hits: any[] = [];
    for (const t of targets) {
      if (allowed && !allowed.has(t.id)) continue;
      const { files } = await discoverArtifactsAsync(t.worktreePath, { scope, sinceSeconds: since, query, kind: fkind, limit, includeInbox: true });
      for (const f of files) hits.push({ repoId: t.id, repoName: t.repoName, branch: t.branch, ...f });
    }
    hits.sort((a, b) => b.mtime - a.mtime);
    json(res, { hits: hits.slice(0, limit), truncated: hits.length > limit });
    return true;
  }),

  route("GET", "/api/host/root", rootInfo),
  route("POST", "/api/host/root", rootPost),
  route("GET", "/api/host/setupprefs", setupPrefs),
  route("POST", "/api/host/setupprefs", setupPrefs),
  route("GET", "/api/askrules", askRules),
  route("PUT", "/api/askrules", askRules),
  // The desktop's own checklist: the rows about this machine (`scope: "host"`), which no repo's
  // checklist lists. The fix answers with the re-read rows and the fix's own words.
  route("GET", "/api/host/setup", ({ res }, ctx) => {
    json(res, { checks: hostChecks(ctx.root) } satisfies HostSetupReport);
    return true;
  }),
  route("POST", "/api/host/setup/fix", async ({ req, res }, ctx) => {
    const { fixes } = await readJson(req);
    const list = Array.isArray(fixes) ? fixes.map(String) : [];
    const ran = hostFixes(list, ctx.root);
    const reply: HostSetupFixResult = {
      ok: true,
      applied: ran.filter((r) => r.outcome.applied).map((r) => r.id),
      notes: ran.length ? ran.map((r) => r.outcome.note) : ["Nothing to fix: no desktop row names that fix any more."],
      checks: hostChecks(ctx.root),
    };
    json(res, reply);
    return true;
  }),
  route("GET", "/api/host/stat", ({ res }) => {
    json(res, hostStat());
    return true;
  }),
  // Capture the desktop screen into the repo's outbox; return the artifact.
  // POST, not GET, precisely because it has a side effect: a cross-origin GET
  // (an `<img src>` on a malicious page) carries no `Origin` header, so the
  // same-origin guard cannot see it coming. A POST always carries one.
  route("POST", "/api/host/screenshot", async ({ res, url }, ctx) => {
    const target = await findTarget(ctx.root, url.searchParams.get("repo") || "");
    if (!target) return json(res, { error: "unknown repo" }, 404), true;
    let dest: ReturnType<typeof newOutboxPath>;
    try {
      dest = newOutboxPath(target.worktreePath, "screenshot", ".png");
      await takeScreenshot(dest.full);
    } catch (e) {
      return json(res, { error: String((e as Error).message || e) }, 500), true;
    }
    let size = 0, mtime = Date.now(), ctime = mtime;
    try { const st = statSync(dest.full); size = st.size; mtime = st.mtimeMs; ctime = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs; } catch { /* keep defaults */ }
    json(res, { file: { name: dest.name, relPath: dest.relPath, size, mtime, ctime } });
    return true;
  }),
  // Push text from the phone onto the desktop host's system clipboard.
  route("POST", "/api/host/clipboard", async ({ req, res }) => {
    const { text } = await readJson(req);
    const s = String(text ?? "");
    if (!s) return json(res, { ok: false, error: "empty" }, 400), true;
    if (s.length > 1_000_000) return json(res, { ok: false, error: "too large" }, 413), true;
    try {
      await setHostClipboard(s);
    } catch (e) {
      return json(res, { ok: false, error: String((e as Error).message || e) }, 500), true;
    }
    json(res, { ok: true, chars: s.length });
    return true;
  }),

  // The whole picture's words, read ON THIS DESKTOP (`ocrlocal.ts`) — the
  // annotator's "text only": a photo with a person in it goes no further than
  // this machine, and only the text the person then edits is ever sent. The GET
  // is asked before the verb is offered; the POST takes the bytes as the body
  // because the picture may never be uploaded, writes nothing, and every reason is a 200.
  route("GET", "/api/host/ocr", async ({ res }) => {
    json(res, await ocrStatus());
    return true;
  }),
  route("POST", "/api/host/ocr", async ({ req, res }) => {
    const tooBig = "that picture is too large to read";
    if (Number(req.headers["content-length"] || 0) > MAX_LOCAL_OCR_BYTES) return json(res, { error: tooBig }, 413), true;
    let body: Buffer;
    try {
      body = await readBody(req, MAX_LOCAL_OCR_BYTES);
    } catch {
      return json(res, { error: tooBig }, 413), true;
    }
    if (!body.length) return json(res, { error: "empty image" }, 400), true;
    const mime = String(req.headers["content-type"] || "image/jpeg").split(";")[0].trim();
    if (!/^image\//.test(mime)) return json(res, { error: "not an image" }, 400), true;
    json(res, await readImageLocal(body, mime));
    return true;
  }),

  // Dictation: audio the phone recorded, words back — read on this desktop by
  // whisper.cpp, which costs nothing and never leaves the machine.
  //
  // The GET says whether the desktop can do it at all, and is asked BEFORE the
  // microphone is opened: a button offered for a thing that will fail is worse
  // than no button, and the reason names what to install (`Unavailable.tsx`'s
  // rule — a dimmed control explains nothing on a phone).
  route("GET", "/api/host/dictate", async ({ res }) => {
    json(res, await dictateStatusLive());
    return true;
  }),
  // POST for the same reason `/api/host/ocr` is: the bytes exist NOWHERE
  // but the phone's capture graph at this point, nothing is written anywhere,
  // and there is no repo in this route at all. A reason comes back as a 200 —
  // "install whisper-cpp" and "nothing was said" are answers the phone SHOWS.
  route("POST", "/api/host/dictate", async ({ req, res, url }) => {
    const tooLong = `that is longer than ${DICTATE_MAX_SECONDS}s of audio`;
    if (Number(req.headers["content-length"] || 0) > MAX_DICTATE_BYTES) {
      return json(res, { error: tooLong }, 413), true;
    }
    let body: Buffer;
    try {
      body = await readBody(req, MAX_DICTATE_BYTES);
    } catch {
      return json(res, { error: tooLong }, 413), true;
    }
    if (!body.length) return json(res, { error: "nothing was said" }, 400), true;
    const lang = (url.searchParams.get("lang") || "").trim() || undefined;
    // The person's vocabulary (`shared/dictateterms.ts`), re-parsed and capped
    // on this side too: the query string is the phone's claim, not a contract.
    const terms = url.searchParams.get("terms") || undefined;
    json(res, await transcribe(body, { lang, terms }));
    return true;
  }),

  // ── Scaffolding ─────────────────────────────────────────────────────
  route("POST", "/api/folder", async ({ req, res }, ctx) => {
    const { parent, name } = await readJson(req);
    const r = await newFolder(ctx.root, parent || ctx.root, String(name || ""));
    json(res, r, "error" in r ? 400 : 200);
    return true;
  }),
  route("POST", "/api/repo", async ({ req, res }, ctx) => {
    // `setup` is the field; `usmc` is what a client built before the rename still sends.
    const { parent, name, setup, usmc: legacySetup, description, template } = await readJson(req);
    const r = await newRepo(ctx.root, parent || ctx.root, String(name || ""), {
      setup: (setup ?? legacySetup) !== false,
      description: description ? String(description) : undefined,
      // A template id is checked against `TEMPLATES` inside `newRepo` (unknown = refused in words).
      ...(typeof template === "string" && template ? { template: template as TemplateId } : {}),
    });
    json(res, r, "error" in r ? 400 : 200);
    return true;
  }),
  route("POST", "/api/clone", async ({ req, res }, ctx) => {
    // The URL is checked (and the transports pinned) inside `cloneRepo`; a refusal is a sentence.
    const { parent, url, name } = await readJson(req);
    const r = await cloneRepo(ctx.root, parent || ctx.root, String(url || ""), name ? String(name) : undefined);
    json(res, r, "error" in r ? 400 : 200);
    return true;
  }),
  route("POST", "/api/worktree", async ({ req, res }, ctx) => {
    const { repoId, branch, basePath } = await readJson(req);
    const target = await findTarget(ctx.root, String(repoId || ""));
    if (!target) return json(res, { error: "unknown repo" }, 404), true;
    const r = await newWorktree(ctx.root, target.worktreePath, String(branch || ""), basePath ? String(basePath) : undefined);
    json(res, r, "error" in r ? 400 : 200);
    return true;
  }),

  // ── Secrets (write-only) ────────────────────────────────────────────
  // No value GET counterpart exists by design — a value written here is never
  // readable back out. Body is never logged. Response carries only a mask.
  // The targets listing exposes only id/label/mode/path (where to write), never
  // any written value.
  route("GET", "/api/secret/targets", ({ res }) => {
    json(res, { targets: listWriteTargets() });
    return true;
  }),
  route("POST", "/api/secret", async ({ req, res }, ctx) => {
    const { scope, repoId, file, key, value, targetId } = await readJson(req);
    if (scope === "repo") {
      const target = await findTarget(ctx.root, String(repoId || ""));
      if (!target) return json(res, { ok: false, error: "unknown repo" }, 404), true;
      const r = setSecret({ root: ctx.root, scope: "repo", worktree: target.worktreePath, file: file ? String(file) : undefined, key: String(key || ""), value: String(value ?? "") });
      return json(res, r, r.ok ? 200 : 400), true;
    }
    const r = setSecret({ root: ctx.root, scope: "host", targetId: targetId ? String(targetId) : undefined, key: key != null ? String(key) : undefined, value: String(value ?? "") });
    return json(res, r, r.ok ? 200 : 400), true;
  }),
];
