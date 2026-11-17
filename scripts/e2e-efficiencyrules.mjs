// `GET`/`POST /api/repos/:id/efficiencyrules` through a live host (`efficiencywrite.ts`,
// R-instructions-014): the generic efficiency-rules block into a repo's own instruction file.
//
// Asserts:
//   1. the GET lists both files, suggests one, and mints a confirm token
//   2. the POST is refused without an Origin, without the token, and cross-origin — nothing written
//   3. with Origin + token + the sha it was drawn from, the block is written; nothing is committed
//   4. the same token a second time is refused (one-shot)
//   5. afterwards the GET says up to date and mints no token
//   6. a block edited by hand is refused in words and left byte for byte
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { bootHost } from "./lib-e2e.mjs";
import { watchdog } from "./lib-watchdog.mjs";

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };

const h = await bootHost({ tag: "efficiencyrules", quiet: true });
const dog = watchdog(async () => { console.log("FAIL: e2e-efficiencyrules hung"); await h.stop(); process.exit(1); }, 60_000);

async function api(path, { method = "GET", body, origin = method === "POST" ? h.base : undefined } = {}) {
  const r = await fetch(h.base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(origin ? { origin } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* not json */ }
  return { status: r.status, json };
}

try {
  const made = await api("/api/repo", { method: "POST", body: { name: "eff" } });
  check(made.status === 200 && !!made.json?.path, `a repo to write into (${made.status})`);
  const dir = made.json.path;
  const id = (await api("/api/repos")).json?.targets?.find((t) => t.repoName === "eff")?.id;
  check(!!id, "the repo is discovered");
  // A CLAUDE.md of the person's own, committed, so "never commits" is visible in git.
  writeFileSync(join(dir, "CLAUDE.md"), "# eff\n\nMy own rules.\n");
  execFileSync("git", ["add", "CLAUDE.md"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-qm", "own"], { cwd: dir });
  const head0 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const url = `/api/repos/${id}/efficiencyrules`;

  const g = (await api(url)).json;
  const claude = g?.targets?.find((t) => t.target === "CLAUDE.md");
  const agents = g?.targets?.find((t) => t.target === "AGENTS.md");
  check(g?.ok && g.suggested === "CLAUDE.md" && claude?.plan === "append" && typeof g.confirm === "string", `the GET draws the confirm (${JSON.stringify({ s: g?.suggested, p: claude?.plan })})`);
  check(agents?.plan === "refuse" && /second instruction file/.test(agents?.why ?? ""), "AGENTS.md is refused beside an existing CLAUDE.md");
  check(typeof g?.block === "string" && g.block.includes("efficiency-rules:start v1"), "the GET shows the exact block");

  const body = { target: "CLAUDE.md", confirm: g.confirm, baseSha: claude.sha };
  const noOrigin = await api(url, { method: "POST", body, origin: null });
  check(noOrigin.status === 403, `an Origin-less POST is refused (${noOrigin.status})`);
  const noToken = await api(url, { method: "POST", body: { ...body, confirm: undefined } });
  check(noToken.status === 403, `a POST without the confirm token is refused (${noToken.status})`);
  const evil = await api(url, { method: "POST", body, origin: "https://evil.example" });
  check(evil.status === 403, `a cross-origin POST is refused (${evil.status})`);
  const wrongTarget = await api(url, { method: "POST", body: { ...body, target: "AGENTS.md" } });
  check(wrongTarget.status === 403, `the token does not cover a file the screen did not offer (${wrongTarget.status})`);
  check(readFileSync(join(dir, "CLAUDE.md"), "utf8") === "# eff\n\nMy own rules.\n", "nothing was written by any refused POST");

  const ok = await api(url, { method: "POST", body });
  check(ok.status === 200 && ok.json?.written === true && ok.json?.plan === "append", `the confirmed POST writes (${ok.status} ${JSON.stringify(ok.json?.plan)})`);
  const after = readFileSync(join(dir, "CLAUDE.md"), "utf8");
  check(after.startsWith("# eff\n\nMy own rules.\n") && after.includes("<!-- efficiency-rules:end -->"), "the block is appended after the person's words");
  check(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim() === head0, "nothing was committed");

  const again = await api(url, { method: "POST", body });
  check(again.status === 403, `the same token twice is refused (${again.status})`);

  const g2 = (await api(url)).json;
  check(g2?.targets?.find((t) => t.target === "CLAUDE.md")?.plan === "upToDate" && g2.present === true && g2.confirm === undefined, "afterwards: up to date, no token minted");

  const edited = after.replace("Keep output short.", "Keep output short, always.");
  writeFileSync(join(dir, "CLAUDE.md"), edited);
  const g3 = (await api(url)).json;
  const c3 = g3?.targets?.find((t) => t.target === "CLAUDE.md");
  check(c3?.plan === "refuse" && /changed by hand/.test(c3?.why ?? "") && g3.confirm === undefined, "an edited block is refused in words, no token");
  check(readFileSync(join(dir, "CLAUDE.md"), "utf8") === edited, "the edited file is left byte for byte");
} catch (e) {
  console.log(`FAIL: ${e?.stack ?? e}`);
  failed = true;
} finally {
  clearTimeout(dog);
  await h.stop();
}
process.exit(failed ? 1 : 0);
