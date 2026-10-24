/**
 * P5: a plugin backend gets an "installed + version" setup row from its descriptor alone, and an
 * external plugin's `doctor` is asked by the preflight (contained: timeout, throw, bad shape).
 */
import "../../../scripts/lib-tmuxiso.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { backendCliRows } = await import("../dist/plugins/setupcontrib.js");
const { externalDoctorChecks } = await import("../dist/plugins/builtin.js");

const def = (id, bin, measured = true) => ({ id, label: id.toUpperCase(), bin: () => { if (bin instanceof Error) throw bin; return bin; }, ...(measured ? { measured: { versions: ["1"], version: async () => null } } : {}) });

test("backendCliRows: found with version, found without, missing, no binary; core backends get none", () => {
  const has = (b) => (b === "/bin/sh" ? "/bin/sh" : null);
  const rows = backendCliRows(
    [def("a", "/bin/sh"), def("b", "/bin/sh"), def("c", "nope-cli"), def("d", new Error("boom")), def("core", "/bin/sh", false)],
    [{ id: "a", measured: { versions: ["1"], running: "1.2.3" } }, { id: "b", measured: { versions: ["1"] } }],
    has,
  );
  assert.deepEqual(rows.map((r) => [r.id, r.status]), [["backend-cli-a", "pass"], ["backend-cli-b", "pass"], ["backend-cli-c", "warn"], ["backend-cli-d", "warn"]]);
  assert.match(rows[0].detail, /version 1\.2\.3/);
  assert.match(rows[1].detail, /did not say which version/);
  assert.match(rows[2].detail, /nope-cli/);
  assert.ok(rows.every((r) => r.scope === "host" && r.fix === null));
});

function plugin(root, name, hostSrc) {
  const d = join(root, "plugins", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "waterplane-plugin.json"), JSON.stringify({ id: name, name, version: "1.0.0", apiVersion: "2.1", host: "host.mjs" }));
  writeFileSync(join(d, "host.mjs"), hostSrc);
}

test("externalDoctorChecks: a plugin switched off in plugins.json is not asked; a repeated id is asked once", async () => {
  const root = mkdtempSync(join(tmpdir(), "wp-doc-"));
  const state = mkdtempSync(join(tmpdir(), "wp-docstate-"));
  const src = (n) => `export function activate(){} export async function doctor(){ return [{id:"x",status:"ok",detail:"${n}"}]; }`;
  plugin(root, "on", src("on"));
  plugin(root, "off", src("off"));
  const dup = join(root, "plugins", "zdup");
  mkdirSync(dup, { recursive: true });
  writeFileSync(join(dup, "waterplane-plugin.json"), JSON.stringify({ id: "on", name: "dup", version: "1.0.0", apiVersion: "2.1", host: "host.mjs" }));
  writeFileSync(join(dup, "host.mjs"), src("dup"));
  writeFileSync(join(state, "plugins.json"), JSON.stringify({ enabled: { off: false } }));
  const out = await externalDoctorChecks(root, [], state);
  assert.deepEqual(out, [{ id: "on-x", status: "ok", detail: "on" }]);
});

test("externalDoctorChecks: asks an external plugin's doctor, prefixes ids, drops bad lines, survives throws", async () => {
  const root = mkdtempSync(join(tmpdir(), "wp-doc-"));
  plugin(root, "good", `export function activate(){} export async function doctor(req){ return [{id:"signed-in",status:"ok",detail:"as x "+req.usedBackends.join(",")},{id:"bad"},{id:"good-cli",status:"warn",detail:"d"}]; }`);
  plugin(root, "thrower", `export function activate(){} export async function doctor(){ throw new Error("x"); }`);
  plugin(root, "nodoctor", `export function activate(){}`);
  plugin(root, "broken", `export default ;`);
  const out = await externalDoctorChecks(root, ["good"]);
  assert.deepEqual(out, [{ id: "good-signed-in", status: "ok", detail: "as x good" }, { id: "good-cli", status: "warn", detail: "d" }]);
});
