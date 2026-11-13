/**
 * The links extension's host half: the methods the phone's sheet calls (`shared/wire.mts`) over the
 * engine (`engine.mts`). Contributed through the same `HostPluginApi` an external plugin gets.
 *
 * Spends nothing: `lsof`, `tailscale serve status`, `gcloud … list`, `git grep` and one HEAD per pin,
 * each with a time bound and no shell. Nothing runs until the phone asks — no poller.
 */
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND, handleAll, makeEnvReader, type HostPluginApi } from "@waterplane/shared";
import { PUSH_CHANGED, type LinksMethods } from "../shared/wire.mjs";
import { createEngine, type Engine, type Roots } from "./engine.mjs";
import { run } from "./run.mjs";

export { createEngine } from "./engine.mjs";
export type { Roots } from "./engine.mjs";

const { env } = makeEnvReader(process.env, (text) => console.warn(text));

async function firstExe(places: string[]): Promise<string | null> {
  for (const p of places) { try { await access(p, constants.X_OK); return p; } catch { /* next */ } }
  return null;
}

/** `PATH` first (the launchd plist sets one), then the usual install places. */
async function findBin(name: string, extra: string[]): Promise<string | null> {
  const path = (process.env.PATH || "").split(":").filter(Boolean).map((d) => join(d, name));
  return firstExe([...path, ...extra]);
}

/** This desktop's roots. The pins file sits in the config dir next to `plugin-paths.json`. */
export async function defaultRoots(): Promise<Roots> {
  const home = homedir();
  const configDir = (env("CONFIG_DIR") || "").trim()
    || join((process.env.XDG_CONFIG_HOME || "").trim() || join(home, ".config"), BRAND.configDirName);
  return {
    root: (env("ROOT") || "").trim() || join(home, "dev"),
    file: join(configDir, "links.json"),
    lsofBin: (await findBin("lsof", ["/usr/sbin/lsof", "/usr/bin/lsof"])) ?? "lsof",
    tailscaleBin: await findBin("tailscale", ["/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]),
    gcloudBin: await findBin("gcloud", ["/opt/homebrew/bin/gcloud", "/usr/local/bin/gcloud", join(home, "google-cloud-sdk", "bin", "gcloud")]),
    gitBin: (await findBin("git", ["/usr/bin/git", "/opt/homebrew/bin/git"])) ?? "git",
    run,
    fetch: globalThis.fetch,
    now: () => Date.now(),
    selfPid: process.pid,
    probeTimeoutMs: 6_000,
  };
}

/** Wire an engine to `api`'s methods. Exported so the tests drive the real handlers. */
export function serve(api: Pick<HostPluginApi, "handle" | "push">, engine: Engine): () => void {
  return handleAll<LinksMethods>(api, {
    state: () => engine.state(),
    discover: (a) => engine.discover({ cloud: (a as { cloud?: unknown } | null)?.cloud === true }),
    probe: () => engine.probe(),
    pin: (a) => engine.pin(String((a as { key?: unknown } | null)?.key ?? "")),
    add: (a) => engine.add((a ?? {}) as Parameters<Engine["add"]>[0]),
    edit: (a) => engine.edit((a ?? {}) as Parameters<Engine["edit"]>[0]),
    unpin: (a) => engine.unpin((a as { id?: unknown } | null)?.id),
  });
}

let off: (() => void) | null = null;

export async function activate(api: HostPluginApi): Promise<void> {
  const engine = createEngine(await defaultRoots(), () => { api.push(PUSH_CHANGED, { at: Date.now() }); });
  off = serve(api, engine);
}

export function deactivate(): void {
  off?.();
  off = null;
}
