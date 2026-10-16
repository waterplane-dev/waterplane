import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";
import { waitForHost } from "./lib-e2e.mjs";
const PORT = 8811;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-f-`));
// Stub `claude` that prints its args then blocks — asserts session.fork spawns
// a second session forking EXACTLY the source conversation (--resume <its
// claude session id> --fork-session) while the first stays alive.
const STUB = join(ROOT, "echoargs.sh");
writeFileSync(STUB, "#!/bin/bash\necho \"ARGS:$@\"\nread x\n");
chmodSync(STUB, 0o755);
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CLAUDE_BIN]: STUB };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore","pipe","pipe"] });
host.stderr.on("data", d=>process.stderr.write("[host] "+d));
const base=`http://127.0.0.1:${PORT}`;
let failed=false; const check=(c,l)=>{console.log(`${c?"PASS":"FAIL"}: ${l}`); if(!c)failed=true;};
const b64=s=>Buffer.from(s,"base64").toString("utf8");
const finish=()=>{host.kill();setTimeout(()=>process.exit(failed?1:0),100);};
waitForHost(PORT).then(async () => {
  const repo=await fetch(`${base}/api/repo`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"f"})}).then(r=>r.json());
  const ws=new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let sid=null,fid=null,cap="",focused=false,gotToast=false;
  ws.on("open",()=>ws.send(JSON.stringify({t:"hello",protocol:1})));
  let srcClaudeId=null;
  ws.on("message",raw=>{const m=JSON.parse(raw.toString());
    if(m.t==="welcome") ws.send(JSON.stringify({t:"session.create",cwd:repo.path,cols:80,rows:24,launch:{model:"opus"}}));
    else if(m.t==="session.created"&&!sid){ sid=m.session.id; srcClaudeId=m.session.claudeSessionId;
      check(/^[0-9a-f-]{36}$/.test(srcClaudeId||""),"fresh session carries a minted claudeSessionId: "+srcClaudeId);
      ws.send(JSON.stringify({t:"session.fork",id:sid,cols:80,rows:24})); }
    else if(m.t==="session.created"&&!fid){ fid=m.session.id;
      check(m.session.title.endsWith("(fork)"),"forked session title marked: "+m.session.title);
      check(m.session.cwd===repo.path,"fork shares the source cwd");
      check(m.session.model==="opus","fork inherits launch flags (model)"); }
    else if(m.t==="session.focus"){ focused=m.id===fid;
      check(focused,"requester focused on the fork"); }
    else if(m.t==="pty"&&m.id===fid){ cap+=b64(m.dataB64);
      if(cap.includes("ARGS:")){ const line=cap.split("\n").find(l=>l.includes("ARGS:"));
        check(new RegExp(`--resume ${srcClaudeId} --fork-session`).test(line),"fork targets exactly the source conversation (--resume <id> --fork-session): "+line.trim());
        ws.send(JSON.stringify({t:"session.list"})); }}
    else if(m.t==="session.list"&&fid){ const orig=m.sessions.find(s=>s.id===sid);
      check(!!orig&&orig.running,"original session still running after fork");
      ws.send(JSON.stringify({t:"session.fork",id:"nope"})); }
    else if(m.t==="toast"&&fid&&!gotToast){ gotToast=true;
      check(/not available/.test(m.text),"forking an unknown session toasts: "+m.text);
      ws.close(); finish(); }
  });
});
setTimeout(()=>{console.log("FAIL: timeout");host.kill();process.exit(1);},15000);
