/**
 * Creating a project (`scaffold.ts`'s `newRepo`) and the boxes a person may tick for it
 * (`newproject.ts`). The GET mints the one-shot token the POST must echo when anything is ticked: a
 * box can write a repo's Claude settings, and the sheet that listed the boxes is the consent screen
 * (`confirmgate.ts`). A create with nothing ticked needs none, as before. Never in `passive.ts`.
 */
import { madeRepoAnswer } from "../setupprefs.js";
import { NEW_PROJECT_SCOPE, confirmGate, gateRefusal } from "../confirmgate.js";
import { applyNewProjectOptions, newProjectOptions } from "../newproject.js";
import { newRepo, type TemplateId } from "../scaffold.js";
import { json, readJson } from "./apiio.js";
import { route, type ApiEntry } from "./apitable.js";

export const NEW_PROJECT_ROUTES: readonly ApiEntry[] = [
  route("GET", "/api/repo/options", async ({ res }) => {
    const options = newProjectOptions();
    json(res, { options, confirm: confirmGate.mint(NEW_PROJECT_SCOPE, "", options.map((o) => o.id)) });
    return true;
  }),
  route("POST", "/api/repo", async ({ req, res }, ctx) => {
    // `setup` is the field; `usmc` is what a client built before the rename still sends.
    const { parent, name, setup, usmc: legacySetup, description, template, options, confirm } = await readJson(req);
    const ids: string[] = Array.isArray(options) ? options.filter((x: unknown): x is string => typeof x === "string") : [];
    if (ids.length) {
      const why = gateRefusal(req, confirm, NEW_PROJECT_SCOPE, "", ids);
      if (why) { json(res, { error: `${why} — the project was not created` }, 403); return true; }
    }
    const r = await newRepo(ctx.root, parent || ctx.root, String(name || ""), {
      setup: (setup ?? legacySetup) !== false,
      description: description ? String(description) : undefined,
      // A template id is checked against `TEMPLATES` inside `newRepo` (unknown = refused in words).
      ...(typeof template === "string" && template ? { template: template as TemplateId } : {}),
      ...(ids.length ? { extras: (dir: string) => applyNewProjectOptions(dir, ids) } : {}),
    });
    // A refusal (a taken name) leaves the token good for the corrected retry.
    if (ids.length && !("error" in r)) confirmGate.consume(confirm);
    json(res, madeRepoAnswer(r), "error" in r ? 400 : 200);
    return true;
  }),
];
