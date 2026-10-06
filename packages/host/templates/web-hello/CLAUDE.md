# CLAUDE.md

Guidance for Claude Code working in **{{name}}**.

## What this is

{{description}}

A single self-contained web page: `index.html` with inline CSS and JS. No npm, no bundler, no
network requests. **The person opens it on the phone they are holding**, from waterplane's gallery,
while they read your replies. Design for a small touch screen first.

## Commands

```bash
mkdir -p .claude/outbox && cp index.html .claude/outbox/{{name}}.html
```

That is the one configured build (`{{state}}/builds.json`, "Publish page"). It copies the page
to `.claude/outbox/{{name}}.html`, which is where the phone's gallery opens it. Run it after every
change the person should see.

## Rules

- **Storage does not work.** The gallery shows the page in a sandboxed frame (`sandbox="allow-scripts"`,
  opaque origin): `localStorage`, `sessionStorage`, `indexedDB` and cookies all throw. Keep state in
  memory and say so on the page where it matters (a reload starts over). Never wrap a feature in a
  storage call that has no fallback.
- No network: no `fetch` to other origins, no CDN `<script>`, no web fonts. Everything the page needs is
  inline in `index.html`.
- Keep it one file unless the person asks otherwise; a second file will not be copied by the build.

## Working from a phone (waterplane)

- **`.claude/outbox/`** is where anything a human should LOOK at goes: this page, screenshots,
  reports. A new file there notifies the phone. Name a file by its full path when you mention it.
- **`.claude/inbox/`** holds images uploaded from the phone; prompts reference them by path.
- **`{{state}}/`** is per-repo daemon state (builds, backlog). Don't hand-edit.

All three are gitignored. Prefer writing a file over printing a wall of terminal output.
