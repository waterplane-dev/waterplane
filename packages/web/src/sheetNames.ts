/**
 * What the sheets are called, as drawn on their own heads. A sentence that
 * names one ("the prompts stay in Activity") reads it from here, so a rename is
 * this file plus the UI snapshots — never a sweep for the old word through every
 * toast and title (Schedules → Automation touched fifteen files).
 *
 * `TITLE` is the ONE table of screen titles (whole-app journey spec D1, the
 * glossary in `.claude/outbox/journey-app/glossary.md` §2): a button that opens
 * a screen says its title, or the start of it, and the door registry
 * (`doors/`) names its target by a value of this table — `tools/appdoors.test.mjs`
 * holds both. Keys are overlay ids where one exists (code ids are never
 * renamed, only the words), else a short name for a sub-view.
 */
export const TITLE = {
  // the three merged screens (D4, D7)
  waiting: "Waiting work",
  health: "Setup & health",
  connection: "Connection",
  // files, git, downloads (P5)
  gallery: "Images & documents",
  browse: "Browse files - repo",
  assess: "What is left - repo",
  git: "Changes - repo",
  gitBranch: "Changes - branch",
  commits: "Commits - branch",
  pull: "Downloads - repo",
  build: "Build - repo",
  // session sheets (P11)
  history: "History - session",
  slash: "Slash commands",
  model: "Switch model",
  text: "Select text",
  clip: "To desktop clipboard",
  sentlog: "Sent commands - session",
  decisions: "Decision log - session",
  answers: "Answer the list",
  hdrcmd: "Header commands",
  logins: "Logins",
  pad: "Pad",
  padNote: "Pad - note",
  fanout: "Fan out",
  weekburn: "Usage pace",
  storage: "Storage on this device",
  secret: "Add a secret",
  context: "Context window & cost",
  sessionBudget: "Budget",
  outline: "Outline",
  scrollback: "Scrollback",
  toolbar: "Customize toolbar",
  snippets: "Snippets",
  questions: "Questions",
  limits: "Blocked",
  send: "Send",
  // settings and the rest
  home: "Home",
  settings: "Settings",
  notifications: "Notifications",
  tokens: "Token usage",
  hosts: "Desktops",
  addDesktop: "Add a desktop",
  pluginManager: "Plugins",
  archive: "Archive",
  // in-repo extensions (labels live in their own index.ts; the title is said here once)
  permissions: "Permission rules - repo",
  diskspace: "Disk space",
  links: "Links",
} as const;
export type TitleKey = keyof typeof TITLE;

/** The tab and section words of the merged screens, keyed by the code ids in `routing.ts`
 *  (`WaitingTab`, `HealthTab`, `HealthSection`, `ConnectionTab`). */
export const TAB = {
  waiting: { activity: "Activity", queued: "Queued", backlog: "Backlog", scheduled: "Scheduled" },
  health: { repo: "This repo", desktop: "This desktop" },
  connection: { health: "Health", speed: "Speed test" },
  gallery: { fromClaude: "From Claude", fromPhone: "From my phone" },
} as const;
export const HEALTH_SECTION = {
  checks: "Checks", score: "Health score", watch: "Watch", optins: "Opt-ins", skills: "Skills", sessions: "Sessions",
} as const;

/**
 * The words sentences read today. `automation` and `activity` are screens the
 * Waiting work frame (P7) absorbs: they keep today's words until that package
 * moves their callers onto `TITLE`/`TAB` (and their snapshots with them), so a
 * half-built tree never names a screen that is not there yet.
 */
export const SHEET = {
  activity: "Activity",
  automation: "Scheduled",
  weekburn: TITLE.weekburn,
  whatsnew: "What's new",
} as const;
