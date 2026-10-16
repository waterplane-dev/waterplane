// Input: phone gestures → CGEvents. Coordinates arrive normalised 0..1 of the
// CURRENT SOURCE's full bounds (display or window, not the crop) and are mapped
// to global display points here, so the phone never knows desktop pixels.
//
// With --dry-input every event is built exactly as it would be posted, then
// logged instead of posted. Tests never post.

import CoreGraphics
import Foundation

private enum Btn: String {
  case l, r, m
  var cg: CGMouseButton { self == .l ? .left : self == .r ? .right : .center }
  var down: CGEventType { self == .l ? .leftMouseDown : self == .r ? .rightMouseDown : .otherMouseDown }
  var up: CGEventType { self == .l ? .leftMouseUp : self == .r ? .rightMouseUp : .otherMouseUp }
  var drag: CGEventType { self == .l ? .leftMouseDragged : self == .r ? .rightMouseDragged : .otherMouseDragged }
}

/// US layout virtual key codes (Carbon kVK_*).
private let namedKeys: [String: CGKeyCode] = [
  "Escape": 0x35, "Esc": 0x35, "Tab": 0x30, "Return": 0x24, "Enter": 0x24, "Backspace": 0x33,
  "Delete": 0x75, "ArrowUp": 0x7E, "ArrowDown": 0x7D, "ArrowLeft": 0x7B, "ArrowRight": 0x7C,
  "Home": 0x73, "End": 0x77, "PageUp": 0x74, "PageDown": 0x79, "Space": 0x31, " ": 0x31,
  "F1": 0x7A, "F2": 0x78, "F3": 0x63, "F4": 0x76, "F5": 0x60, "F6": 0x61, "F7": 0x62, "F8": 0x64,
  "F9": 0x65, "F10": 0x6D, "F11": 0x67, "F12": 0x6F,
]

private let charKeys: [Character: CGKeyCode] = [
  "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07, "c": 0x08,
  "v": 0x09, "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11, "1": 0x12,
  "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "=": 0x18, "9": 0x19, "7": 0x1A, "-": 0x1B,
  "8": 0x1C, "0": 0x1D, "]": 0x1E, "o": 0x1F, "u": 0x20, "[": 0x21, "i": 0x22, "p": 0x23, "l": 0x25,
  "j": 0x26, "'": 0x27, "k": 0x28, ";": 0x29, "\\": 0x2A, ",": 0x2B, "/": 0x2C, "n": 0x2D, "m": 0x2E,
  ".": 0x2F, "`": 0x32,
]

/// Characters typed with Shift on a US keyboard → their unshifted key.
private let shifted: [Character: Character] = [
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/",
  "~": "`",
]

private let modFlags: [String: CGEventFlags] = [
  "cmd": .maskCommand, "meta": .maskCommand, "alt": .maskAlternate, "option": .maskAlternate,
  "ctrl": .maskControl, "control": .maskControl, "shift": .maskShift,
]

/// Key code (+ whether Shift is implied) for a `key` name: a named key or one printable US-layout char.
func keyCode(for key: String) -> (CGKeyCode, Bool)? {
  if let k = namedKeys[key] { return (k, false) }
  guard key.count == 1, let ch = key.first else { return nil }
  if let k = charKeys[ch] { return (k, false) }
  if ch.isUppercase, let lower = ch.lowercased().first, let k = charKeys[lower] { return (k, true) }
  if let base = shifted[ch], let k = charKeys[base] { return (k, true) }
  return nil
}

/// Splits text into ≤20 UTF-16 unit chunks without cutting a surrogate pair.
func utf16Chunks(_ s: String, max n: Int = 20) -> [[UniChar]] {
  let u = Array(s.utf16)
  var out = [[UniChar]]()
  var i = 0
  while i < u.count {
    var j = min(u.count, i + n)
    if j < u.count && j - i > 1 && UTF16.isLeadSurrogate(u[j - 1]) { j -= 1 }
    out.append(Array(u[i..<j]))
    i = j
  }
  return out
}

private func typeName(_ t: CGEventType) -> String {
  switch t {
  case .mouseMoved: return "mouseMoved"
  case .leftMouseDown: return "leftMouseDown"
  case .leftMouseUp: return "leftMouseUp"
  case .rightMouseDown: return "rightMouseDown"
  case .rightMouseUp: return "rightMouseUp"
  case .otherMouseDown: return "otherMouseDown"
  case .otherMouseUp: return "otherMouseUp"
  case .leftMouseDragged: return "leftMouseDragged"
  case .rightMouseDragged: return "rightMouseDragged"
  case .otherMouseDragged: return "otherMouseDragged"
  case .scrollWheel: return "scrollWheel"
  case .keyDown: return "keyDown"
  case .keyUp: return "keyUp"
  default: return "type\(t.rawValue)"
  }
}

final class InputInjector {
  let dry: Bool
  private let src = CGEventSource(stateID: .hidSystemState)
  private var held: Btn?

  init(dry: Bool) { self.dry = dry }

  /// nil when handled; otherwise the sentence why the event was ignored.
  func handle(_ ev: [String: Any], bounds: CGRect) -> String? {
    guard let k = ev["k"] as? String else { return "input without k" }
    let flags = parseMods(ev["mods"])
    func point() -> CGPoint? {
      guard let x = (ev["x"] as? NSNumber)?.doubleValue, let y = (ev["y"] as? NSNumber)?.doubleValue,
        x.isFinite, y.isFinite, x >= -0.05, x <= 1.05, y >= -0.05, y <= 1.05
      else { return nil }
      let cx = min(1, max(0, x)), cy = min(1, max(0, y))
      return CGPoint(x: bounds.minX + cx * bounds.width, y: bounds.minY + cy * bounds.height)
    }
    func button() -> Btn? { (ev["b"] as? String).flatMap(Btn.init(rawValue:)) ?? (ev["b"] == nil ? .l : nil) }

    switch k {
    case "move":
      guard let p = point() else { return "move needs x,y in 0..1" }
      mouse(held?.drag ?? .mouseMoved, p, held ?? .l, flags, clicks: 0)
    case "down", "up":
      guard let p = point() else { return "\(k) needs x,y in 0..1" }
      guard let b = button() else { return "\(k): b must be l, r or m" }
      if k == "down" {
        held = b
        mouse(b.down, p, b, flags, clicks: 1)
      } else {
        if held == b { held = nil }
        mouse(b.up, p, b, flags, clicks: 1)
      }
    case "click":
      guard let p = point() else { return "click needs x,y in 0..1" }
      guard let b = button() else { return "click: b must be l, r or m" }
      let n = min(3, max(1, (ev["n"] as? NSNumber)?.intValue ?? 1))
      mouse(.mouseMoved, p, b, flags, clicks: 0)
      for i in 1...n {
        mouse(b.down, p, b, flags, clicks: i)
        mouse(b.up, p, b, flags, clicks: i)
      }
    case "scroll":
      guard let p = point() else { return "scroll needs x,y in 0..1" }
      // DOM convention: positive dy scrolls the content down (wheel toward you is negative in CG).
      let dx = (ev["dx"] as? NSNumber)?.doubleValue ?? 0, dy = (ev["dy"] as? NSNumber)?.doubleValue ?? 0
      guard dx.isFinite, dy.isFinite else { return "scroll needs finite dx,dy" }
      let w1 = Int32(max(-10000, min(10000, -dy))), w2 = Int32(max(-10000, min(10000, -dx)))
      mouse(held?.drag ?? .mouseMoved, p, held ?? .l, flags, clicks: 0)
      guard let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2, wheel1: w1, wheel2: w2, wheel3: 0)
      else { return "scroll: could not build the event" }
      e.location = p
      e.flags = flags
      post(e, "wheel=\(w1),\(w2)")
    case "key":
      guard let name = ev["key"] as? String, let (code, shift) = keyCode(for: name) else {
        return "key: unknown key \(String(describing: ev["key"] ?? "nil"))"
      }
      let f = shift ? flags.union(.maskShift) : flags
      for down in [true, false] {
        guard let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { return "key: could not build the event" }
        e.flags = f
        post(e, String(format: "key=0x%02x", code))
      }
    case "text":
      guard let s = ev["s"] as? String, !s.isEmpty else { return "text needs a non-empty s" }
      guard s.utf16.count <= 4096 else { return "text longer than 4096 UTF-16 units" }
      for chunk in utf16Chunks(s) {
        for down in [true, false] {
          guard let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down) else { return "text: could not build the event" }
          chunk.withUnsafeBufferPointer { e.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress) }
          let shown = String(decoding: chunk, as: UTF16.self)
          post(e, "text=\(jsonLine(["s": shown]).dropFirst(5).dropLast()) units=\(chunk.count)")
        }
      }
    default:
      return "unknown input kind \(k)"
    }
    return nil
  }

  private func parseMods(_ v: Any?) -> CGEventFlags {
    var f = CGEventFlags()
    for m in (v as? [String]) ?? [] { if let x = modFlags[m] { f.insert(x) } }
    return f
  }

  private func mouse(_ t: CGEventType, _ p: CGPoint, _ b: Btn, _ flags: CGEventFlags, clicks: Int) {
    guard let e = CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: p, mouseButton: b.cg) else { return }
    if clicks > 0 { e.setIntegerValueField(.mouseEventClickState, value: Int64(clicks)) }
    e.flags = flags
    post(e, clicks > 0 ? "button=\(b.rawValue) clicks=\(clicks)" : "")
  }

  private func post(_ e: CGEvent, _ extra: String) {
    if dry {
      let p = e.location
      log(String(format: "dry-input: %@ x=%.1f y=%.1f flags=0x%llx %@", typeName(e.type), p.x, p.y, e.flags.rawValue, extra))
      return
    }
    e.post(tap: .cghidEventTap)
  }
}
