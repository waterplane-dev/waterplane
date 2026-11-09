# Live desktop

Watch this computer's screen live on your phone, as video. If you allow it, you can also click and type into it from the phone. Use it to check on something running on the desktop, or to reach an app that has no phone version.

It works on a Mac, or on Windows with waterplane running inside WSL. It is experimental and off by default. On a Mac you must give the helper program Screen Recording permission (and Accessibility for control) in System Settings, Privacy and Security. A helper update can reset those permissions.

## Where to find it
- **Home menu, "Desktop"** — opens the live view.
- **Session menu, "Desktop"** — opens the live view as a tab in the session's header, next to Claude and Shell.
- **Live view** — pick Touch, Trackpad or View only, go fullscreen, and see how much data the video uses.

## Settings
- **Let the phone control this desktop** — off by default. Off means the phone can only watch. On means clicks and keys from the phone reach every app on the desktop, with the same trust as typing into a session. Find it in Settings, Tools and diagnostics, plugins, Live desktop.

## For developers

Watch this desktop's screen live from the phone as H.264 video, on the same connection as every
session, and, if you turn it on, click and type into it. Off by default; control is a second switch
that is also off by default and is enforced on the host, not hidden on the phone.

**Experimental.** Releases ship it off by default (`deploy/ship.json`; the helper sources travel with it, built on first use): switch it on in Settings › Tools & diagnostics › plugins.

- **macOS:** in use by its author. A small Swift helper (`helper/`, ScreenCaptureKit and
  VideoToolbox) is compiled on first use. macOS ties Screen Recording and Accessibility to the
  helper's signature, so an update that changes the helper's source rebuilds it and you grant both
  again; the setup checklist says when.
- **Windows (host in WSL):** verified working by its author. A small C# helper (`helper-win/`, GDI
  capture and Media Foundation) is compiled on first use by the `csc.exe` Windows already carries,
  so there is nothing to install and no permission to grant.

No codec is bundled: encoding uses the operating system's encoder, decoding the browser's WebCodecs.
How it works and what is still unverified: [`docs/notes/desktop.md`](../../../docs/notes/desktop.md).
Wire contract between host and helper: [`helper/PROTOCOL.md`](helper/PROTOCOL.md).
