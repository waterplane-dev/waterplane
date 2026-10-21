# Live desktop (experimental)

Watch this desktop's screen live from the phone as H.264 video, on the same connection as every
session, and, if you turn it on, click and type into it. Off by default; control is a second switch
that is also off by default and is enforced on the host, not hidden on the phone.

**Experimental.** Releases do not ship it (`deploy/ship.json`); it runs from a source checkout.

- **macOS:** in use by its author. A small Swift helper (`helper/`, ScreenCaptureKit and
  VideoToolbox) is compiled on first use. macOS ties Screen Recording and Accessibility to the
  helper's signature, so an update that changes the helper's source rebuilds it and you grant both
  again; the setup checklist says when.
- **Windows (host in WSL):** written and tested under Mono only; never run on a real Windows
  desktop yet. The helper (`helper-win/`, C# 5, Media Foundation) is compiled by the `csc.exe`
  Windows already carries.

No codec is bundled: encoding uses the operating system's encoder, decoding the browser's WebCodecs.
How it works and what is still unverified: [`docs/notes/desktop.md`](../../../docs/notes/desktop.md).
Wire contract between host and helper: [`helper/PROTOCOL.md`](helper/PROTOCOL.md).
