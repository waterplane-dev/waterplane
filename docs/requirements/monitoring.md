# monitoring

### R-monitoring-001 · shipped
System stats display CPU, memory, temperature, fan speed, and process breakdown for the host machine.
- asked: 2026-09-18
- shipped: 58066b0

### R-monitoring-002 · requested
The exposure watch runs automatically once a day for each public repo, and exits with distinct codes: 0 nothing new, 10 action needed, 2 unreachable sources, 64 usage error.
- asked: 2026-10-26, 2026-10-26

### R-monitoring-003 · shipped
The owner-private exposure watch reports the Play target-API deadline (read from the app's build files), Play vitals, privacy-policy URL status, domain (RDAP) expiry and a manual npm 2FA row the owner confirms; Socket runs only when its token exists in the vault. It never appears in the public tree.
- asked: 2026-10-26
- shipped: d7f26c4d


### R-monitoring-004 · shipped
A crash or exposure finding can be marked seen, investigating or fixed (with the version that carries the fix) by the person from the phone or by an agent working in that repo; a crash reported from an app version older than the fix stops counting; one from the fix's version or newer returns as a regression. An agent cannot clear a mark.
- asked: 2026-10-27
- shipped: 9de4f460
### R-monitoring-005 · shipped
An agent's ordinary prose that mentions rate-limit or context-window wording, or shows a quoted meter figure, never triggers the limit, context or other chrome detectors.
- asked: 2026-10-30
- shipped: af0f51d8, 0984ba89

### R-monitoring-006 · shipped
The phone's exposure watch shows CodeQL code-scanning findings alongside Dependabot ones.
- asked: 2026-11-02
- shipped: a7475671

### R-monitoring-007 · shipped
A crash finding on the phone's watch list can be sent to a session for an agent to find the cause and fix it, and every watch finding says in plain words where it came from.
- asked: 2026-11-05
