// Logging proxy: PORT -> UPSTREAM; appends one JSON line per /v1/messages request.
import http from "node:http";
import { appendFileSync } from "node:fs";
const PORT = +process.env.PORT, UP = process.env.UPSTREAM, LOG = process.env.LOG;
http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    let j = null; try { j = JSON.parse(body.toString()); } catch {}
    if (j && req.url.includes("/messages")) {
      const sys = Array.isArray(j.system) ? j.system.map((b) => b.text || "").join("\n") : (j.system || "");
      const msgs = (j.messages || []).map((m) => typeof m.content === "string" ? m.content : (m.content || []).map((b) => b.text || (b.type === "tool_result" ? JSON.stringify(b.content) : b.type === "tool_use" ? `[tool_use ${b.name} ${JSON.stringify(b.input)}]` : "")).join("\n"));
      appendFileSync(LOG, JSON.stringify({ at: Date.now(), url: req.url, model: j.model, max_tokens: j.max_tokens, sysChars: sys.length, tools: (j.tools || []).map((t) => t.name), toolChars: JSON.stringify(j.tools || []).length, nMsgs: msgs.length, msgChars: msgs.reduce((a, s) => a + s.length, 0), bodyChars: body.length, system: process.env.FULL ? sys : undefined, messages: process.env.FULL ? msgs : undefined }) + "\n");
    }
    const headers = { ...req.headers }; delete headers.host; delete headers["content-length"];
    try {
      const r = await fetch(UP + req.url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body, duplex: "half" });
      res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !["content-encoding", "content-length", "transfer-encoding"].includes(k))));
      if (r.body) for await (const c of r.body) res.write(c);
      res.end();
    } catch (e) { console.error(e); res.writeHead(502, { "content-type": "text/plain" }); res.end("upstream request failed\n"); }
  });
}).listen(PORT, "127.0.0.1");
