/**
 * `useRemoteResource`'s two imports from the phone's `offlineCache.ts`, without the rest of it: a
 * VS Code webview keeps no last copy (the real store opens an IndexedDB and pulls in the phone's api
 * layer and desktop list). A read here is the live read or nothing; `esbuild.mjs` swaps this in.
 */
export const getResCache = async <T>(_key: string, _shape: number): Promise<{ value: T; savedAt: number } | null> => null;
export const putResCache = async (_key: string, _shape: number, _value: unknown): Promise<void> => {};
