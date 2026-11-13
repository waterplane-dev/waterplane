/**
 * Test helper: what `send.ts` sees in place of `../../idb` and `../../api` under `flushHarness.mjs`.
 * Every call goes to `globalThis.__flushFake`, which the harness sets per run (a test controls the
 * bytes store and the upload by resolving or rejecting the promise it is handed).
 */
const f = () => globalThis.__flushFake;
export const idbGet = (store, key) => f().idbGet(store, key);
export const idbSet = (store, key, value) => f().idbSet(store, key, value);
export const idbDel = (store, key) => f().idbDel(store, key);
export const api = { uploadInbox: (...args) => f().uploadInbox(...args) };
