/**
 * Applying an update, on a tap and nothing else (CLAUDE.md: nothing applies itself): install a plugin,
 * update one the manager installed, update or roll back waterplane itself, restart the desktop.
 *
 * ONE apply at a time (`busy`): a second gets "another update is running". Every refusal is a
 * sentence the phone shows verbatim and leaves the machine as it was — a rejected install removes
 * its temp dir, a rejected update checks the previous commit back out, a failed self update never
 * switched versions (`cli/selfupdate.ts` ran with `noRestart`; THIS file restarts, under the
 * supervisor rule shared with `routes/apihost.ts`).
 *
 * Plugins are cloned into `<plugins>/.incoming-<rand>` (a dot-dir the loader skips, held inside the
 * plugins dir by `contained`), validated there, and only then renamed to `<plugins>/<id>`.
 * Zero dependencies only: no `npm ci` anywhere in this feature.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { BRAND, newerVersion } from "@waterplane/shared";
import type { UpdatesRestart, UpdatesTarget } from "@waterplane/shared";
import { applyInProcess } from "../cli/selfupdate.js";
import { contained } from "../paths.js";
import type { PluginRegistry } from "../plugins/pluginregistry.js";
import { readPluginDir } from "../plugins/pluginloader.js";
import type { UpdatesChecker } from "./checker.js";
import { realGit, refOk, resolveUrl, urlProblem } from "./gitops.js";
import type { Git, Resolved } from "./gitops.js";
import { INSTALL_RECORD, readInstallRecord, writeInstallRecord } from "./installrecord.js";
import { repoLabel } from "./remote.js";
import { canRestartSelf, restartSelf } from "./restart.js";
import type { Restarter } from "./restart.js";

export interface ApplyResult { ok: boolean; message: string; restart: UpdatesRestart }

export const BUSY_SENTENCE = "another update is running";

export interface ApplyDeps {
  /** `<config dir>/plugins`. */
  pluginsDir: string;
  plugins: Pick<PluginRegistry, "entries" | "byId" | "loadOne">;
  checker: Pick<UpdatesChecker, "status" | "setLastResult" | "setLastApply" | "refresh">;
  git?: Git;
  restart?: Restarter;
  /** Whether `restart` would really restart (default: a supervisor runs this daemon). */
  supervised?: () => boolean;
  /** `cli/selfupdate.ts`'s update/rollback in this process (injected in tests). */
  selfApply?: typeof applyInProcess;
}

const fail = (message: string, restart: UpdatesRestart = "none"): ApplyResult => ({ ok: false, message, restart });
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\.+$/, "");

export class UpdateApplier {
  private running = false;
  private readonly git: Git;
  private readonly restart: Restarter;
  private readonly supervised: () => boolean;

  constructor(private d: ApplyDeps) {
    this.git = d.git ?? realGit;
    this.restart = d.restart ?? restartSelf;
    this.supervised = d.supervised ?? canRestartSelf;
    this.sweepIncoming(); // a host killed mid-clone leaves its temp dir behind
  }

  /**
   * Remove every `<plugins>/.incoming-*` (a clone a killed host never cleaned up). Only called when no
   * apply runs (boot, or the start of an install, which holds `busy`); each path goes through
   * `contained`, so nothing outside the plugins folder is ever touched. Returns how many went.
   */
  sweepIncoming(): number {
    let n = 0;
    try {
      for (const name of readdirSync(this.d.pluginsDir)) {
        if (!name.startsWith(".incoming-")) continue;
        const p = contained(this.d.pluginsDir, name);
        if (!p) continue;
        try { rmSync(p, { recursive: true, force: true }); n++; } catch { /* next boot tries again */ }
      }
    } catch { /* no plugins folder yet */ }
    return n;
  }

  /** True while an apply runs. The route asks this BEFORE `apply`, so the refusal is synchronous. */
  get busy(): boolean { return this.running; }

  async apply(target: UpdatesTarget): Promise<ApplyResult> {
    if (this.running) return fail(BUSY_SENTENCE);
    this.running = true;
    let result: ApplyResult;
    try {
      switch (target?.kind) {
        case "plugin-install": result = await this.install(target.repo, target.url); break;
        case "plugin-update": result = await this.updatePlugin(target.id); break;
        case "self": result = await this.self("update"); break;
        case "self-rollback": result = await this.self("rollback"); break;
        case "restart": result = this.restartDesktop(); break;
        default: result = fail("This device asked for an update this desktop does not know.");
      }
    } catch (e) {
      result = fail(`The update stopped: ${errText(e)}. Nothing else was changed.`);
    } finally {
      this.running = false;
    }
    // Kept (and broadcast with the status) so a phone whose link dropped mid-apply still reads the outcome.
    // A refusal for an unknown target shape stores nothing a client could not have sent.
    if (target && typeof target === "object") this.d.checker.setLastApply({ target, ...result });
    else this.d.checker.refresh();
    return result;
  }

  // ── restart ───────────────────────────────────────────────────────────

  private restartDesktop(): ApplyResult {
    if (!this.supervised()) return fail("This desktop is not run by a service, so it cannot restart itself. Restart it by hand.", "manual");
    this.restart("restarting the desktop");
    return { ok: true, message: "Restarting the desktop.", restart: "restarting" };
  }

  // ── waterplane itself ─────────────────────────────────────────────────

  private async self(what: "update" | "rollback"): Promise<ApplyResult> {
    const info = this.d.checker.status().self;
    if (!info.canApply) {
      return fail(`${info.why ?? "This install cannot update itself."}${info.command ? ` Run: ${info.command}` : ""}`);
    }
    const logs: string[] = [], errors: string[] = [];
    const run = this.d.selfApply ?? applyInProcess;
    const auto = this.supervised();
    // A rollback also restores the older state: in-process that only happens in the shutdown path of a
    // SUPERVISED restart (`deferRestore`); unsupervised, applyInProcess refuses it in words.
    const r = await run(what, { log: (m) => logs.push(m), error: (m) => errors.push(m) }, undefined, { deferRestore: auto });
    const warn = r.warning ? ` ${r.warning}` : "";
    const stateNotRestored = logs.concat(errors).some((l) => l.includes("NOT restored"));
    if (r.code !== 0 || stateNotRestored) {
      const message = (errors.join(" ").trim() || logs.at(-1) || `The ${what} failed and nothing was switched.`) + (stateNotRestored ? " The older state was not restored; no restart was made." : "");
      this.d.checker.setLastResult({ ok: false, message });
      return fail(message);
    }
    const v = r.version ?? "";
    if (!v || v === info.current) {
      const message = (what === "update" ? `${info.current} is already the newest version.` : `Nothing to roll back to from ${info.current}.`) + warn;
      this.d.checker.setLastResult({ ok: true, message });
      return { ok: true, message, restart: "none" };
    }
    // The receipt is written BEFORE the restart: the phone reads it after it reconnects.
    const message = (auto
      ? (what === "update" ? `updated to ${v}` : (logs.find((l) => l.startsWith("Rolled back")) ?? `rolled back to ${v}`))
      : (what === "update" ? `installed ${v}, restart the desktop to switch` : `${logs.find((l) => l.startsWith("Rolled back")) ?? `rolled back to ${v}`} Restart the desktop to switch.`)) + warn;
    this.d.checker.setLastResult({ ok: true, message });
    if (auto) this.restart(what === "update" ? `updating ${BRAND.slug} to ${v}` : `rolling ${BRAND.slug} back to ${v}`);
    return { ok: true, message, restart: auto ? "restarting" : "manual" };
  }

  // ── plugin install ────────────────────────────────────────────────────

  private async install(repo?: string, rawUrl?: string): Promise<ApplyResult> {
    let url: string;
    let want: Resolved | null = null;
    if (typeof repo === "string" && repo) {
      const row = this.d.checker.status().catalog.find((c) => c.repo === repo);
      if (!row) return fail(`${repo} is not in the list of plugins. Check for updates to refresh the list, or paste its address instead.`);
      if (row.problems.length) return fail(`${row.name} cannot be installed: ${row.problems.join("; ")}.`);
      if (row.installed) return fail(`${row.name} is already installed.`);
      if (!row.latest) return fail(`${row.name} has nothing to install yet.`);
      url = row.url;
      want = { kind: row.latest.kind, ref: row.latest.ref };
    } else {
      url = typeof rawUrl === "string" ? rawUrl.trim() : "";
    }
    const bad = urlProblem(url);
    if (bad) return fail(`${bad} Nothing was installed.`);

    mkdirSync(this.d.pluginsDir, { recursive: true });
    this.sweepIncoming();
    const tmpName = `.incoming-${randomBytes(6).toString("hex")}`;
    const tmp = contained(this.d.pluginsDir, tmpName);
    if (!tmp) return fail("The plugins folder could not be used safely. Nothing was installed.");
    try {
      if (!want) {
        try { want = await resolveUrl(this.git, url); } catch (e) { return fail(`Could not read ${url}: ${errText(e)}. Nothing was installed.`); }
      }
      if (want.ref && !refOk(want.ref)) return fail(`The version name "${want.ref}" is not one this desktop will pass to git. Nothing was installed.`);
      try {
        await this.git(["clone", "--depth", "1", ...(want.ref ? ["--branch", want.ref] : []), "--", url, tmp]);
      } catch (e) { return fail(`Could not download ${url}: ${errText(e)}. Nothing was installed.`); }

      const dir = readPluginDir(tmp, tmp);
      if (dir.problems.length) return fail(`That repository is not an installable plugin: ${dir.problems.join("; ")}. Nothing was installed.`);
      const id = dir.manifest.id;
      const depsProblem = dependenciesProblem(tmp, id);
      if (depsProblem) return fail(`${depsProblem} Nothing was installed.`);
      if (this.d.plugins.entries.some((e) => e.manifest.id === id)) return fail(`A plugin with the id "${id}" is already installed, so ${url} was not installed.`);
      const dest = contained(this.d.pluginsDir, id);
      if (!dest) return fail(`The id "${id}" is not a safe folder name. Nothing was installed.`);
      if (existsSync(dest)) return fail(`The plugins folder already has a folder named "${id}", so nothing was installed.`);

      let commit: string | undefined;
      let ref = want.ref;
      try {
        commit = (await this.git(["rev-parse", "HEAD"], tmp)).trim() || undefined;
        if (!ref) ref = (await this.git(["rev-parse", "--abbrev-ref", "HEAD"], tmp)).trim();
      } catch { /* a record without a commit still names the url and ref */ }
      if (!ref) ref = "HEAD";
      renameSync(tmp, dest);
      const label = `${dir.manifest.name} ${want.kind === "tag" ? ref : `(${ref}, untagged)`}`;
      let bootErr: string | null;
      try {
        try { appendFileSync(join(dest, ".git", "info", "exclude"), `\n${INSTALL_RECORD}\n`); } catch { /* a dirty-tree check also skips the record */ }
        writeInstallRecord(dest, { url, kind: want.kind, ref, ...(commit ? { commit } : {}), installedAt: Date.now() });
        bootErr = await this.d.plugins.loadOne(dest);
      } catch (e) {
        // Past the rename the folder exists: take it out again and say so, never "nothing was changed".
        let removed = true;
        try { rmSync(dest, { recursive: true, force: true }); } catch { removed = false; }
        return fail(`${label} could not be started: ${errText(e)}. ${removed ? "It was removed again; nothing is installed." : `Its folder ${dest} could not be removed; delete it by hand.`}`);
      }
      if (bootErr) return fail(`${label} is installed but not running: ${bootErr}.`);
      return { ok: true, message: `Installed ${label}.`, restart: "none" };
    } finally {
      rmSync(tmp, { recursive: true, force: true }); // gone after a rename; the leftover of any refusal
    }
  }

  // ── plugin update ─────────────────────────────────────────────────────

  private async updatePlugin(id: string): Promise<ApplyResult> {
    const entry = typeof id === "string" ? this.d.plugins.byId(id) : null;
    if (!entry || entry.builtin) return fail(`No plugin "${String(id)}" is installed.`);
    const name = entry.manifest.name;
    const rec = readInstallRecord(entry.dir);
    if (!rec) return fail(`${name} was put on this desktop by hand, so ${"the updates view"} does not update it. Update it where it came from.`);
    if (resolve(dirname(entry.dir)) !== resolve(this.d.pluginsDir)) return fail(`${name} does not live in the plugins folder, so it is not updated from here.`);
    const dir = entry.dir;
    if (!existsSync(join(dir, ".git"))) return fail(`${name} has no git checkout in ${dir}, so it cannot be updated from here. Reinstall it.`);
    let dirty: string;
    try { dirty = await this.git(["status", "--porcelain"], dir); } catch (e) { return fail(`Could not read the state of ${dir}: ${errText(e)}. Nothing was changed.`); }
    if (dirty.split("\n").some((l) => l.trim() && !l.endsWith(INSTALL_RECORD))) {
      return fail(`${name} has changes of its own in ${dir}. Commit or discard them first; nothing was changed.`);
    }
    const row = this.d.checker.status().catalog.find((c) => c.installed?.id === id);
    if (row?.latest && row.problems.length) return fail(`${name} cannot be updated from here: ${row.problems.join("; ")}. Nothing was changed.`);
    if (row?.latest && row.repo.toLowerCase() !== repoLabel(rec.url).toLowerCase()) return fail(`${name} was installed from ${rec.url}, not ${row.repo}, so it is not updated from that list. Nothing was changed.`);
    let want: Resolved;
    if (row?.latest) want = { kind: row.latest.kind, ref: row.latest.ref };
    else {
      try { want = await resolveUrl(this.git, rec.url); } catch (e) { return fail(`Could not read ${rec.url}: ${errText(e)}. Nothing was changed.`); }
      if (want.kind === "branch" && !want.ref) want = { kind: "branch", ref: rec.kind === "branch" ? rec.ref : "" };
    }
    if (!want.ref || !refOk(want.ref)) return fail(`There is no version of ${name} to update to. Nothing was changed.`);
    if (want.kind === "tag" && rec.kind === "tag") {
      if (want.ref === rec.ref) return fail(`${name} is already at ${rec.ref}.`);
      if (!isNewerTag(rec.ref, want.ref)) return fail(`${want.ref} is not newer than ${rec.ref}, so ${name} stays at ${rec.ref}.`);
    }

    let before: string;
    try { before = (await this.git(["rev-parse", "HEAD"], dir)).trim(); } catch (e) { return fail(`Could not read ${dir}: ${errText(e)}. Nothing was changed.`); }
    const back = async () => { try { await this.git(["checkout", "--detach", before], dir); } catch { /* best effort: the record still names the old version */ } };
    try {
      if (want.kind === "tag") {
        await this.git(["fetch", "--depth", "1", "origin", "tag", want.ref], dir);
        await this.git(["checkout", "--detach", `refs/tags/${want.ref}`], dir);
      } else {
        await this.git(["fetch", "--depth", "1", "origin", want.ref], dir);
        await this.git(["checkout", "--detach", "FETCH_HEAD"], dir);
      }
    } catch (e) { await back(); return fail(`Could not download ${want.ref} of ${name}: ${errText(e)}. It is still at ${rec.ref}.`); }

    const read = readPluginDir(dir, dir);
    const why = read.problems.length ? read.problems.join("; ")
      : read.manifest.id !== id ? `the new version has the id "${read.manifest.id}" instead of "${id}"`
      : dependenciesProblem(dir, id);
    if (why) { await back(); return fail(`${want.ref} of ${name} was refused: ${why}. It is still at ${rec.ref}.`); }
    let commit: string | undefined;
    try { commit = (await this.git(["rev-parse", "HEAD"], dir)).trim() || undefined; } catch { /* record without a commit */ }
    writeInstallRecord(dir, { url: rec.url, kind: want.kind, ref: want.ref, ...(commit ? { commit } : {}), installedAt: Date.now() });
    // ESM cannot import the same path twice, so the new code runs after a restart of the daemon.
    return { ok: true, message: `Updated ${name} to ${want.ref}. Restart the desktop to run it.`, restart: this.supervised() ? "offer" : "manual" };
  }
}

/** The refusal for a plugin whose package.json lists dependencies (or cannot be read), else null. */
function dependenciesProblem(dir: string, id: string): string | null {
  const p = join(dir, "package.json");
  if (!existsSync(p)) return null;
  try {
    const deps = (JSON.parse(readFileSync(p, "utf8")) as { dependencies?: unknown }).dependencies;
    const names = deps && typeof deps === "object" ? Object.keys(deps) : [];
    if (names.length) return `${id} has dependencies (${names.slice(0, 4).join(", ")}${names.length > 4 ? ", …" : ""}); only plugins without dependencies can be installed.`;
    return null;
  } catch { return `${id}'s package.json is not valid JSON.`; }
}

/** Both versions read as numbers ⇒ `to` must be newer; names that do not parse as versions only have to differ. */
function isNewerTag(from: string, to: string): boolean {
  const num = (x: string) => /^v?\d+\.\d+\.\d+/.test(x);
  return num(from) && num(to) ? newerVersion(from, to) : from !== to;
}
