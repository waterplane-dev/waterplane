/**
 * Side-effect module, and deliberately the FIRST import of `main.tsx`.
 *
 * ES modules evaluate in import order, so everything this runs happens before
 * any other module of the app has been evaluated — before a store has read a
 * host key into memory at import, and long before anything can write one back.
 * That is the only moment a host switch can move keys safely (`hosts.ts`), and
 * the moment the one-`hostBase`-era storage becomes a host list.
 *
 * Imports nothing but `boot/brandMigrate.ts`, `hosts.ts`, `hostUrl.ts` and
 * what they import (`storage.ts`, `@waterplane/shared`), none of which read a
 * host key at load. The browser is untouched by the host list: it is served by
 * one host and has no list.
 *
 * The brand migration runs FIRST, in the browser too: it copies keys an older
 * build wrote under an older name (drafts, the queue, every parked host's keys)
 * to the names this build reads, so `bootHosts` and everything after it finds
 * them where it looks.
 */
import { runBrandMigration } from "./boot/brandMigrate";
import { bootHosts, browserKV } from "./hosts";
import { isNativeShell } from "./hostUrl";
import { installDemoWorld } from "./demo/world";

// The static web demo reads and writes its own corner of storage
// (`demo/world.ts`), swapped in before anything else touches a key — even the
// brand migration below must not run over the real ones from inside it.
const demoWorld = installDemoWorld(isNativeShell());
if (!demoWorld) runBrandMigration();
if (isNativeShell()) bootHosts(browserKV());
