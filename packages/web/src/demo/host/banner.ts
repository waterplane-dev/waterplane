// The welcome header every demo session opens with: the logo and three lines, as the real CLI draws it,
// under three blank rows (the phone's reader/zoom buttons float over the top-right of the terminal and would
// otherwise sit on the version and model). The version and plan are made up (the demo carries no machine
// data) and the model names what the demo sessions run.

// Glyphs and colours as a real `claude` v2.1 prints them (captured in tmux): the logo in 256-colour
// 174, the rest in the CLI's grey.
const LOGO = "\x1b[38;5;174m";
const R0 = "\x1b[0m";
const B = "\x1b[1m";
const D = "\x1b[38;5;246m";

/** Claude Code's header for a session in `cwd` (a `{cwd}` placeholder is left for the host to fill). */
export const claudeBanner = (cwd: string, model = "Opus 5.5"): string =>
  "\r\n\r\n\r\n" + `${LOGO} ▐▛███▛█${R0}   ${B}Claude Code${R0} ${D}v2.1.292${R0}\r\n` +
  `${LOGO}▝▜██████▀${R0}  ${D}${model} · Claude Max${R0}\r\n` +
  `${LOGO} ▝▝   ▝▝ ${R0}  ${D}${cwd}${R0}\r\n\r\n`;

/** What `createSession` writes unless a scenario says otherwise: `{cwd}` is substituted. */
export const CLAUDE_BANNER = claudeBanner("{cwd}");
