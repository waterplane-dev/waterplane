/**
 * The HTTP API's one table, assembled from the domain tables — what `api.ts`
 * dispatches over, and what `apiroutes.test.mjs` lists (host-architecture.md,
 * "api.ts — the HTTP routes as tables").
 *
 * Exact paths are disjoint, so between them order is not behaviour. What is:
 * the five mounts (inside `SYSTEM_ROUTES`, after the hook sinks, in their
 * order), and the repo scope LAST — whatever it does not match is the
 * caller's 404.
 */
import { listApiRoutes, type ApiEntry } from "./apitable.js";
import { SYSTEM_ROUTES } from "./apisystem.js";
import { HOST_ROUTES } from "./apihost.js";
import { SESSION_ROUTES } from "./apisession.js";
import { STATS_ROUTES } from "./apistats.js";
import { WEEKBURN_ROUTES } from "./apiweekburn.js";
import { REPO_SCOPE } from "./apirepofiles.js";

export const API_ROUTES: readonly ApiEntry[] = [...SYSTEM_ROUTES, ...HOST_ROUTES, ...SESSION_ROUTES, ...STATS_ROUTES, ...WEEKBURN_ROUTES, REPO_SCOPE];

/** `METHOD pattern` / `MOUNT name`, in table order, the repo scope expanded. */
export const listRoutes = (): string[] => listApiRoutes(API_ROUTES);
