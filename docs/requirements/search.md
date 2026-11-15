# search

### R-search-001 · shipped
Search supports filtering to the user's own prompts as the default mode.
- asked: 2026-09-21
- shipped: bab3986

### R-search-002 · shipped
The phone-setup banner opens a view that lists only the steps still missing.
- asked: 2026-10-01
- shipped: a7e3fab1
- note: Item named an 'issues filter' in search; the ask was about the phone-setup banner.


### R-search-003 · shipped
Session search can also search archived conversations (an opt-in switch on the all-sessions search); a hit opens that conversation in the archive reader.
- asked: 2026-11-14
- shipped: this commit
- note: Archived conversations are searched by the person's prompts only (the CLI's prompt history), never the replies — the logs are too big to scan as you type. The sheet says so.
