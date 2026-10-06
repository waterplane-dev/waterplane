/**
 * HTTP routes about the desktop and every repo at once: the repo listing,
 * what the desktop is holding (storage), the cross-repo artifact search,
 * `/api/host/*` (setup preferences, machine stats, screenshot, clipboard, the
 * highlighter's text reader, dictation), scaffolding and the write-only
 * secrets. Moved out of `api.ts` (host-architecture.md, "api.ts — the HTTP
 * routes as tables").
 */
import { statSync } from "node:fs";
import { DICTATE_MAX_BYTES, DICTATE_MAX_SECONDS } from "@waterplane/shared";
import { discoverTargets, findTarget } from "../repos.js";
import { countOutbox, outboxSeenAt, discoverArtifacts, newOutboxPath, type ArtifactKind } from "../files.js";
import { hostStat, takeScreenshot, setHostClipboard } from "../host.js";
import { dictateStatusLive, transcribe } from "../dictate.js";
import { readImageText } from "../readtext.js";
import { newFolder, newRepo, newWorktree, type TemplateId } from "../scaffold.js";
import { countChangedFiles } from "../git.js";
import { listWriteTargets, setSecret } from "../secrets.js";
import { setupPrefsStore } from "../setupprefs.js";
import { canReadRepoHealth } from "../repohealth.js";
import { surveyTransport } from "../transportsurvey.js";
import { clearHostStore, hostStoreReport } from "../hoststore.js";
import { worktreeOwners } from "../worktreeowner.js";
import { json, readBody, readJson } from "./apiio.js";
import { route, type ApiEntry, type ApiHandler } from "./apitable.js";

// One highlighted band of a screenshot, at the phone's own resolution — a few
// hundred KB at worst. The ceiling is here so a mis-aimed POST cannot turn a
// hand-drawn mark into a multi-megabyte call against the host's Gemini key.
const MAX_OCR_BYTES = 8 * 1024 * 1024;

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

export const HOST_ROUTES: readonly ApiEntry[] = [
  route("GET", "/api/repos", async ({ res }, ctx) => {
    const targets = await discoverTargets(ctx.root);
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
    // Which live session spawned each agent worktree, so the launcher draws
    // it under that session. Off the CLI's own subagent records.
    const owners = worktreeOwners(ctx.sessions.list());
    for (const t of targets) { const o = !t.isPrimary && owners.get(t.worktreePath); if (o) t.ownerSessionId = o; }
    await Promise.all(targets.map(async (t) => { t.changedCount = await countChangedFiles(t.worktreePath); }));
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
      const { files } = discoverArtifacts(t.worktreePath, { scope, sinceSeconds: since, query, kind: fkind, limit, includeInbox: true });
      for (const f of files) hits.push({ repoId: t.id, repoName: t.repoName, branch: t.branch, ...f });
    }
    hits.sort((a, b) => b.mtime - a.mtime);
    json(res, { hits: hits.slice(0, limit), truncated: hits.length > limit });
    return true;
  }),

  route("GET", "/api/host/setupprefs", setupPrefs),
  route("POST", "/api/host/setupprefs", setupPrefs),
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
    const dest = newOutboxPath(target.worktreePath, "screenshot", ".png");
    try {
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

  // Read the words out of one image crop — what the phone's highlighter marks.
  //
  // POST for the same reason the screenshot route is (a side effect: it spends
  // tokens against the host's Gemini key), and the bytes are the body because
  // they exist NOWHERE but the phone's canvas at this point — the crop is cut
  // from an image that has not been uploaded yet, and may never be.
  //
  // It writes nothing, anywhere. The answer is a sentence the person who drew
  // the mark sees, edits or drops before it can reach an agent, which is why
  // there is no repo in this route at all.
  route("POST", "/api/host/readtext", async ({ req, res }, ctx) => {
    if (Number(req.headers["content-length"] || 0) > MAX_OCR_BYTES) {
      return json(res, { error: "that crop is too large to read" }, 413), true;
    }
    let body: Buffer;
    try {
      body = await readBody(req, MAX_OCR_BYTES);
    } catch {
      return json(res, { error: "that crop is too large to read" }, 413), true;
    }
    if (!body.length) return json(res, { error: "empty crop" }, 400), true;
    const mime = String(req.headers["content-type"] || "image/png").split(";")[0].trim();
    if (!/^image\//.test(mime)) return json(res, { error: "not an image" }, 400), true;
    const r = await readImageText({ mime, dataB64: body.toString("base64") }, ctx.noteOcrUsage);
    // A reason is a 200: "no key on this host" and "no words in that band" are
    // answers the phone SHOWS, not transport failures it should retry.
    json(res, r);
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
  // POST for the same reason `/api/host/readtext` is: the bytes exist NOWHERE
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
