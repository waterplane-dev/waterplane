/**
 * The signing key an Android build installs with — one per DESKTOP, made once.
 *
 * Android updates an installed app only when the new build is signed with the same key, so the
 * key must outlive every repo and must never sit inside one: it lives in
 * `<config dir>/keys/sideload.jks` (dir 700, files 600), next to `sideload.properties` holding the
 * random password `keytool` was given. A repo only ever gets `keystore.properties`, a gitignored
 * pointer (`storeFile`, `storePassword`, `keyAlias`, `keyPassword` — the format the Gradle
 * templates read), and a `.gitignore` that names `keystore.properties` and `*.jks`.
 *
 * **Never loses a key**: an existing `.jks` is never overwritten, and a `.jks` whose properties
 * file is gone is reported, not regenerated — a new key silently replacing it would orphan every
 * app signed with the old one. `apkcheck.ts` reads the pointer through `readLink` so its sentence
 * about which key a repo signs with cannot disagree with what was written here.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { BRAND } from "@waterplane/shared";
import { configDir } from "./branddirs.js";

export const KEY_ALIAS = "sideload";
const VALIDITY_DAYS = 36500;

export type KeyKind = "desktop" | "debug";

export interface FoundKey {
  /** The desktop key's files (whether or not they exist yet). `broken` = jks present, properties gone. */
  desktop: { jks: string; props: string; exists: boolean; broken: boolean };
  /** `~/.android/debug.keystore`, when present. */
  debug: string | null;
  /** The default link target: the desktop key or nothing — the debug key is only ever CHOSEN. */
  best: KeyKind | "none";
  /** Every key a repo could be linked to. */
  available: KeyKind[];
}

export interface KeyProps { storeFile: string; storePassword: string; keyAlias: string; keyPassword: string }

export const keysDir = () => join(configDir(), "keys");
const jksPath = () => join(keysDir(), "sideload.jks");
const propsPath = () => join(keysDir(), "sideload.properties");
export const debugKeystore = () => join(homedir(), ".android", "debug.keystore");

export function parseProps(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    const m = /^\s*([A-Za-z.]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const fmtProps = (p: KeyProps) =>
  `storeFile=${p.storeFile}\nstorePassword=${p.storePassword}\nkeyAlias=${p.keyAlias}\nkeyPassword=${p.keyPassword}\n`;

export function findKey(): FoundKey {
  const jks = jksPath(), props = propsPath();
  const hasJks = existsSync(jks), hasProps = existsSync(props);
  const dbg = existsSync(debugKeystore()) ? debugKeystore() : null;
  const exists = hasJks && hasProps;
  const available: KeyKind[] = [];
  if (exists) available.push("desktop");
  if (dbg) available.push("debug");
  return { desktop: { jks, props, exists, broken: hasJks && !hasProps }, debug: dbg, best: exists ? "desktop" : "none", available };
}

export interface SignKeyOpts { keytool?: string }

export type EnsureResult =
  | { ok: true; created: boolean; jks: string; note: string }
  | { ok: false; error: string };

/** Make the desktop key if it does not exist. Idempotent: a second call touches nothing. */
export function ensureDesktopKey(opts: SignKeyOpts = {}): EnsureResult {
  const dir = keysDir(), jks = jksPath(), props = propsPath();
  const found = findKey();
  if (found.desktop.exists) return { ok: true, created: false, jks, note: `desktop signing key already at ${jks}` };
  if (found.desktop.broken) {
    return { ok: false, error: `${jks} exists but ${props} does not — its password is lost. Not generating a new key over it; restore the properties file or move the .jks aside.` };
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const password = randomBytes(24).toString("base64url");
    const tmp = `${jks}.${process.pid}.tmp`;
    rmSync(tmp, { force: true });
    execFileSync(opts.keytool ?? "keytool", [
      "-genkeypair", "-keystore", tmp, "-storetype", "PKCS12", "-alias", KEY_ALIAS,
      "-keyalg", "RSA", "-keysize", "2048", "-validity", String(VALIDITY_DAYS),
      "-storepass", password, "-keypass", password,
      "-dname", `CN=${BRAND.displayName} sideload, O=${BRAND.displayName}`,
    ], { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    chmodSync(tmp, 0o600);
    // Properties first (a jks without them is the "broken" state), jks last.
    writeFileSync(props, fmtProps({ storeFile: jks, storePassword: password, keyAlias: KEY_ALIAS, keyPassword: password }), { mode: 0o600 });
    chmodSync(props, 0o600);
    renameSync(tmp, jks);
    return { ok: true, created: true, jks, note: `created the desktop signing key ${jks} (mode 600)` };
  } catch (e) {
    rmSync(props, { force: true });
    const err = e as { stderr?: Buffer; message?: string };
    const why = (err.stderr?.toString().trim() || err.message || String(e)).split("\n")[0];
    return { ok: false, error: `keytool could not create the signing key: ${why}` };
  }
}

export type LinkResult =
  | { ok: true; kind: KeyKind; file: string; gitignore: string[]; note: string }
  | { ok: false; error: string };

const IGNORES = ["keystore.properties", "*.jks"];

function ensureIgnores(repo: string): string[] {
  const gi = join(repo, ".gitignore");
  const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  const have = new Set(cur.split("\n").map((l) => l.trim().replace(/^\//, "")));
  const missing = IGNORES.filter((e) => !have.has(e));
  if (!missing.length) return [];
  writeFileSync(gi, (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + "\n# signing key pointer — never commit\n" + missing.join("\n") + "\n");
  return missing;
}

/** Point the repo's gitignored `keystore.properties` at the desktop key (or, chosen, the debug key). */
export function linkKey(repo: string, kind: KeyKind = "desktop"): LinkResult {
  let p: KeyProps;
  if (kind === "desktop") {
    const f = findKey();
    if (!f.desktop.exists) return { ok: false, error: "no desktop signing key yet — create it first" };
    const r = parseProps(readFileSync(f.desktop.props, "utf8"));
    if (!r.storePassword) return { ok: false, error: `${f.desktop.props} has no storePassword` };
    p = { storeFile: f.desktop.jks, storePassword: r.storePassword, keyAlias: r.keyAlias || KEY_ALIAS, keyPassword: r.keyPassword || r.storePassword };
  } else {
    const dbg = debugKeystore();
    if (!existsSync(dbg)) return { ok: false, error: `${dbg} does not exist` };
    p = { storeFile: dbg, storePassword: "android", keyAlias: "androiddebugkey", keyPassword: "android" };
  }
  try {
    // The key never goes inside the repo, whatever the config dir is set to.
    const root = realpathSync(resolve(repo));
    const real = realpathSync(p.storeFile);
    if (real === root || real.startsWith(root + sep)) return { ok: false, error: `${p.storeFile} is inside the repo — refusing to link a key that would live in it` };
    const file = join(repo, "keystore.properties");
    writeFileSync(file, fmtProps(p), { mode: 0o600 });
    chmodSync(file, 0o600);
    const gitignore = ensureIgnores(repo);
    return { ok: true, kind, file, gitignore, note: `keystore.properties points at the ${kind} key${gitignore.length ? `; .gitignore += ${gitignore.join(", ")}` : ""}` };
  } catch (e) {
    return { ok: false, error: `could not link the key: ${(e as Error).message}` };
  }
}

/** Which key a repo's `keystore.properties` names — for `apkcheck.ts`. `null` when absent/unreadable. */
export function readLink(repo: string): KeyKind | "other" | null {
  let text: string;
  try { text = readFileSync(join(repo, "keystore.properties"), "utf8"); } catch { return null; }
  const sf = parseProps(text).storeFile;
  if (!sf) return null;
  if (sf === jksPath()) return "desktop";
  if (sf === debugKeystore()) return "debug";
  return "other";
}
