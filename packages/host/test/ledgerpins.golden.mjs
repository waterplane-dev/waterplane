// Shared by ledgerpins.test.mjs and the scratch real-log run: digest every
// exported reader of ctxlog.ts / transcript.ts over a set of conversation logs.
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import * as C from "../dist/ctxlog.js";
import * as T from "../dist/transcript.js";

const norm = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (x instanceof Map ? { __map: [...x.entries()] } : x instanceof Set ? { __set: [...x] } : x)));
let SCRUB = [];
export const digest = (v) => {
  let s = JSON.stringify(norm(v));
  for (const d of SCRUB) s = s.split(d).join("<dir>");
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
};

/** `files`: absolute paths of conversation jsonl logs. Returns {name: digest}. */
export function observe(files, cwd = "/work/repo") {
  const out = {};
  SCRUB = [...new Set(files.map((f) => dirname(f)))];
  for (const f of files) {
    const k = basename(f);
    const cur = C.updateContextLog(f);
    out[`${k}:cursor`] = digest(cur);
    out[`${k}:ctx`] = digest(cur && C.projectContextLog(cur));
    out[`${k}:read`] = digest(C.readContextLog(f));
    const dir = f.replace(/\.jsonl$/, "/subagents");
    const ag = C.agentUsage(dir);
    out[`${k}:agents`] = digest(ag);
    if (ag) {
      out[`${k}:cum`] = digest(C.agentCumOf(ag));
      out[`${k}:live`] = digest(C.liveAgentOf(ag, 1_900_000_000_000));
      out[`${k}:env`] = digest(C.agentEnvelope([1, 2, 3], ag.runs.map((r) => ({ ctx: r.ctx }))));
      out[`${k}:runs`] = digest(C.withAgentRuns(["m"], ag.runs.map((r) => ({ ...r, modelId: r.modelId ?? "claude-opus-5" }))));
    }
    if (cur && ag) out[`${k}:spark`] = digest(C.sparkOf(cur, 1_000_000, ag, 1_900_000_000_000));
    out[`${k}:parse`] = digest(T.parseTranscript(f, cwd));
    out[`${k}:full`] = digest(T.parseTranscript(f, cwd, "full"));
    out[`${k}:mtime`] = digest(T.logMtime(f) !== null);
    out[`${k}:lastTurn`] = digest(T.lastTurnAt(f));
    const lines = readFileSync(f, "utf8").split("\n");
    out[`${k}:absorbed`] = digest(T.absorbedOpeners(lines));
    const recs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    out[`${k}:recs`] = digest(recs.map((r) => [T.promptOf(r), T.queuedPromptOf(r), T.localCommandOf(r), T.localOutputOf(r), T.opensTurn(r)]));
    const parsed = T.parseTranscript(f, cwd, "full");
    if (parsed?.turns?.length) out[`${k}:details`] = digest(T.toolDetails(f, cwd, parsed.turns[Math.floor(parsed.turns.length / 2)].id));
    out[`${k}:merge`] = digest(parsed && T.mergeLocalTurns(parsed.turns, T.screenCommandTurns([], parsed.turns)));
  }
  const txt = "line\n──────\n❯ \n  ? for shortcuts\n";
  out.chrome = digest([T.trimTuiChrome(txt), T.scrollHintTrimmed(txt), T.sliceToCommand(txt, "line"), T.foldRepaints(txt, "line"), T.transcriptFromHistory([])]);
  return out;
}
