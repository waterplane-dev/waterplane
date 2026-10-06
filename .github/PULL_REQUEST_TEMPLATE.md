> **This project is open source, not open contribution.** Only two kinds of code PR
> are merged: **a failing test that reproduces a bug** (the test only, no fix), and
> **a docs or typo fix**. Anything else — a feature, a refactor, a fix with code — is
> closed with a pointer to [CONTRIBUTING.md](https://github.com/waterplane-dev/waterplane/blob/main/CONTRIBUTING.md): open an
> issue with the *Intent request* form instead, and the owner builds it fresh and
> credits you (`Requested-by:` trailer, CHANGELOG). Not a judgement on your code: the
> daemon spawns `claude` on the owner's machine, so outside code is a supply-chain
> risk that review alone does not make cheap.

## Kind

- [ ] Failing test that reproduces a bug — issue: #
- [ ] Docs / typo fix

## What and why

<!-- One or two sentences. For a test: what it asserts, and what it shows is wrong. -->

## Checklist — failing test

- [ ] The PR adds or changes tests only — no change under `packages/*/src/`
- [ ] The test fails on `main` today, and the failure message says what is wrong
- [ ] It is in the right layer: `*.test.mjs` beside pure logic (`npm run test:unit`), `packages/host/test/` for screen heuristics (`npm run test:host`), `scripts/e2e-*.mjs` for host behaviour
- [ ] An e2e script pins `WATERPLANE_TMUX: "0"` and `WATERPLANE_PREFLIGHT: "0"`
- [ ] `claude --version` the bug was seen with:

## Checklist — docs / typo

- [ ] Prose only (`*.md`, comments) — no behaviour change
- [ ] `npm run lint` and `npm run test:unit` pass (`CLAUDE.md` has a size budget enforced by a test)
