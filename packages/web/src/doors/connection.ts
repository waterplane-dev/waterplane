/**
 * Doors of this area (whole-app journey spec §8: owned by P4, Connection). The status strip's three
 * readings and Settings' Connection row all open the one Connection screen, on its Health tab.
 */
import { TAB, TITLE } from "../sheetNames.ts";
import type { Door, DoorArea } from "./types.ts";

const C = TAB.connection;

export const area: DoorArea = {
  doors: [
    { label: "Connection", from: "status strip", to: "nethealth", title: TITLE.connection, tab: C.health, taps: 1 },
    { label: "Connection", from: "settings", to: "nethealth", title: TITLE.connection, tab: C.health },
    { label: "Connection", from: "settings", to: "speedtest", title: TITLE.connection, tab: C.speed },
  ] satisfies readonly Door[],
};
