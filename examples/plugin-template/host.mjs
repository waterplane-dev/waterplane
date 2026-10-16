// The template plugin's host module. The daemon imports this file once at boot and calls
// activate(api) with the HostPluginApi from docs/plugins-api.md. Everything a plugin may do
// goes through `api`; replace the action below with your own.
import fs from "node:fs";
import path from "node:path";

export function activate(api) {
  api.on("action", ({ action, sessionId }) => {
    if (action !== "save-screen") return { ok: false, message: `Unknown action ${action}.` };
    const session = sessionId ? api.session(sessionId) : null;
    if (!session) return { ok: false, message: "That session has ended." };
    const lines = Number(api.settings().lines);
    const text = api.scrollback(session.id, lines);
    // api.dataDir is this plugin's own folder under the daemon's state dir.
    const file = path.join(api.dataDir, `${session.id}-${Date.now()}.txt`);
    fs.mkdirSync(api.dataDir, { recursive: true });
    fs.writeFileSync(file, text);
    api.log(`saved ${lines} lines of ${session.title} to ${file}`);
    return { ok: true, message: `Saved the last ${lines} lines of "${session.title}" to ${file}.` };
  });
}

export function deactivate() {}
