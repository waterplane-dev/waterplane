/**
 * Doors of this area (whole-app journey spec §8, P14): the Settings rows for notifications, desktops
 * and plugins. The in-repo extensions' own doors (token-stats, desktop, links, permissions,
 * requirements, android-apps, scorecard) are drawn by their manifests; their labels now say their titles.
 */
import { TITLE } from "../sheetNames.ts";
import type { DoorArea } from "./types.ts";

export const area: DoorArea = {
  doors: [
    { label: "Notifications", from: "settings", to: "notifications", title: TITLE.notifications, task: "Theme and notifications", taps: 3 },
    { label: "Desktops", from: "settings", to: "hosts", title: TITLE.hosts, task: "Connect a second desktop", taps: 3 },
    { label: "Add a desktop", from: "sheet:hosts", to: "hosts", title: TITLE.addDesktop, task: "Connect a second desktop", taps: 4 },
  ],
};
