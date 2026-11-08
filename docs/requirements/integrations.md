# integrations

### R-integrations-001 · shipped
The desktop reads the local Ollama runner passively (throughput, time, memory per model) and shows it in the local runner usage view.
- asked: 2026-09-18
- shipped: 3a6b9322

### R-integrations-002 · shipped
The opencode usage view groups usage by provider, each in its own unit (Copilot per prompt, local runners by answer time, APIs by token), never as one mixed token total.
- asked: 2026-09-26
- shipped: d6f0e8f9

### R-integrations-003 · shipped
Fixes to the local Copilot reader apply to both waterplane and the VS Code extension from one shared implementation.
- asked: 2026-10-21
- shipped: 6d01e574

### R-integrations-004 · requested
Non-Claude backends reach the same level of integration and support as Claude, Copilot first, then Gemini CLI, while Claude's behaviour stays byte-identical and heuristic readings that cannot be determined show as absent, never a wrong number.
- asked: 2026-10-21, 2026-10-22, 2026-10-23

### R-integrations-005 · shipped
The repo skill text uses the live API address of the running host instead of a hardcoded port.
- asked: 2026-10-27
- shipped: 0322545d

