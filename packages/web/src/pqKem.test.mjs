/**
 * `pqKem.ts`: ML-KEM-768 on the page — the pure-JS fallback and the WebCrypto path agree byte for
 * byte (each decapsulates what the other encapsulated), sizes are FIPS 203's, and `pqKem()` picks
 * one implementation once per page.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { nobleKem, pqKem, subtleKem } from "./pqKem.ts";

const hex = (b) => Buffer.from(b).toString("hex");

test("noble ML-KEM-768: sizes and a round trip", async () => {
  const k = await nobleKem();
  const p = await k.keygen();
  const { ct, ss } = await k.encapsulate(p.ek);
  assert.deepEqual([p.ek.length, ct.length, ss.length], [1184, 1088, 32]);
  assert.equal(hex(await p.decapsulate(ct)), hex(ss));
});

test("WebCrypto and noble interoperate both ways (where WebCrypto has ML-KEM)", async (t) => {
  const s = globalThis.crypto?.subtle;
  if (typeof s?.encapsulateBits !== "function") { t.skip("this runtime's WebCrypto has no ML-KEM"); return; }
  const w = subtleKem(s), n = await nobleKem();
  for (const [a, b] of [[w, n], [n, w]]) {
    const p = await a.keygen();
    const { ct, ss } = await b.encapsulate(p.ek);
    assert.equal(hex(await p.decapsulate(ct)), hex(ss), `${b.name} → ${a.name}`);
  }
});

test("pqKem(): one implementation per page, and it works", async () => {
  const a = await pqKem(), b = await pqKem();
  assert.equal(a, b);
  assert.match(a.name, /ML-KEM-768/);
  const p = await a.keygen();
  const { ct, ss } = await a.encapsulate(p.ek);
  assert.equal(hex(await p.decapsulate(ct)), hex(ss));
});
