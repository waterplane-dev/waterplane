// A port an e2e script needs and another program holds is NAMED, and the script is not started
// (`scripts/lib-portholder.mjs`, `scripts/run-e2e.mjs`). Real sockets, no host.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { foreignHolder, heldLine, listenerPids } from "../scripts/lib-portholder.mjs";

test("only a listener an IPv4 bind would collide with counts", () => {
  assert.deepEqual(listenerPids("p11\nf3\nn127.0.0.1:8799\np12\nf4\nn*:8799\n"), [11, 12]);
  assert.deepEqual(listenerPids("p13\nf3\nn[::1]:8799\n"), []);
  assert.deepEqual(listenerPids(""), []);
});

test("a held port names its program; a freed one is nobody's", async () => {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  try {
    const by = await foreignHolder(port, 0);
    assert.equal(by?.pid, process.pid);
    assert.match(by.cmd, /node/);
    assert.match(heldLine("e2e-x.mjs", port, by), new RegExp(`NOT RUN — port ${port} is held by .*pid ${process.pid}`));
  } finally { await new Promise((r) => srv.close(r)); }
  assert.equal(await foreignHolder(port, 0), null);
});
