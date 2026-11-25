// Who holds an e2e port that the runner may not clear (`run-e2e.mjs`): a program that is not one
// of our hosts, named so a person can stop it. Pure parsing plus one `lsof`; pinned by
// `tools/portholder.test.mjs`.
import { execFileSync } from "node:child_process";

const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch (e) { return String(e?.stdout ?? ""); } };

/** The pids in `lsof -F pn` output that listen where a host's IPv4 bind would collide. */
export function listenerPids(out) {
  const pids = new Set();
  let pid = null;
  for (const line of out.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    // `[::1]:8799` alone leaves 127.0.0.1 free, and a script only binds IPv4.
    else if (line[0] === "n" && pid && /^n(\*|127\.0\.0\.1|0\.0\.0\.0):\d+$/.test(line)) pids.add(pid);
  }
  return [...pids];
}

/** The program listening on `port`, or null. A host we just killed is given `graceMs` to let go.
 *  No `lsof` reads as "nobody": the script's own bind error still reports it, as before. */
export async function foreignHolder(port, graceMs = 3000) {
  const until = Date.now() + graceMs;
  for (;;) {
    const [pid] = listenerPids(run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pn"]));
    if (!pid) return null;
    if (Date.now() >= until) {
      const cwd = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-F", "n"]).split("\n").find((l) => l[0] === "n");
      return { pid, cmd: run("ps", ["-o", "command=", "-p", String(pid)]).trim().slice(0, 100) || "?", cwd: cwd ? cwd.slice(1) : "" };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export function heldLine(file, port, by) {
  return `[run-e2e] ${file}: NOT RUN — port ${port} is held by \`${by.cmd}\` (pid ${by.pid}${by.cwd ? `, in ${by.cwd}` : ""}), which is not a test host, so it is left alone. Stop it, then run this again.`;
}
