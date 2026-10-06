/**
 * `<slug> pair` — mint a pairing code on THIS desktop's running daemon and
 * print what a phone needs: the landing URL, the deep link and the 8-character
 * code. For a desktop nobody can show a QR on yet (a headless VM): read it over
 * ssh, paste it into the phone's "Add a desktop".
 *
 * It asks the daemon over LOOPBACK (`POST /api/pair/mint`, which a loopback
 * caller may always do) — the same route the phone's QR sheet uses, so there is
 * one mint and one set of rules (single use, 10 minutes, hashed in memory).
 *
 * No terminal QR: the only QR encoder in the repo (`qrcode-generator`) is a
 * dependency of `packages/web`, and a release's host does not carry it; a new
 * dependency for a convenience the URL + code already cover is not worth it.
 */
import { BRAND, formatPairCode, type PairMintResponse } from "@waterplane/shared";

export interface PairArgs { port: number | null; json: boolean; help: boolean }

/** `pair [--port N] [--json] [--help]` → the options, or a sentence saying what was wrong. */
export function parsePairArgs(args: string[]): PairArgs | { error: string } {
  const out: PairArgs = { port: null, json: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--port" || a.startsWith("--port=")) {
      const v = a === "--port" ? args[++i] : a.slice("--port=".length);
      const n = Number(v);
      if (!v || !Number.isInteger(n) || n < 1 || n > 65535) return { error: `--port needs a number between 1 and 65535, got "${v ?? ""}".` };
      out.port = n;
    } else return { error: `unknown option "${a}".` };
  }
  return out;
}

export const PAIR_HELP = `usage: ${BRAND.slug} pair [--port N] [--json]

  Mint a single-use pairing code on this desktop's running host and print the
  landing URL, the web app's URL, the deep link and the code. On the phone, open "Add a desktop"
  and paste the URL (or the address and the code). The code lasts 10 minutes.
`;

/** What is printed for a minted code. Pure. */
export function pairLines(m: PairMintResponse): string[] {
  const lines = [
    `Pairing code   ${formatPairCode(m.code)}   (works once, expires in 10 minutes)`,
    `Address        ${m.base.replace(/^https?:\/\//, "")}`,
    `Web app        ${m.base}/   (open in the phone's browser: no install needed)`,
    `Landing URL    ${m.landingUrl}`,
    `Deep link      ${m.deepLink}`,
  ];
  if (m.lanBase) lines.push(`LAN address    ${m.lanBase.replace(/^https?:\/\//, "")}`);
  lines.push("", `On the phone: open the landing URL in its browser (it offers the web app and the Android app), or in ${BRAND.name} -> Hosts -> add -> pair with code, paste it (or type the address and the code).`);
  return lines;
}

export async function run(args: string[], fetchImpl: typeof fetch = fetch): Promise<number> {
  const a = parsePairArgs(args);
  if ("error" in a) { console.error(`${BRAND.slug}: pair: ${a.error}\n\n${PAIR_HELP}`); return 2; }
  if (a.help) { console.log(PAIR_HELP); return 0; }
  let port = a.port;
  if (port === null) {
    // Loaded here, not at the top: `env.js` reads the .env files (so a PORT set
    // there is honoured) and the other commands never need it.
    const { env } = await import("../env.js");
    port = Number(env("PORT") || 8770);
  }
  let r: Response;
  try {
    r = await fetchImpl(`http://127.0.0.1:${port}/api/pair/mint`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  } catch {
    console.error(`${BRAND.slug}: pair: nothing answered on 127.0.0.1:${port}. Is the host running? Start it with "${BRAND.slug} start" (or pass --port).`);
    return 1;
  }
  if (!r.ok) {
    console.error(`${BRAND.slug}: pair: the host refused to mint a code (${r.status}).`);
    return 1;
  }
  const m = (await r.json()) as PairMintResponse;
  if (a.json) console.log(JSON.stringify(m));
  else for (const l of pairLines(m)) console.log(l);
  return 0;
}
