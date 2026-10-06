/**
 * The scenarios this build ships, by id (demo-mode-plan.md §3).
 *
 * The transport resolves `?demo=<id>` / the stored choice against this map; an
 * id not in it runs no demo and `demoProblem()` says so. Every entry must pass
 * `assertShippable` (a scenario carrying faults is tests only) —
 * `demo/transport.ts` checks it at install and `scenarios.test.mjs` on every
 * entry, so a test fixture can never ship by being added here.
 *
 * A scenario is built with the current time so its "40 min ago" stays true;
 * tests build the same one at `CLOCK_START` (`first-look.ts`).
 */
import type { DemoScenario } from "../host/index.ts";
import { firstLook } from "./first-look.ts";
import { galleryAndFiles } from "./gallery-and-files.ts";
import { limitAndBudget } from "./limit-and-budget.ts";
import { numbers } from "./numbers.ts";
import { queueAndSchedule } from "./queue-and-schedule.ts";

export const DEMO_SCENARIOS: Readonly<Record<string, DemoScenario>> = {
  "first-look": firstLook(Date.now()),
  "queue-and-schedule": queueAndSchedule(Date.now()),
  "gallery-and-files": galleryAndFiles(Date.now()),
  numbers: numbers(Date.now()),
  "limit-and-budget": limitAndBudget(Date.now()),
};
