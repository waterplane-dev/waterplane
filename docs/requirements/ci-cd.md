# ci-cd

### R-ci-cd-001 · shipped
GitHub Actions are disabled and CI/CD runs locally instead.
- shipped: c74402f

### R-ci-cd-002 · requested
The circled build entry triggers a new OTA deliverable build.
- asked: 2026-10-03

### R-ci-cd-003 · shipped
Releases and pushes are blocked while npm packages (including dev dependencies and the app shell) have open high or critical vulnerabilities, and supply-chain safeguards check packages before publishing.
- asked: 2026-10-07
- shipped: 6be88da

### R-ci-cd-004 · requested
A full test sweep runs again after each version increase, before release.
- asked: 2026-10-07

### R-ci-cd-005 · requested
Push guards finish quickly while still verifying the change thoroughly before it is pushed.
- asked: 2026-10-08, 2026-10-09

### R-ci-cd-006 · requested
The npm package is published with a provenance attestation via npm trusted publishing, with no long-lived npm token, from the npm-publish.yml workflow in the public repo; the workflow is live in .github/workflows and guarded to run only there.
- asked: 2026-10-09, 2026-10-10, 2026-10-18, 2026-10-19

### R-ci-cd-007 · shipped
The pre-push check passes in full, including the web typecheck, the e2e suite and the android-hello template Gradle build without timing out beside other scripts, so pushing main to origin/main succeeds, also from the phone's git screen.
- asked: 2026-10-12, 2026-10-17, 2026-10-17, 2026-10-18, 2026-10-18, 2026-10-19
- shipped: 9e095de1

### R-ci-cd-008 · shipped
A script reports when screen fixtures are out of date with the CLI screens they capture.
- asked: 2026-10-16
- shipped: 9156e413

### R-ci-cd-009 · shipped
Public-tree code never names the private vault extension, so the pre-push check passes and the push goes through.
- asked: 2026-10-16
- shipped: 1ae14bba

### R-ci-cd-010 · shipped
Test runs leave no temp directories behind.
- asked: 2026-10-17
- shipped: ff45e7a

