# ci-cd

### R-ci-cd-001 · shipped
GitHub Actions are disabled and CI/CD runs locally instead.
- shipped: c74402f

### R-ci-cd-002 · requested
The circled build entry triggers a new OTA deliverable build.
- asked: 2026-10-03

### R-ci-cd-003 · requested
Releases and pushes are blocked while npm packages (including dev dependencies and the app shell) have open high or critical vulnerabilities, and supply-chain safeguards check packages before publishing.
- asked: 2026-10-07

### R-ci-cd-004 · requested
A full test sweep runs again after each version increase, before release.
- asked: 2026-10-07

### R-ci-cd-005 · requested
Push guards finish quickly while still verifying the change thoroughly before it is pushed.
- asked: 2026-10-08, 2026-10-09

### R-ci-cd-006 · requested
The npm package is published with a provenance attestation from a workflow on the public mirror; the workflow file stays parked outside the live workflows until it has been reviewed on its own.
- asked: 2026-10-09, 2026-10-10

### R-ci-cd-007 · shipped
The pre-push check (npm run test:vscode) passes, so pushing main to origin/main succeeds.
- asked: 2026-10-12
- shipped: 9e095de1

