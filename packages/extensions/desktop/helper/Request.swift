// Request: the only code in wp-desktop that asks macOS for a grant. Everything else only reads
// (Probe.swift: "Nothing here can raise a permission dialog").
//
//   wp-desktop request [screen|accessibility]      both when no name is given
//
// Run through the same responsibility-disclaim path as `serve` (main.swift), so the dialog and the
// row it adds in System Settings name wp-desktop, not node. It returns at once: both calls only
// START the dialog, which the system shows on the desktop's screen and the person answers there.
// The grant is read later by `probe`.
//
//   - Screen Recording: CGRequestScreenCaptureAccess(). It lists the binary in the Screen & System
//     Audio Recording pane and shows the dialog the first time; asked again for the same binary it
//     may show nothing, which is why the host then opens the pane instead.
//   - Accessibility: AXIsProcessTrustedWithOptions with the prompt option on.
//
// `--dry-request` reads the current state and calls neither request API (selftest, and anything
// else that must not risk a dialog).

import ApplicationServices
import CoreGraphics
import Foundation

/// The names `request` takes, in the order a bare `request` asks them.
let requestableKinds = ["screen", "accessibility"]

/// One kind's answer: whether it was already granted before the call, and whether it is now.
/// `asked` is false when it was already granted, or in a dry run: no request API was called.
func requestAccess(_ kind: String, dry: Bool) -> [String: Any] {
  switch kind {
  case "screen":
    let before = CGPreflightScreenCaptureAccess()
    if before || dry { return ["already": before, "granted": before, "asked": false] }
    let granted = CGRequestScreenCaptureAccess()
    return ["already": false, "granted": granted, "asked": true]
  default:
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    let before = AXIsProcessTrustedWithOptions([key: false] as CFDictionary)
    if before || dry { return ["already": before, "granted": before, "asked": false] }
    let granted = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    return ["already": false, "granted": granted, "asked": true]
  }
}

/// `request`'s stdout object; nil when `what` names nothing requestable.
func requestObject(_ what: String?, dry: Bool) -> [String: Any]? {
  let kinds = what.map { [$0] } ?? requestableKinds
  guard kinds.allSatisfy({ requestableKinds.contains($0) }) else { return nil }
  var out: [String: Any] = ["dry": dry, "responsibleSelf": responsibility().pid == responsibility().responsible]
  for k in kinds { out[k] = requestAccess(k, dry: dry) }
  return out
}
