/**
 * `hostUrl.ts` in the Android shell, with the LAN route in force: the OPAQUE
 * loads — `abs()` (an `<img src>`, Background Fetch, the native download
 * service) and `sendBeacon` — carry no bearer and so must go to the SAVED
 * (tailnet) address, while fetch/XHR follow the route. On the LAN every
 * `/api/*` is token-gated, so an opaque load there is a 401.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lsKey } from "@waterplane/shared";

const SAVED = "http://100.64.0.5:8770";
const LAN = "http://192.168.1.20:8770";

// The shell's globals, before the module is evaluated.
const store = new Map([[lsKey("hostBase"), SAVED]]);
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
globalThis.Capacitor = { isNativePlatform: () => true };
globalThis.location = new URL("http://localhost/");
const fetched = [];
globalThis.fetch = async (input) => { fetched.push(String(input)); return new Response("{}"); };
globalThis.XMLHttpRequest = class { open() {} setRequestHeader() {} addEventListener() {} };
const beacons = [];
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { sendBeacon: (url) => { beacons.push(String(url)); return true; } },
});

const { abs, hostBase, installHostRouting, setRouteBase } = await import("./hostUrl.ts");
installHostRouting();

test("abs() ignores the LAN route: an opaque load goes to the saved address", () => {
  assert.equal(setRouteBase(LAN), LAN);
  assert.equal(hostBase(), LAN, "the route IS in force for the transports");
  assert.equal(abs("/api/repos/r/artifact?path=a.png"), `${SAVED}/api/repos/r/artifact?path=a.png`);
  setRouteBase(null);
  assert.equal(abs("/api/x"), `${SAVED}/api/x`);
});

test("a beacon goes to the saved address on the LAN route; fetch follows the route", async () => {
  setRouteBase(LAN);
  navigator.sendBeacon("/api/netstats", "{}");
  assert.equal(beacons.at(-1), `${SAVED}/api/netstats`);
  await fetch("/api/repos");
  assert.equal(fetched.at(-1), `${LAN}/api/repos`);
  setRouteBase(null);
});
