#!/bin/bash
# E2E stand-in for the `claude` binary: an interactive shell that IGNORES
# whatever claude flags the host passes (--session-id, --continue, --model, …).
# Bare `bash` used to work as the stub until the host started minting
# --session-id for fresh sessions — bash treats that as an invalid option.
#
# One subcommand is answered like the real CLI: `auth status`, which the host
# asks on request paths (the onboarding plan, a peer's hello). As a shell it
# waited for input until the host's 15 s timeout, so every plan read in a test
# hung past the page's wait (scripts/ui journey `first-app`).
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo '{"loggedIn": true, "authMethod": "stub"}'
  exit 0
fi
exec bash --norc
