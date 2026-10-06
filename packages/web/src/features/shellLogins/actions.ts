/**
 * The logins sheet's two verbs: open it, and put a command in the compose box.
 */
import { core } from "../../sdk";
import { INSERTED_TOAST, type LoginRow } from "./logic";

export function openLogins(): void {
  const c = core();
  c.say.track("action:logins.open");
  c.nav.open("logins");
}

export function closeLogins(): void {
  core().nav.close("logins");
}

/** Add a row's command to the compose draft and leave the sheet so the box is
 *  on screen. APPENDS (`compose.insert`) — typed words are the last copy — and
 *  NEVER sends: a login is the person's to start. */
export function insertLogin(r: LoginRow): void {
  const c = core();
  c.say.track("action:logins.insert");
  c.compose.insert(r.command);
  c.nav.close("logins");
  c.say.toast(INSERTED_TOAST);
}
