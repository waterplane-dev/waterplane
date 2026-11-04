// Writes update-signature-vector.json beside this file: a real Node signature for
// the JVM tests, so Java is checked against the signer it has to agree with
// (host `crypto.sign` with `dsaEncoding: "ieee-p1363"`) and not only against itself.
// The private key is thrown away. Run: node gen-update-vector.mjs
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey;
const spki = (k) => k.export({ type: "spki", format: "der" }).toString("base64");
const p1363 = (data) => sign("sha256", data, { key: privateKey, dsaEncoding: "ieee-p1363" });

const bundle = {
  "index.html": "<!doctype html><title>vector</title>\n",
  "assets/app.js": "console.log('vector');\n",
  "assets/empty.txt": "",
};
const files = Object.entries(bundle).map(([path, text]) => ({
  path,
  size: Buffer.byteLength(text),
  sha256: createHash("sha256").update(text).digest("hex"),
}));
const body = {
  v: 1,
  hostId: "a1b2c3d4",
  buildId: "0123456789abcdef",
  gen: 7,
  total: files.reduce((n, f) => n + f.size, 0),
  files,
};
const signed = Buffer.from(JSON.stringify(body), "utf8");

// The DER conversion has two edges a random signature rarely reaches: a scalar
// with its top bit set needs a zero byte, one with a leading zero byte loses it.
const edge = (test) => {
  for (;;) {
    const s = p1363(signed);
    if (test(s)) return s.toString("base64");
  }
};

// One byte changed in `signed`, the same sig: a copy that must never verify.
const tampered = Buffer.from(signed);
tampered[tampered.indexOf('"gen":7') + 6] = "9".charCodeAt(0);

writeFileSync(join(here, "update-signature-vector.json"), `${JSON.stringify({
  publicKey: spki(publicKey),
  otherKey: spki(other),
  signed: signed.toString("base64"),
  sig: p1363(signed).toString("base64"),
  tampered: { signed: tampered.toString("base64") },
  edges: {
    rTopBit: edge((s) => s[0] & 0x80),
    sTopBit: edge((s) => s[32] & 0x80),
    rLeadingZero: edge((s) => s[0] === 0),
    sLeadingZero: edge((s) => s[32] === 0),
  },
  files: Object.fromEntries(Object.entries(bundle).map(([p, t]) => [p, Buffer.from(t).toString("base64")])),
}, null, 2)}\n`);
