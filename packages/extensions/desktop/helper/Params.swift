// Params: the one parameter object a `config` command carries, clamped here so
// the rest of the helper never sees an out-of-range value.

import CoreGraphics
import Foundation

enum Codec: String {
  case h264
  case jpeg
}

enum SourceSpec: Equatable {
  case display(CGDirectDisplayID?)
  case window(CGWindowID)
  case front
  /// `idle` makes the pattern stand still for half of every 6 s cycle, which is
  /// what SCK does on a still screen: no frames at all.
  case synthetic(idle: Bool)

  var kind: String {
    switch self {
    case .display: return "display"
    case .window: return "window"
    case .front: return "front"
    case .synthetic: return "synthetic"
    }
  }

  /// Two specs that need a different capture object (display ↔ window ↔ front).
  /// A change inside one kind (another window id) can be re-aimed live.
  func sameKind(_ o: SourceSpec) -> Bool { kind == o.kind }
}

/// Normalised 0..1 of the full source.
struct Crop: Equatable {
  var x = 0.0, y = 0.0, w = 1.0, h = 1.0
  var isFull: Bool { x == 0 && y == 0 && w == 1 && h == 1 }
}

struct Params: Equatable {
  var codec: Codec = .h264
  var source: SourceSpec = .display(nil)
  var crop = Crop()
  var maxWidth = 1280
  var fps = 15
  var bitrateKbps = 1000
  var jpegQuality = 50
  var grayscale = false
  var keyframeEverySec = 0.0
  var cursor = true

  static func clampBitrate(_ v: Int) -> Int { min(20000, max(50, v)) }

  /// A config is a FULL params object: a field left out takes its default,
  /// not its previous value. Unknown fields are ignored; wrong types fall back
  /// to the default with one warning each.
  static func parse(_ o: [String: Any], warn: (String) -> Void) -> Params {
    var p = Params()
    func num(_ k: String) -> Double? {
      guard let v = o[k] else { return nil }
      if let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() { return n.doubleValue }
      warn("param \(k): expected a number, ignored")
      return nil
    }
    func bool(_ k: String) -> Bool? {
      guard let v = o[k] else { return nil }
      if let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue }
      warn("param \(k): expected true/false, ignored")
      return nil
    }
    if let c = o["codec"] {
      if let s = c as? String, let k = Codec(rawValue: s) { p.codec = k } else { warn("param codec: expected \"h264\" or \"jpeg\", ignored") }
    }
    if let s = o["source"] {
      if let d = s as? [String: Any], let k = d["kind"] as? String {
        let id = (d["id"] as? NSNumber)?.uint32Value
        switch k {
        case "display": p.source = .display(id)
        case "window":
          if let id { p.source = .window(id) } else { warn("param source: a window needs an id, using the main display") }
        case "front": p.source = .front
        case "synthetic": p.source = .synthetic(idle: (d["idle"] as? Bool) ?? false)
        default: warn("param source: unknown kind \(k), using the main display")
        }
      } else { warn("param source: expected {kind:…}, using the main display") }
    }
    if let c = o["crop"] {
      if let d = c as? [String: Any] {
        func f(_ k: String, _ def: Double) -> Double { ((d[k] as? NSNumber)?.doubleValue).map { $0.isFinite ? $0 : def } ?? def }
        var x = min(0.98, max(0, f("x", 0))), y = min(0.98, max(0, f("y", 0)))
        var w = min(1, max(0.02, f("w", 1))), h = min(1, max(0.02, f("h", 1)))
        if x + w > 1 { w = 1 - x }
        if y + h > 1 { h = 1 - y }
        if w < 0.02 { x = 0.98; w = 0.02 }
        if h < 0.02 { y = 0.98; h = 0.02 }
        p.crop = Crop(x: x, y: y, w: w, h: h)
      } else { warn("param crop: expected {x,y,w,h}, ignored") }
    }
    if let v = num("maxWidth") { p.maxWidth = v <= 0 ? 0 : min(8192, max(64, Int(v))) }
    if let v = num("fps") { p.fps = min(60, max(1, Int(v.rounded()))) }
    if let v = num("bitrateKbps") { p.bitrateKbps = clampBitrate(Int(v)) }
    if let v = num("jpegQuality") { p.jpegQuality = min(100, max(1, Int(v))) }
    if let v = bool("grayscale") { p.grayscale = v }
    if let v = num("keyframeEverySec") { p.keyframeEverySec = v <= 0 ? 0 : min(3600, v) }
    if let v = bool("cursor") { p.cursor = v }
    return p
  }
}

/// What one source looks like right now, and what we encode out of it.
struct Geometry: Equatable {
  /// Full source size in pixels (display or window, NOT the crop).
  var srcWidth: Int
  var srcHeight: Int
  /// Full source bounds in global display points (top-left origin, CGEvent space).
  var globalBounds: CGRect
  /// Encoded output size, even numbers.
  var outWidth: Int
  var outHeight: Int
}

/// Output size for a crop of a source: keep aspect, never upscale, even numbers.
func outputSize(srcW: Int, srcH: Int, crop: Crop, maxWidth: Int, codec: Codec) -> (Int, Int) {
  let cw = max(2.0, Double(srcW) * crop.w), ch = max(2.0, Double(srcH) * crop.h)
  var w = maxWidth == 0 ? cw : min(cw, Double(maxWidth))
  var h = w * ch / cw
  // The H.264 hardware encoder tops out at 4096 on either side.
  let cap = codec == .h264 ? 4096.0 : 8192.0
  if h > cap { w = w * cap / h; h = cap }
  if w > cap { h = h * cap / w; w = cap }
  func even(_ v: Double) -> Int { max(16, Int(v / 2) * 2) }
  return (even(w), even(h))
}
