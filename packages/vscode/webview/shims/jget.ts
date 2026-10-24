/**
 * The webview's `jget` (the phone's is `web/src/webapi/webapiFetch.ts`), swapped in under the
 * phone's `webapiStats.ts` by `esbuild.mjs`: the same path, asked of the extension host, which
 * forwards it to the waterplane desktop on loopback (`src/hostlink.ts`) — a webview cannot open
 * that socket itself. The phone's link meters and stall notes have no home here and are left out.
 */
import { get } from "../host";

export function jget<T>(url: string, ms?: number): Promise<T> {
  return get(url, ms) as Promise<T>;
}
