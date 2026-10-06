/**
 * Routes about work the host does on the user's behalf — the backlog, fan-out
 * sweeps, builds, downloads, scheduled runs, and the launches it is holding.
 *
 * A barrel: the handlers live in `routes/work/` by subject (backlog + fan-out,
 * builds + artifacts + capture, assess + pull, launch + schedule, intents), and
 * the table below is their union in the order the single table always had.
 */
import type { RouteTable } from "./types.js";
import { workbacklogRoutes } from "./work/workbacklog.js";
import { workbuildRoutes } from "./work/workbuild.js";
import { workassessRoutes } from "./work/workassess.js";
import { workscheduleRoutes } from "./work/workschedule.js";
import { workintentRoutes } from "./work/workintent.js";

export const workRoutes: RouteTable = {
  ...workbacklogRoutes,
  ...workbuildRoutes,
  ...workassessRoutes,
  ...workscheduleRoutes,
  ...workintentRoutes,
};
