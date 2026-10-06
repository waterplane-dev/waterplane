/**
 * The logins cheat sheet's rows and words — pure, no React.
 *
 * Each row is a command a person types in a shell session to log a CLI in from
 * a phone. What decides a row is not the CLI but the FLOW: a login that ends in
 * a redirect to `http://localhost:<port>` finishes on the desktop's own browser
 * and can never complete from the phone, so such a CLI needs its device /
 * no-browser flag — and a row whose plain command does that says so
 * (`redirectsToLocalhost`). Names no secret store on purpose: this is public
 * code, and where a token goes afterwards is the reader's choice.
 */

export interface LoginRow {
  id: string;
  /** What gets inserted into the compose box — never sent for the person. */
  command: string;
  /** One line: what the flow does on a phone. */
  note: string;
  /** The CLI's DEFAULT flow redirects to localhost; `command` already carries
   *  the flag that avoids it. */
  redirectsToLocalhost?: boolean;
}

export const LOGINS_HEADER = "log in once here, then move the token into a secret store";

export const LOCALHOST_WARNING =
  "without this flag the login redirects to localhost on the desktop and cannot finish from the phone";

export const LOGIN_ROWS: readonly LoginRow[] = [
  {
    id: "gcloud",
    command: "gcloud auth login --no-launch-browser",
    note: "prints a URL; sign in on the phone, then paste the code back. (--no-browser is different: it needs gcloud on a second machine.)",
  },
  {
    id: "gcloud-adc",
    command: "gcloud auth application-default login --no-launch-browser",
    note: "the same flow for application-default credentials: open the URL, sign in, paste the code back.",
  },
  {
    id: "gh",
    command: "gh auth login -h github.com -p https --web",
    note: "prints a device code and opens github.com/login/device; enter the code there — nothing to paste back.",
  },
  {
    id: "firebase",
    command: "firebase login --no-localhost",
    note: "prints a URL; sign in on the phone and paste the code back.",
    redirectsToLocalhost: true,
  },
  {
    id: "codex",
    command: "codex login --device-auth",
    note: "prints a URL and a device code; enter the code on the page — nothing to paste back.",
    redirectsToLocalhost: true,
  },
  {
    id: "npm",
    command: "npm login",
    note: "prints a web login URL, then waits; sign in on the phone and the CLI carries on by itself.",
  },
  {
    id: "tailscale",
    command: "tailscale login",
    note: "prints a URL to open. On macOS the Tailscale app may own the login instead.",
  },
  {
    id: "docker",
    command: "docker login",
    note: "recent versions print a device code and URL; older ones ask for a username and, with --password-stdin, a token.",
  },
];

/** The sentence under a row — its note, plus the localhost warning when it applies. */
export function rowWords(r: LoginRow): string {
  return r.redirectsToLocalhost ? `${r.note} ${LOCALHOST_WARNING[0].toUpperCase()}${LOCALHOST_WARNING.slice(1)}.` : r.note;
}

/** How many rows carry the warning — the sheet's one count, and it is a filter
 *  (`onlyLocalhost`), never a bare number. */
export function localhostCount(rows: readonly LoginRow[] = LOGIN_ROWS): number {
  return rows.filter((r) => r.redirectsToLocalhost).length;
}

export function cutRows(onlyLocalhost: boolean, rows: readonly LoginRow[] = LOGIN_ROWS): LoginRow[] {
  return onlyLocalhost ? rows.filter((r) => r.redirectsToLocalhost) : [...rows];
}

/** The filtered view says what it is hiding: "n of N". */
export function cutWords(shown: number, total: number): string {
  return `${shown} of ${total} logins — only those that redirect to localhost without the flag`;
}

/** Toast after a row's command lands in the compose box. */
export const INSERTED_TOAST = "command added to the compose box — press send when you are ready";
