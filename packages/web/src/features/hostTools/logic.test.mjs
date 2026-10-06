/**
 * The host tools' words: the load toast, the serve command, the endpoint list
 * and the sign-in code check.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { endpoints, hostStatText, loginCodeProblem, serveCmd } from "./logic.ts";

test("the host load reads as one line", () => {
  assert.equal(
    hostStatText({ cpuPct: 12, loadavg: [1, 0.5, 0.25], cores: 8, memTotal: 16e9, memFree: 4e9 }),
    "CPU 12% · load 1.00/0.50/0.25 · 8 cores · mem 12.0/16.0G",
  );
});

test("the serve command splices the resolved binary and the port", () => {
  assert.equal(serveCmd({ tailscaleBin: null, hostPort: 8770 }), "tailscale serve --bg --https=443 http://127.0.0.1:8770");
  assert.equal(serveCmd({ tailscaleBin: "/Applications/T.app/tailscale", hostPort: 9 }), "/Applications/T.app/tailscale serve --bg --https=443 http://127.0.0.1:9");
});

test("endpoints: https first, then the tailnet IP, then each LAN IP; absent ones skipped", () => {
  const all = endpoints({ httpsUrl: "https://h.ts.net", tailscaleIp: "100.1.2.3", lanIps: ["192.168.1.5"], hostPort: 8770 });
  assert.deepEqual(all.map((e) => e.url), ["https://h.ts.net", "http://100.1.2.3:8770", "http://192.168.1.5:8770"]);
  assert.deepEqual(endpoints({ httpsUrl: null, tailscaleIp: null, lanIps: [], hostPort: 1 }), []);
});

test("a sign-in code is refused empty or with whitespace, and said why", () => {
  assert.match(loginCodeProblem(""), /empty/);
  assert.match(loginCodeProblem("ab cd"), /does not look like a code/);
  assert.equal(loginCodeProblem("abc123"), null);
});
