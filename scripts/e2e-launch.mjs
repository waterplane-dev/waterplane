import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";
import { waitForHost } from "./lib-e2e.mjs";
const PORT = 8801;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-l-`));
// Self-contained stub `claude` that prints its args then blocks — lets us
// assert that launch flags (--model/--effort/--permission-mode) reach the process.
const STUB = join(ROOT, "echoargs.sh");
writeFileSync(STUB, "#!/bin/bash\necho \"ARGS:$@\"\nread x\n");
chmodSync(STUB, 0o755);
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CLAUDE_BIN]: STUB };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore","pipe","pipe"] });
host.stderr.on("data", d=>process.stderr.write("[host] "+d));
const base=`http://127.0.0.1:${PORT}`;
let failed=false; const check=(c,l)=>{console.log(`${c?"PASS":"FAIL"}: ${l}`); if(!c)failed=true;};
const b64=s=>Buffer.from(s,"base64").toString("utf8");
waitForHost(PORT).then(async () => {
  const repo=await fetch(`${base}/api/repo`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"l"})}).then(r=>r.json());
  const ws=new WebSocket(`ws://127.0.0.1:${PORT}/ws`); let sid=null,cap="";
  ws.on("open",()=>ws.send(JSON.stringify({t:"hello",protocol:1})));
  ws.on("message",raw=>{const m=JSON.parse(raw.toString());
    if(m.t==="welcome") ws.send(JSON.stringify({t:"session.create",cwd:repo.path,cols:80,rows:24,launch:{model:"opus",effort:"high",permissionMode:"plan"}}));
    else if(m.t==="session.created"){ sid=m.session.id;
      check(m.session.model==="opus"&&m.session.effort==="high"&&m.session.permissionMode==="plan","SessionInfo carries model/effort/permission"); }
    else if(m.t==="pty"&&m.id===sid){ cap+=b64(m.dataB64);
      if(cap.includes("ARGS:")){ const line=cap.split("\n").find(l=>l.includes("ARGS:"));
        check(/--model opus/.test(line)&&/--effort high/.test(line)&&/--permission-mode plan/.test(line),"claude launched with --model/--effort/--permission-mode: "+line.trim());
        ws.close(); host.kill(); setTimeout(()=>process.exit(failed?1:0),100);
      }}
  });
});
watchdog(()=>{console.log("FAIL: timeout");host.kill();process.exit(1);});
