// Any-KIND file transport: the inbox takes documents, not just images.
//
// The upload path was image-shaped end to end — the phone's picker said
// `accept="image/*"` and the host's serve gate only handed back extensions on a
// short VIEWABLE list. So a PDF/zip/odd-extension file could be written into the
// inbox and then never fetched back: an upload the app forgot it had accepted.
//
// Pinned here:
//   • a document (pdf), an archive (zip), an office file (docx) and an
//     extension the list has never heard of all upload AND come back byte-exact
//   • the content-type actually reflects the file (a PDF is not octet-stream)
//   • `x-file-name` is percent-encoded — an umlaut in a document name used to
//     throw at `setRequestHeader`, so the host must decode it back
//   • `.env` is refused on both transport routes (the secret sheet's promise)
//   • widening the SERVE gate did NOT widen DISCOVERY: a repo full of source
//     files must not flood the gallery's "this repo" tab, while the curated
//     outbox still lists whatever an agent drops there
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8815;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-root-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

const base = `http://127.0.0.1:${PORT}`;
const j = (p, opts) => fetch(base + p, opts).then((r) => r.json());
let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };
const done = () => { host.kill(); setTimeout(() => process.exit(failed ? 1 : 0), 100); };

/** Upload raw bytes the way the phone does (body + percent-encoded name header). */
const upload = (id, name, body, type = "application/octet-stream") =>
  fetch(`${base}/api/repos/${id}/inbox`, {
    method: "POST",
    headers: { "x-file-name": encodeURIComponent(name), "content-type": type },
    body,
  }).then((r) => r.json());

bootWait(PORT, 1200, async () => {
  try {
    const repo = await j("/api/repo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "docs" }) });
    const id = (await j("/api/repos")).targets.find((t) => t.worktreePath === repo.path).id;

    // ── every kind of document survives the round trip ─────────────────
    const cases = [
      { name: "report.pdf", bytes: Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n1 0 obj\n", "binary"), mime: "application/pdf" },
      { name: "bundle.zip", bytes: Buffer.from("504b0304140000000800", "hex"), mime: "application/zip" },
      { name: "offer.docx", bytes: Buffer.from("504b03041400060008", "hex"), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      { name: "memo.m4a", bytes: Buffer.from("00000020667479704d3441", "hex"), mime: "audio/mp4" },
      { name: "notes.txt", bytes: Buffer.from("plain text\n"), mime: "text/plain" },
      // Nothing on any list — an inbox file is served because THIS app put it
      // there, not because its extension was foreseen.
      { name: "weird.qqq", bytes: Buffer.from("\u0000\u0001binary payload", "binary"), mime: "application/octet-stream" },
    ];
    for (const c of cases) {
      const up = await upload(id, c.name, c.bytes);
      const rel = up.saved?.[0]?.relPath;
      if (rel !== `.claude/inbox/${c.name}`) { check(false, `upload accepted ${c.name}`); continue; }
      const res = await fetch(`${base}/api/repos/${id}/inbox/${encodeURIComponent(c.name)}`);
      const got = Buffer.from(await res.arrayBuffer());
      check(res.status === 200 && got.equals(c.bytes), `${c.name} uploads and comes back byte-exact`);
      check((res.headers.get("content-type") || "").includes(c.mime.split(";")[0]), `${c.name} served as ${c.mime}`);
    }

    // Non-ASCII name: the client percent-encodes because an HTTP header is
    // Latin-1 and the browser refuses anything else.
    const uml = await upload(id, "Angebot Übersicht.pdf", Buffer.from("%PDF-1.4\n"));
    check(uml.saved?.[0]?.name === "Angebot Übersicht.pdf", "percent-encoded umlaut filename decodes back on the host");
    const umlGet = await fetch(`${base}/api/repos/${id}/inbox/${encodeURIComponent("Angebot Übersicht.pdf")}`);
    check(umlGet.status === 200, "umlaut-named document is fetchable");

    // ── dotenv stays unreadable on both transport routes ───────────────
    writeFileSync(join(repo.path, ".claude", "outbox", "..", "inbox", ".env"), "SECRET=hunter2\n");
    writeFileSync(join(repo.path, ".env"), "SECRET=hunter2\n");
    const envInbox = await fetch(`${base}/api/repos/${id}/inbox/.env`);
    check(envInbox.status === 404, "a .env in the inbox is NOT served (the secret sheet's promise)");
    const envArt = await fetch(`${base}/api/repos/${id}/artifact?path=${encodeURIComponent(".env")}`);
    check(envArt.status === 404, "a .env is NOT served by the artifact route");

    // ── serving widened, discovery did not ─────────────────────────────
    mkdirSync(join(repo.path, "src"), { recursive: true });
    writeFileSync(join(repo.path, "src", "app.ts"), "export const x = 1;\n");
    writeFileSync(join(repo.path, "src", "config.yaml"), "a: 1\n");
    writeFileSync(join(repo.path, ".claude", "outbox", "summary.yaml"), "done: true\n");
    writeFileSync(join(repo.path, ".claude", "outbox", "invoice.pdf"), "%PDF-1.4\n");

    const repoScope = await j(`/api/repos/${id}/artifacts?scope=repo`);
    const names = repoScope.files.map((f) => f.relPath);
    check(!names.includes("src/app.ts") && !names.includes("src/config.yaml"),
      "a whole-repo walk does NOT list source/config files (the gallery would drown)");

    const outScope = await j(`/api/repos/${id}/artifacts?scope=outbox`);
    const outNames = outScope.files.map((f) => f.name);
    check(outNames.includes("summary.yaml") && outNames.includes("invoice.pdf"),
      "the curated outbox lists whatever an agent drops there, including a .yaml report");

    // Not discovered ≠ not serveable: the phone can still open the file it asks for.
    const tsFile = await fetch(`${base}/api/repos/${id}/artifact?path=${encodeURIComponent("src/app.ts")}`);
    check(tsFile.status === 200 && (await tsFile.text()).includes("export const x"),
      "an undiscovered source file is still served when asked for by path");

    // Download still forces an attachment for a document.
    const dl = await fetch(`${base}/api/repos/${id}/inbox/report.pdf?download=1`);
    check(/attachment; filename="report.pdf"/.test(dl.headers.get("content-disposition") || ""),
      "download=1 forces a save-as for a document");
  } catch (e) {
    console.log("FAIL: exception", e);
    failed = true;
  }
  done();
});

setTimeout(() => { console.log("FAIL: timeout"); host.kill(); process.exit(1); }, 30000);
