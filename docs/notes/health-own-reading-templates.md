# Starter own-readings by project type

A repo declares its own readings in `.waterplane-shared/health.json` (contract: `tools/repohealth/own.mjs`).
Each is an argv run in the repo root that prints ONE number, or prints nothing and exits non-zero with
the reason, which makes the reading absent (never 0). Keep each under a few seconds; the engine allows 30 s
and 8 readings. Prefer a reading that a person can act on over one that is merely countable, and say in
`means` what the number does NOT show. Worked example: picture-app's `docs/health-readings/README.md`.

Each entry: what to measure, `better`, and the usual trap.

## Mobile app

- **Release artefact size** (`lower`, MB): size of the newest release APK/IPA on disk. Absent when none is
  built; never rebuild inside the reading.
- **Destructive paths with a test** (`higher`, %): call sites that delete, move or rewrite user data, whose
  enclosing function a test names. Trap: a name match is not proof; publish the site list beside the number.
- **Platform parity** (`higher`, %): share of shared interface methods pinned by the same fixture on both
  platforms, when the app carries two implementations of one contract.
- **Crash-free share from the last store report** (`higher`, %): read a committed or cached report file, never
  the network. Absent when the report is older than the last release.

## Web app

- **Initial JS shipped** (`lower`, KB gzip): sum of the entry chunks in the last production build output.
  Absent without a build.
- **Routes covered by a journey test** (`higher`, %): routes in the router table that a browser test visits.
- **Accessibility violations on key screens** (`lower`, count): an axe run over a fixed list of 3 to 5 URLs
  from a stored snapshot or the dev build; absent if the browser is not installed.
- **Untyped boundaries** (`lower`, count): `any`, `as unknown as` and `@ts-ignore` in code that touches the
  network. Trap: easy to game by renaming; keep the pattern list in the script.

## CLI

- **Commands with an example in --help** (`higher`, %): subcommands whose help text has a usage example.
- **Cold start time** (`lower`, ms): median of 5 runs of `--version`. Trap: a laptop under load; report the
  median and absent if the 5 runs differ by more than 3x.
- **Exit-code coverage** (`higher`, %): documented non-zero exit codes that a test provokes.
- **Flags without a test** (`lower`, count): flags in the parser table not named in any test or golden file.

## Library

- **Public API with a doc comment** (`higher`, %): exported symbols that carry documentation.
- **Public API surface** (`lower`, symbols): exported names; a rise is a promise to keep, so watch the
  direction rather than the level. Better stays "lower" only for a library trying to stay small.
- **Breaking changes without a major bump** (`lower`, count): diff the exported surface against the last
  tag. Absent when no tag exists.
- **Runtime dependencies** (`lower`, count): direct dependencies, not dev tools.

## Local-data app (user files or a database on the device)

- **Migration safety** (`higher`, %): past schema versions that upgrade to the current one in a test without
  losing a row. No version number? Rebuild old shapes by dropping the migrated columns from today's schema.
- **Destructive paths with a test** (`higher`, %): as under Mobile app; this is the reading most worth
  turning into a gate here.
- **Original files modified outside the sanctioned writers** (`lower`, count): write calls to user paths
  not on an explicit allow-list. The rule written in prose becomes a number.
- **Backup/restore round trip** (`higher`, %): fixture libraries that export and re-import byte-identically.
  Absent when the export command needs a device.
