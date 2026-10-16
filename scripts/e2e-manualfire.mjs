// MANUAL fire (no auto): a tap runs the item, in a conversation of its OWN.
//
// The header here used to say "fire never spawns a session — it needs one already
// open", and that had been false for some time before this change: the tick had
// learnt to open one, and `resolveSessionFor` fell back to it on a hand fire. It
// is false in a stronger way now — a fired work item ALWAYS opens a session for
// itself, hand fire or not, because `{kind:"repo", fresh:true}` is what every
// work item is (`cleanTarget`) and opening one IS running it.
//
// So this pins the shape that survived all of that and is the reason any of it
// exists: the session a PERSON has open is never the one work lands in. A repo
// session is opened first here precisely so that there is something to wrongly
// adopt, and the item still gets its own.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";
import { waitForHost } from "./lib-e2e.mjs";
const PORT = 8806;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-mf-`));
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh" };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore","pipe","pipe"] });
host.stderr.on("data", d=>process.stderr.write("[host] "+d));
const base=`http://127.0.0.1:${PORT}`;
let failed=false; const check=(c,l)=>{console.log(`${c?"PASS":"FAIL"}: ${l}`); if(!c)failed=true;};
waitForHost(PORT).then(async () => {
  const repo = await fetch(`${base}/api/repo`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"mf"})}).then(r=>r.json());
  const ws=new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let added=false, opened=false, fired=false, repoSid=null, itemSid=null;
  ws.on("open",()=>ws.send(JSON.stringify({t:"hello",protocol:1})));
  ws.on("message",raw=>{
    const m=JSON.parse(raw.toString());
    // openRepoSession creates the repo's session → broadcast as "created".
    if(m.t==="session.created"){ if(!repoSid) repoSid=m.session.id; return; }
    if(m.t==="backlog.list"){
      if(!added){ added=true; ws.send(JSON.stringify({t:"backlog.add",text:"echo MANUAL_FIRE_OK",repoDir:repo.path,label:"mf"})); return; }
      const it=m.items[0]; if(!it) return;
      // AUTO stays OFF — open the repo's session, then manually fire into it.
      if(it.status==="queued"&&!opened){ opened=true; ws.send(JSON.stringify({t:"backlog.openRepoSession",repoDir:repo.path})); return; }
      if(it.status==="queued"&&opened&&repoSid&&!fired){ fired=true; ws.send(JSON.stringify({t:"backlog.fire",id:it.id})); }
      if(it.status==="running"&&it.sessionId){ itemSid=it.sessionId; }
    }
  });
  setTimeout(()=>{
    check(fired, "fire sent for queued item (with another session already open in the repo)");
    check(!!repoSid, "host broadcast session.created for the session opened by hand");
    check(!!itemSid, "item went running with a sessionId after manual fire");
    check(itemSid!==repoSid, `the tap opened a session FOR the item, never the one already open (item ${itemSid} vs open ${repoSid})`);
    try{host.kill();}catch{}; setTimeout(()=>process.exit(failed?1:0),100);
  }, 6000);
});
setTimeout(()=>{console.log("FAIL: timeout");host.kill();process.exit(1);},12000);
