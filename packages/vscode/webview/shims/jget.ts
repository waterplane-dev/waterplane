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

/** The phone's POSTs (this week's burn sheet) have no route through the extension host, which
 *  forwards GETs only: refuse in words rather than send nothing. */
export function jpostOk<T>(url: string, _body: unknown, _ms?: number): Promise<T> {
  return Promise.reject(new Error(`${url} is not available in VS Code`));
}
