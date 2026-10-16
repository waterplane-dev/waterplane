// Probe: what this Mac offers and what this binary is allowed, without ever
// asking. Nothing here can raise a permission dialog:
//   - CGPreflightScreenCaptureAccess() only reads the Screen Recording grant.
//   - AXIsProcessTrustedWithOptions with prompt=false only reads Accessibility.
//   - CGGetActiveDisplayList / display modes need no grant at all.
// Both grants are checked for the RESPONSIBLE process (see Responsibility.swift).

import ApplicationServices
import CoreGraphics
import Foundation

/// `--no-capture` (selftest): behave as if Screen Recording were not granted,
/// so a test can exercise the refusal path without any chance of capturing.
var captureForbidden = false

func screenRecordingGranted() -> Bool {
  if captureForbidden { return false }
  return CGPreflightScreenCaptureAccess()
}

func accessibilityTrusted() -> Bool {
  let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
  return AXIsProcessTrustedWithOptions([key: false] as CFDictionary)
}

let screenRecordingSentence =
  "Screen Recording is not granted to wp-desktop. On the Mac, open System Settings → Privacy & Security → "
  + "Screen Recording, turn on wp-desktop, then open the desktop view again."

let accessibilitySentence =
  "Control needs Accessibility for wp-desktop. On the Mac, open System Settings → Privacy & Security → "
  + "Accessibility and turn on wp-desktop; until then taps and keys are dropped."

struct DisplayInfo {
  let id: CGDirectDisplayID
  let pixelWidth: Int
  let pixelHeight: Int
  let bounds: CGRect  // global points, top-left origin
  let main: Bool
  var scale: Double { bounds.width > 0 ? Double(pixelWidth) / Double(bounds.width) : 1 }

  var json: [String: Any] {
    [
      "id": Int(id), "width": pixelWidth, "height": pixelHeight, "scale": scale, "main": main,
      "bounds": ["x": bounds.minX, "y": bounds.minY, "w": bounds.width, "h": bounds.height],
    ]
  }
}

func activeDisplays() -> [DisplayInfo] {
  var count: UInt32 = 0
  guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
  let main = CGMainDisplayID()
  return ids.prefix(Int(count)).map { id in
    let mode = CGDisplayCopyDisplayMode(id)
    let pw = mode?.pixelWidth ?? CGDisplayPixelsWide(id)
    let ph = mode?.pixelHeight ?? CGDisplayPixelsHigh(id)
    return DisplayInfo(id: id, pixelWidth: pw, pixelHeight: ph, bounds: CGDisplayBounds(id), main: id == main)
  }
}

func osString() -> String {
  let v = ProcessInfo.processInfo.operatingSystemVersion
  return "macOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
}

func probeObject() -> [String: Any] {
  let r = responsibility()
  return [
    "t": "probe",
    "screenRecording": screenRecordingGranted(),
    "accessibility": accessibilityTrusted(),
    "displays": activeDisplays().map { $0.json },
    "os": osString(),
    "helperVersion": helperVersion,
    "pid": Int(r.pid),
    "responsiblePid": Int(r.responsible),
    "responsibleSelf": r.pid == r.responsible,
  ]
}

/// On-screen windows, metadata only (owner, bounds; the title only where the
/// system hands it out). CGWindowListCopyWindowInfo never prompts. Not part of
/// the default probe.
func windowList() -> [[String: Any]] {
  guard let arr = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]]
  else { return [] }
  return arr.compactMap { w in
    guard let id = w[kCGWindowNumber as String] as? Int, let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
      let b = w[kCGWindowBounds as String] as? [String: Any], let rect = CGRect(dictionaryRepresentation: b as CFDictionary)
    else { return nil }
    var o: [String: Any] = [
      "id": id, "pid": w[kCGWindowOwnerPID as String] as? Int ?? 0,
      "owner": w[kCGWindowOwnerName as String] as? String ?? "",
      "bounds": ["x": rect.minX, "y": rect.minY, "w": rect.width, "h": rect.height],
    ]
    if let n = w[kCGWindowName as String] as? String, !n.isEmpty { o["name"] = n }
    return o
  }
}

/// Global bounds (points) of one window, or of the frontmost normal window.
func windowBounds(_ id: CGWindowID?) -> (CGWindowID, CGRect)? {
  let opts: CGWindowListOption = id == nil ? [.optionOnScreenOnly, .excludeDesktopElements] : [.optionIncludingWindow]
  guard let arr = CGWindowListCopyWindowInfo(opts, id ?? kCGNullWindowID) as? [[String: Any]] else { return nil }
  for w in arr {
    guard let wid = w[kCGWindowNumber as String] as? Int, (w[kCGWindowLayer as String] as? Int) == 0,
      let b = w[kCGWindowBounds as String] as? [String: Any],
      let rect = CGRect(dictionaryRepresentation: b as CFDictionary), rect.width >= 40, rect.height >= 40
    else { continue }
    // Skip our own and the window server's helper windows when following the front.
    if id == nil, let owner = w[kCGWindowOwnerName as String] as? String, owner == "Window Server" { continue }
    return (CGWindowID(wid), rect)
  }
  return nil
}
