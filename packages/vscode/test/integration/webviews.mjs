// Looks INSIDE the extension's webviews over the Chrome DevTools protocol, which VS Code's API
// cannot: a webview whose script threw at mount is an empty page to the API and a passing test.
// (That happened: two copies of React in dist/webview.js left the panel blank while the sidebar,
// which never touched the second copy, rendered.)
//
// Each VS Code webview is an outer `vscode-webview://…/index.html` frame holding the page in a
// same-origin `#active-frame` iframe; `#root[data-mode]` is ours (panel.ts `webviewHtml`).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One DevTools session on a target: `call(method, params)` plus every error event seen. */
async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.description ?? a.value).join(" "));
  });
  const call = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await call("Runtime.enable"); // replays what the page already logged, so an error at mount is seen
  return { call, errors, close: () => ws.close() };
}

const READ = `(() => {
  const d = document.querySelector("iframe#active-frame")?.contentDocument;
  const r = d?.getElementById("root");
  return JSON.stringify(r ? { mode: r.dataset.mode, children: r.childElementCount, text: r.innerText.length } : null);
})()`;

/**
 * Waits until every mode in `want` ("panel") has a webview whose root rendered
 * something, with no uncaught error in any of ours. Returns `{ ok, why, seen }`.
 */
export async function probeWebviews(port, want, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  let seen = {};
  const errors = new Set();
  while (Date.now() < end) {
    let targets = [];
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(500); continue; }
    seen = {};
    for (const t of targets.filter((x) => x.type === "iframe" && x.url.startsWith("vscode-webview://") && x.url.includes("/index.html") && x.webSocketDebuggerUrl)) {
      let s;
      try { s = await attach(t.webSocketDebuggerUrl); } catch { continue; }
      try {
        const v = JSON.parse((await s.call("Runtime.evaluate", { expression: READ })).result?.result?.value ?? "null");
        if (v?.mode) {
          seen[v.mode] = v;
          for (const e of s.errors) errors.add(`${v.mode}: ${String(e).split("\n").slice(0, 2).join(" | ")}`);
        }
      } finally { s.close(); }
    }
    if (errors.size) return { ok: false, why: [...errors].join("\n"), seen };
    if (want.every((m) => seen[m]?.children > 0 && seen[m]?.text > 0)) return { ok: true, seen };
    await sleep(500);
  }
  const missing = want.filter((m) => !(seen[m]?.children > 0 && seen[m]?.text > 0));
  return { ok: false, why: `no rendered content after ${timeoutMs / 1000}s in: ${missing.join(", ")} (seen ${JSON.stringify(seen)})`, seen };
}

/**
 * Waits until the panel shows view `tabId` (picked by the suite through `waterplane.show`) and its
 * text contains every string in `needles`. Returns `{ ok, why, text }`, `text` as last seen.
 */
export async function probePanelText(port, tabId, needles, _click = null, timeoutMs = 30_000) {
  return probeRootText(port, "panel", tabId, needles, timeoutMs);
}

async function probeRootText(port, mode, tabId, needles, timeoutMs) {
  const end = Date.now() + timeoutMs;
  const expr = `(() => {
    const d = document.querySelector("iframe#active-frame")?.contentDocument;
    const r = d?.getElementById("root");
    if (!r || r.dataset.mode !== ${JSON.stringify(mode)}) return null;
    if (${JSON.stringify(tabId)} && !d.getElementById(${JSON.stringify("panel-" + tabId)})) return null;
    return r.innerText;
  })()`;
  let text = "";
  while (Date.now() < end) {
    let targets = [];
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(500); continue; }
    for (const t of targets.filter((x) => x.type === "iframe" && x.url.startsWith("vscode-webview://") && x.url.includes("/index.html") && x.webSocketDebuggerUrl)) {
      let s;
      try { s = await attach(t.webSocketDebuggerUrl); } catch { continue; }
      try {
        const v = (await s.call("Runtime.evaluate", { expression: expr })).result?.result?.value;
        if (typeof v === "string") text = v;
      } finally { s.close(); }
    }
    if (needles.every((n) => text.includes(n))) return { ok: true, text };
    await sleep(500);
  }
  const missing = needles.filter((n) => !text.includes(n));
  return { ok: false, why: `the ${tabId ?? mode} view never showed: ${missing.map((m) => JSON.stringify(m)).join(", ")} (it showed ${JSON.stringify(text.slice(0, 600))})`, text };
}
