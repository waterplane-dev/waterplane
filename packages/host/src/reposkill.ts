/**
 * Making a driven repo AWARE of this product: the repo-facing skill, handed to
 * every `claude` the host spawns, telling that repo's agent what it offers — the outbox and
 * gallery, the inbox, builds and the downloads they leave, screenshots, work
 * posted for later — and the
 * frame it works in (a person on a phone, often away).
 *
 * Delivered as a Claude Code plugin through `--plugin-dir`, never as a file in
 * the repo. It was a repo file for one afternoon, and that needed a hash stamp,
 * a stale-copy finding, a one-tap update and a guarded replace for edited
 * copies — all to keep N copies of one text true. This way there is one copy,
 * written from `reposkilltext.ts` into the host's config dir whenever the text
 * changes (it names no port — `HOST_API_ENV`), and every session reads what the host says TODAY. It reaches
 * exactly the sessions it describes: a `claude` started at the desk without
 * the host does not get it.
 *
 * Not a PLUGIN (`plugin.ts`): those extend the host; this is the core
 * describing itself to a repo.
 *
 * **Growing it:** a capability a driven repo's agent should know about is a
 * paragraph in `repoSkillBody()`. `tools/reposkill.test.mjs` fails when the host
 * reads a per-repo state-dir file the text never names.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostSecretDir } from "./secrets.js";
import { BRAND } from "@waterplane/shared";
import { HOST_API_ENV, repoSkillBody } from "./reposkilltext.js";

const DESCRIPTION =
  `${BRAND.displayName} (dictated "water plane"; "${BRAND.promptAliases.join('"/"')}" outside a WordPress repo), the phone remote this repo is driven from: ` +
  "where to put what a person should see (the outbox " +
  "and the gallery), files the phone sent (the inbox), builds the phone runs and the downloads they leave, " +
  "screenshots, posting a prompt for later (timed, chained or a new session), and the frame you work in — a " +
  "person reading on a phone, often away. Load BEFORE producing anything a person should look at or download, " +
  "adding or changing a build, scheduling work the person asked for later, or asking the person something.";

/** The plugin's files, relative to its dir. No port in them: one file per desktop, written by every host. */
export function repoClaudePluginFiles(): Record<string, string> {
  return {
    ".claude-plugin/plugin.json": JSON.stringify({
      name: BRAND.skillName,
      description: `What ${BRAND.displayName} (the phone remote driving this session) offers the agent, and the frame it works in.`,
      version: "1.0.0",
    }, null, 2) + "\n",
    [`skills/${BRAND.skillName}/SKILL.md`]: `---
name: ${BRAND.skillName}
description: ${DESCRIPTION}
---
${repoSkillBody()}`,
  };
}

/** A launch's pane env with the host that started it, under the name the skill
 *  text uses (`HOST_API_ENV`). The launch's own values win. */
export function withHostApi(port: number, launchEnv?: Readonly<Record<string, string>>): Record<string, string> {
  return { [HOST_API_ENV]: `http://127.0.0.1:${port}`, ...launchEnv };
}

/**
 * The same text as the skill's body, for a backend that is told some other way
 * (`LaunchRequest.instructions` → a plugin's `prepare()`: Copilot's `AGENTS.md` in a
 * per-session dir, `instructionsVia: "env-file"`). One text, whichever route it takes.
 */
export function repoInstructions(): string {
  return repoSkillBody();
}

/** `<config dir>/claude-plugin` — beside the host's own `.env`, never in a repo. */
export function repoClaudePluginDir(): string {
  return join(hostSecretDir(), "claude-plugin");
}

/**
 * Write the plugin where it differs and return its dir, or null when it could
 * not be written (a launch then simply goes without it — the skill is help, not
 * a precondition). Called per launch: a read and a compare, a write only when
 * the text moved.
 */
export function ensureRepoClaudePlugin(): string | null {
  const dir = repoClaudePluginDir();
  try {
    for (const [rel, text] of Object.entries(repoClaudePluginFiles())) {
      const path = join(dir, rel);
      if (existsSync(path) && readFileSync(path, "utf8") === text) continue;
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(`${path}.tmp`, text);
      renameSync(`${path}.tmp`, path);
    }
    // A skill this text no longer names is a stale brand (the old name after the
    // rename): left on disk, every spawned `claude` still loads it.
    const skills = join(dir, "skills");
    for (const name of readdirSync(skills)) {
      if (name !== BRAND.skillName) rmSync(join(skills, name), { recursive: true, force: true });
    }
    return dir;
  } catch {
    return null;
  }
}
