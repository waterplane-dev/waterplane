/**
 * Doors of this area (whole-app journey spec §8: owned by P9, Settings folded + search).
 *
 * Two kinds: the Settings rows that open another screen (`from: "settings"`), and the screens
 * the Settings search box finds by name (`from: "search"`, T21). A search door's label is the
 * title (a merged screen's tab is `tab`), and `SCREEN_WORDS` carries the words a person types
 * that the title does not ("backlog", "photos", "cost"), old names included: a person who learnt
 * the old word still finds the screen by it, so those lines carry `glossary-ignore`.
 */
import { TAB, TITLE } from "../sheetNames.ts";
import type { Overlay } from "../routing.ts";
import type { Door, DoorArea } from "./types.ts";

const W = TAB.waiting;
const C = TAB.connection;

/** The screens Settings' search box offers, in the order the results list them. */
export const SEARCH_DOORS: readonly Door[] = [
  { label: "Waiting work", from: "search", to: "activity", title: TITLE.waiting, tab: W.activity, task: "Find a feature by name", taps: 3 },
  { label: "Waiting work", from: "search", to: "queue", title: TITLE.waiting, tab: W.queued },
  { label: "Waiting work", from: "search", to: "backlog", title: TITLE.waiting, tab: W.backlog, task: "See what is left to start", taps: 3 },
  { label: "Waiting work", from: "search", to: "schedule", title: TITLE.waiting, tab: W.scheduled, task: "Run a prompt at a set time", taps: 3 },
  { label: "Usage pace", from: "search", to: "weekburn", title: TITLE.weekburn },
  { label: "Token usage", from: "search", to: "tokens", title: TITLE.tokens, task: "See what the tokens cost", taps: 3 },
  { label: "Images & documents", from: "search", to: "gallery", title: TITLE.gallery },
  { label: "Setup & health", from: "search", to: "setup", title: TITLE.health },
  { label: "Connection", from: "search", to: "nethealth", title: TITLE.connection, tab: C.health },
  { label: "Connection", from: "search", to: "speedtest", title: TITLE.connection, tab: C.speed },
  { label: "Storage", from: "search", to: "storage", title: TITLE.storage },
  { label: "Desktops", from: "search", to: "hosts", title: TITLE.hosts },
  { label: "Plugins", from: "search", to: "pluginManager", title: TITLE.pluginManager },
  { label: "Archive", from: "search", to: "archive", title: TITLE.archive },
  { label: "Notifications", from: "search", to: "notifications", title: TITLE.notifications },
  { label: "Add a secret", from: "search", to: "secret", title: TITLE.secret },
];

/** The words a screen is found by that its title and tab do not carry. Keyed by the door's `to`. */
export const SCREEN_WORDS: Partial<Record<NonNullable<Overlay>, string>> = {
  activity: "running now activity open sessions",
  queue: "queued queue messages offline outbox send later", // glossary-ignore: an old name a person may still type
  backlog: "backlog todo to do later ideas items list", // glossary-ignore: an old name a person may still type
  schedule: "scheduled schedule automation clock cron timer every week usage window", // glossary-ignore: an old name a person may still type
  weekburn: "week-end burn pace weekly window run out spare leftover", // glossary-ignore: an old name a person may still type
  tokens: "tokens token statistics cost spend money dollars usage", // glossary-ignore: an old name a person may still type
  gallery: "images photos pictures documents files screenshots outbox inbox downloads gallery", // glossary-ignore: an old name a person may still type
  setup: "repo readings setup check checks health score skills claude.md context weight", // glossary-ignore: an old name a person may still type
  nethealth: "link ping latency delay dropped retries network",
  speedtest: "speed test bandwidth throughput direct relayed",
  storage: "space cache disk full clear device phone",
  hosts: "desktops desktop host hosts computer machine pair switch add", // glossary-ignore: an old name a person may still type
  pluginManager: "plugins plugin extensions add-ons",
  archive: "archive closed sessions recently closed past conversations",
  notifications: "notifications alerts feed bell",
  secret: "secret key api env credential password",
};

export const area: DoorArea = {
  doors: [
    // Rows on the Settings screen that open another screen.
    { label: "Plugins", from: "settings", to: "pluginManager", title: TITLE.pluginManager },
    { label: "Waiting work", from: "settings", to: "schedule", title: TITLE.waiting, tab: W.scheduled, task: "Run a prompt at a set time", taps: 3 },
    { label: "Waiting work", from: "settings", to: "queue", title: TITLE.waiting, tab: W.queued },
    { label: "Usage pace", from: "settings", to: "weekburn", title: TITLE.weekburn },
    { label: "Setup & health", from: "settings", to: "setup", title: TITLE.health },
    { label: "Storage", from: "settings", to: "storage", title: TITLE.storage },
    { label: "Add a secret", from: "settings", to: "secret", title: TITLE.secret },
    ...SEARCH_DOORS,
  ],
};
