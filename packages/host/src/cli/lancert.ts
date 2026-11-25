/**
 * `<slug> lan-cert issue|show|remove` - the certificate that lets a laptop's browser open this desktop
 * over plain LAN with real HTTPS (`lanca.ts`). It works on files only: no host is asked, nothing
 * listens, and nothing is added to any trust store. The steps a person does on the laptop are printed,
 * because this is where they have both machines at hand.
 *
 * `ca.cer` is a public file, but a forged one is a root somebody else holds. So it is carried by hand
 * and compared with the SHA-256 printed here; the host serves it nowhere.
 *
 * The key in `lan-tls.json` is read and never made, replaced or rewritten: every paired phone trusts it.
 */
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { BRAND, LEGACY, envName } from "@waterplane/shared";
import type { BrowserLeaf } from "../lanca.js";
import { writeAll } from "../writeall.js";
import { installedServiceEnv } from "./service.js";

export interface LanCertArgs { cmd: "issue" | "show" | "remove" | "help"; name: string | null; out: string | null; anyName: boolean; yes: boolean }

const CA_FILE = "ca.cer";

export const LAN_CERT_HELP = `usage: ${BRAND.slug} lan-cert <issue|show|remove>

  issue --name NAME [--out DIR] [--any-name] [--yes]
                make a certificate for this desktop under one name, write ${CA_FILE} to DIR (default:
                the current folder), and print what to do on the laptop. Valid for 397 days; a renewal
                is a new certificate to trust again, because no key that could sign one is kept.
                NAME is yours to choose and to keep: a browser's passkeys belong to it. A good one is
                desk.home.arpa, in a zone that is never on the internet. A name outside the private
                zones needs --any-name. --yes replaces an earlier certificate without asking.
  show          the certificate this desktop has, and how long it lasts
  remove        delete it here, and print how to take the trust off a laptop
`;

/** The command line, or a sentence saying what was wrong. */
export function parseLanCertArgs(args: string[]): LanCertArgs | { error: string } {
  const [cmd = "help", ...rest] = args;
  const out: LanCertArgs = { cmd: "help", name: null, out: null, anyName: false, yes: false };
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return out;
  if (cmd !== "issue" && cmd !== "show" && cmd !== "remove") return { error: `unknown command "${cmd}".` };
  out.cmd = cmd;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--help" || a === "-h") return { ...out, cmd: "help" };
    const value = /^--(name|out)(?:=(.*))?$/s.exec(a);
    if (cmd === "issue" && value) {
      const v = value[2] ?? rest[++i];
      if (!v || (value[2] === undefined && v.startsWith("--"))) return { error: `--${value[1]} needs a value.` };
      if (value[1] === "name") out.name = v.toLowerCase();
      else out.out = v;
    } else if (cmd === "issue" && a === "--any-name") out.anyName = true;
    else if (cmd === "issue" && a === "--yes") out.yes = true;
    else return { error: `unknown option "${a}".` };
  }
  if (cmd === "issue" && !out.name) {
    return { error: `issue needs --name, the name a browser will open this desktop by. It is yours to choose and to keep, because passkeys belong to it. For example: ${BRAND.slug} lan-cert issue --name desk.home.arpa` };
  }
  return out;
}

const day = (d: Date): string => d.toISOString().slice(0, 10);
const days = (n: number): string => `${n} ${n === 1 ? "day" : "days"}`;

export interface IssuedFacts { name: string; caFile: string; caSha256: string; caSha1: string; notAfter: Date; stateFile: string; ips: string[]; port: number; restart: string }

/** What `issue` prints: the facts, then the steps in order. Pure. */
export function issuedLines(f: IssuedFacts): string[] {
  const ip = f.ips[0] ?? "<this desktop's address on the LAN>";
  return [
    `Name          ${f.name}`,
    `Address       ${ip}${f.ips.length > 1 ? `   (also ${f.ips.slice(1).join(", ")}: use the one the laptop can reach)` : ""}`,
    `Valid until   ${day(f.notAfter)}`,
    `Certificate   ${f.caFile}   (public; carry it to the laptop)`,
    `SHA-256       ${f.caSha256}`,
    `Kept here     ${f.stateFile}`,
    "",
    "On this desktop",
    `  1. Restart the host: ${f.restart}`,
    `  2. On the router, reserve ${ip} for this desktop, so that the name keeps pointing at it.`,
    "",
    "On a Windows laptop",
    `  3. Carry ${CA_FILE} over, on a USB stick for example. In PowerShell: Get-FileHash ${CA_FILE}`,
    "     Compare with the SHA-256 above. If it differs, stop: that is not this desktop's certificate.",
    `  4. certutil -user -addstore Root ${CA_FILE}   (and answer yes; it needs no administrator)`,
    "  5. In Notepad as administrator, add this line to C:\\Windows\\System32\\drivers\\etc\\hosts:",
    `       ${ip} ${f.name}`,
    `  6. Close the browser completely, then open https://${f.name}:${f.port}`,
    "",
    "On a Mac (Safari, Chrome)",
    `  3. shasum -a 256 ${CA_FILE}, and compare with the SHA-256 above.`,
    `  4. security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db ${CA_FILE}`,
    `  5. sudo sh -c 'echo "${ip} ${f.name}" >> /etc/hosts', then open https://${f.name}:${f.port}`,
    "Firefox, if it still warns: Settings > Privacy & Security > Certificates > Import.",
    `The ${BRAND.name} app on a phone needs none of this and its pin does not change.`,
    "",
    `To undo it: ${BRAND.slug} lan-cert remove`,
  ];
}

/** How a laptop stops trusting a CA. Pure. */
export function untrustLines(caSha1: string, name: string): string[] {
  return [
    `  Windows: certutil -user -delstore Root ${caSha1}`,
    `           then take the ${name} line out of the hosts file, and delete its passkey under Settings > Accounts > Passkeys`,
    `  macOS:   security delete-certificate -Z ${caSha1} ~/Library/Keychains/login.keychain-db`,
    `           then take the ${name} line out of /etc/hosts`,
    `  Also clear the site data of ${name} in the browser, and revoke that browser under Settings > Connection > Paired devices.`,
  ];
}

/**
 * The service's environment, for what this shell does not say itself: the daemon runs with it, and the
 * state dir, the port and the LAN knobs must be read as the daemon reads them. Before `env.ts` loads,
 * so that its `.env` files come below both, as they do in the daemon.
 */
function adoptServiceEnv(): void {
  const prefixes = [BRAND.envPrefix, ...LEGACY.map((l) => l.envPrefix)];
  for (const [k, v] of Object.entries(installedServiceEnv()?.env ?? {})) {
    if (k !== "XDG_STATE_HOME" && !prefixes.some((p) => k.startsWith(p))) continue;
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

export interface LanCertDeps {
  /** The daemon's root; given, the service's environment is not consulted. */
  root?: string;
  now?: Date;
  ips?: string[];
  restart?: string;
  /** The y/N question; null when there is no terminal to ask on. */
  ask?: ((question: string) => Promise<boolean>) | null;
}

async function askOnTty(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // A closed input (ctrl-D) never answers the question; it is a no.
  try { return /^y(es)?$/i.test((await Promise.race([rl.question(question), new Promise<string>((r) => rl.once("close", () => r("")))])).trim()); }
  finally { rl.close(); }
}

async function restartLine(): Promise<string> {
  const { identity } = await import("./index.js");
  if (identity().source === "checkout") return "npm run restart";
  if (!installedServiceEnv()) return `stop it, then ${BRAND.slug} start`;
  return process.platform === "darwin" ? `launchctl kickstart -k gui/${process.getuid?.() ?? 0}/${BRAND.launchdLabel}` : `systemctl --user restart ${BRAND.slug}`;
}

const say = (lines: string[]): void => { for (const l of lines) console.log(l); };
const fail = (sentence: string): number => { console.error(`${BRAND.slug}: lan-cert: ${sentence}`); return 1; };
const errText = (e: unknown): string => (e as NodeJS.ErrnoException).code ?? (e as Error).message;

/** Why `ca.cer` cannot go to `dir`, or null. One already there is replaced only when it is the one issued before. */
function outRefusal(dir: string, previous: BrowserLeaf | null): string | null {
  try { if (!statSync(dir).isDirectory()) return `${dir} is not a folder. Pass another one with --out.`; }
  catch (e) { return `${dir} cannot be used (${errText(e)}). Pass an existing folder with --out.`; }
  const file = join(dir, CA_FILE);
  try { if (!lstatSync(file).isFile()) return `${file} is not a plain file. Move it away, or pass another folder with --out.`; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : `${file} cannot be read (${errText(e)}). Pass another folder with --out.`; }
  let sum = "";
  try { sum = createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase(); } catch { /* not ours to replace */ }
  return previous && sum === previous.caSha256 ? null : `${file} is there already and is not the certificate this desktop issued last. Move it away, or pass another folder with --out.`;
}

/**
 * `file`, whole and flushed, in place of what is there: written beside it first, so a full disk leaves the one
 * that is there. The file beside it refuses one that exists, and the rename replaces a link, so no link is followed.
 */
function placeFile(file: string, bytes: Uint8Array): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "wx", 0o644);
  try {
    try { writeAll(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

async function issue(a: LanCertArgs, root: string, d: LanCertDeps): Promise<number> {
  const { browserCertFile, browserNameRefusal, certDer, dialedNameRefusal, isBrowserCertProblem, issueBrowserCert, readBrowserCert } = await import("../lanca.js");
  const { lanTlsPlan, readLanTlsKey } = await import("../lantls.js");
  const { env } = await import("../env.js");
  const { lanIps } = await import("../net.js");
  const { writeJsonAtomic } = await import("../jsonstore.js");
  const name = a.name!;
  const bad = browserNameRefusal(name, a.anyName) ?? dialedNameRefusal(name);
  if (bad) return fail(bad);
  const key = readLanTlsKey(root);
  if ("refused" in key) {
    return fail(key.missing
      ? `${key.refused}. ${env("TLS_CERT") || env("TLS_KEY") ? `${envName("TLS_CERT")} and ${envName("TLS_KEY")} are set, so the host serves that certificate and never makes this file, and starting it again will not help. Unset both and restart the host with ${envName("ALLOW_PUBLIC")}=1 on a machine with a LAN address, then run this again. ` : ""}The host makes it: start the host once with ${envName("ALLOW_PUBLIC")}=1 on a machine with a LAN address, then run this again.`
      : `${key.refused}. Make it readable, or restore it from a backup. This command never makes a new one, because every paired phone trusts the key in it.`);
  }
  const now = d.now ?? new Date();
  const dir = resolve(a.out ?? ".");
  const held = readBrowserCert(root, null, now);
  const before = isBrowserCertProblem(held) ? held.was ?? null : held;
  const noOut = outRefusal(dir, before);
  if (noOut) return fail(noOut);
  if (!isBrowserCertProblem(held) || held.problem !== "missing") {
    say([
      before
        ? `This desktop already has a certificate for ${before.name}, until ${day(before.notAfter)}. A new one replaces it: each laptop that trusts the old one must trust the new one.`
        : `There is already a certificate file here that cannot be used (${(held as { why: string }).why}). A new certificate replaces it.`,
      ...(before && before.name !== name ? [`Passkeys made for ${before.name} stop working, because a passkey belongs to its name.`] : []),
      ...(before ? [`The old one on a laptop has the SHA-1 ${before.caSha1}. To take it off:`, ...untrustLines(before.caSha1, before.name).filter((l) => /certutil|security/.test(l))] : []),
    ]);
    if (!a.yes) {
      if (!d.ask) return fail("there is no terminal to ask on, so nothing was replaced. Run it in a terminal, or pass --yes.");
      if (!(await d.ask("Replace it? [y/N] "))) { console.log("Nothing was changed."); return 1; }
    }
    console.log("");
  }
  const cert = issueBrowserCert(key, name, now);
  const caFile = join(dir, CA_FILE);
  const stateFile = browserCertFile(root);
  // The public file is on disk before the record changes, so a full or read-only folder changes nothing,
  // and a record that cannot be saved puts the folder back as it was.
  let old: Buffer | null = null;
  const putBack = (): string => {
    try { if (old) placeFile(caFile, old); else rmSync(caFile, { force: true }); return "Nothing was changed."; }
    // Never left looking like the certificate in use: the old one is in the old record's caCert too.
    catch { try { rmSync(caFile, { force: true }); } catch { /* said below */ } return `The old record is unchanged, but ${caFile} could not be put back. Do not trust a file there.`; }
  };
  try {
    if (existsSync(caFile)) old = readFileSync(caFile);
    placeFile(caFile, certDer(cert.caCert));
  } catch (e) { return fail(`${caFile} could not be written (${errText(e)}). Nothing was changed. Pass another folder with --out.`); }
  try { writeJsonAtomic(stateFile, cert, { mode: 0o600, space: 1 }); }
  catch (e) { return fail(`${stateFile} could not be written (${errText(e)}). ${putBack()}`); }

  const ips = d.ips ?? lanIps();
  const hostEnv = env("HOST");
  const plainPort = Number(env("PORT") || 8770);
  const plan = lanTlsPlan({ allowPublic: env("ALLOW_PUBLIC") === "1", plainPort, boundLan: ips, binds: hostEnv ? [hostEnv] : ips });
  const notes = [
    ...("why" in plan ? [`Note: the host has no encrypted LAN port as things stand (${plan.why}), so nothing serves this certificate yet.`] : []),
    ...(env("TLS_CERT") || env("TLS_KEY") ? [`Note: ${envName("TLS_CERT")} and ${envName("TLS_KEY")} take the port, so this certificate is not served. Unset both to use it.`] : []),
  ];
  say([
    ...issuedLines({
      name, caFile, caSha256: cert.caSha256, caSha1: cert.caSha1, notAfter: new Date(cert.notAfter), stateFile,
      ips: "why" in plan ? ips : plan.addrs, port: "why" in plan ? plainPort + 1 : plan.port, restart: d.restart ?? await restartLine(),
    }),
    ...(notes.length ? ["", ...notes] : []),
  ]);
  return 0;
}

async function show(root: string, d: LanCertDeps): Promise<number> {
  const { browserCertFile, dialedFix, dialedNameRefusal, isBrowserCertProblem, readBrowserCert } = await import("../lanca.js");
  const { readLanTlsKey } = await import("../lantls.js");
  const key = readLanTlsKey(root);
  const c = readBrowserCert(root, "refused" in key ? null : key, d.now);
  const leaf = isBrowserCertProblem(c) ? c.was : c;
  if (leaf) {
    say([
      `Name          ${leaf.name}`,
      `Valid until   ${day(leaf.notAfter)}${leaf.daysLeft >= 0 ? `   (${days(leaf.daysLeft)} left)` : ""}`,
      `CA SHA-256    ${leaf.caSha256}`,
      `CA SHA-1      ${leaf.caSha1}`,
      `Kept here     ${browserCertFile(root)}`,
    ]);
  }
  if (isBrowserCertProblem(c)) {
    if (c.problem === "missing") { console.log(`No browser certificate has been issued on this desktop. ${c.fix}`); return 0; }
    // A name phones dial cannot be re-issued, so its own fix would be refused: say the real way out first.
    const d0 = c.was ? dialedNameRefusal(c.was.name) : null;
    if (c.was && d0) return fail(`the certificate is not served: ${d0} ${dialedFix(c.was.name, BRAND.slug)}`);
    return fail(`the certificate is not served: ${c.why}. ${c.fix}`);
  }
  const dialed = dialedNameRefusal(c.name);
  if (dialed) return fail(`the certificate is not served: ${dialed} ${dialedFix(c.name, BRAND.slug)}`);
  if ("refused" in key) return fail(`the certificate cannot be checked against this desktop's key: ${key.refused}.`);
  return 0;
}

async function remove(root: string, d: LanCertDeps): Promise<number> {
  const { browserCertFile, isBrowserCertProblem, readBrowserCert } = await import("../lanca.js");
  const held = readBrowserCert(root, null, d.now);
  if (isBrowserCertProblem(held) && held.problem === "missing") { console.log("There is no browser certificate on this desktop. Nothing was changed."); return 0; }
  const was = isBrowserCertProblem(held) ? held.was ?? null : held;
  const file = browserCertFile(root);
  try { rmSync(file); } catch (e) { return fail(`${file} could not be removed (${errText(e)}). Nothing was changed.`); }
  say([
    `Removed ${file}. Restart the host to stop serving it: ${d.restart ?? await restartLine()}`,
    "",
    "On each laptop that trusted it:",
    ...(was ? untrustLines(was.caSha1, was.name) : [
      `  The file could not be read, so its SHA-1 is not known here. Look for a root named "${BRAND.name} <name> <8 letters and digits>" in certmgr.msc or Keychain Access and delete it.`,
    ]),
    "",
    "A laptop that still trusts it is safe only while the key in this desktop's lan-tls.json stays private:",
    "nobody can sign another certificate under it, and the one that was signed needs that key.",
  ]);
  return 0;
}

export async function run(args: string[], deps: LanCertDeps = {}): Promise<number> {
  const a = parseLanCertArgs(args);
  if ("error" in a) { console.error(`${BRAND.slug}: lan-cert: ${a.error}\n\n${LAN_CERT_HELP}`); return 2; }
  if (a.cmd === "help") { console.log(LAN_CERT_HELP); return 0; }
  if (!deps.root) adoptServiceEnv();
  const root = deps.root ?? (await import("../env.js")).ROOT;
  const d: LanCertDeps = { ...deps, ask: deps.ask !== undefined ? deps.ask : process.stdin.isTTY && process.stdout.isTTY ? askOnTty : null };
  return a.cmd === "issue" ? issue(a, root, d) : a.cmd === "show" ? show(root, d) : remove(root, d);
}
