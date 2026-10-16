// Synthetic source: a desktop-like test pattern rendered without any capture
// API, fed into the same encoder/output path as a real capture. Every test uses
// it, so nothing in a test can touch the real screen or ask for a permission.
//
// The pattern lives on a virtual 2560×1600 "desktop" so `crop` and `maxWidth`
// behave exactly as they do on a display:
//   - a light, mostly static background and menu bar
//   - an editor window whose text-like lines scroll ~3 lines per second
//   - a dark terminal panel whose glyphs churn every frame (the part that costs bits)
//   - a cursor-like square on a slow Lissajous path

import CoreGraphics
import CoreVideo
import Foundation

protocol FrameSource: AnyObject {
  func start()
  /// Same source kind, new params: re-steer without a restart where possible.
  func update(_ p: Params)
  func stop()
}

/// All callbacks arrive on the server's queue.
struct SourceCallbacks {
  let onGeometry: (Geometry) -> Void
  let onFrame: (CVPixelBuffer, UInt64) -> Void
  let onIdle: () -> Void
  let onError: (String) -> Void
}

func pixelFormat(for codec: Codec) -> OSType {
  codec == .h264 ? kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange : kCVPixelFormatType_32BGRA
}

@inline(__always) private func mix(_ a: Int, _ b: Int, _ c: Int) -> UInt32 {
  var x = UInt32(truncatingIfNeeded: (a &* 73_856_093) ^ (b &* 19_349_663) ^ (c &* 83_492_791))
  x ^= x >> 13
  x = x &* 0x5bd1_e995
  x ^= x >> 15
  return x
}

final class SyntheticSource: FrameSource {
  static let VW = 2560, VH = 1600
  private let q: DispatchQueue
  private var p: Params
  private let cb: SourceCallbacks
  private var timer: DispatchSourceTimer?
  private var pool: CVPixelBufferPool?
  private var poolKey: (Int, Int, OSType) = (0, 0, 0)
  private var geo: Geometry?
  private let t0 = nowMicros()
  private var frameNo = 0
  private var wasIdle = false
  private var colMap = [Int32]()
  private var row = [UInt8]()
  private let yLut: [UInt8] = (0..<256).map { UInt8(16 + $0 * 219 / 255) }

  init(queue: DispatchQueue, params: Params, callbacks: SourceCallbacks) {
    q = queue
    p = params
    cb = callbacks
  }

  func start() {
    recomputeGeometry()
    startTimer()
  }

  func update(_ np: Params) {
    let fpsChanged = np.fps != p.fps
    p = np
    recomputeGeometry()
    if fpsChanged { startTimer() }
  }

  func stop() {
    timer?.cancel()
    timer = nil
  }

  private func recomputeGeometry() {
    var bounds = CGDisplayBounds(CGMainDisplayID())
    if bounds.width < 1 { bounds = CGRect(x: 0, y: 0, width: 1280, height: 800) }
    let (w, h) = outputSize(srcW: Self.VW, srcH: Self.VH, crop: p.crop, maxWidth: p.maxWidth, codec: p.codec)
    let g = Geometry(srcWidth: Self.VW, srcHeight: Self.VH, globalBounds: bounds, outWidth: w, outHeight: h)
    if g != geo {
      geo = g
      cb.onGeometry(g)
    }
  }

  private func startTimer() {
    timer?.cancel()
    let t = DispatchSource.makeTimerSource(flags: .strict, queue: q)
    let interval = 1.0 / Double(p.fps)
    t.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(1))
    t.setEventHandler { [weak self] in self?.tick() }
    t.resume()
    timer = t
  }

  private func tick() {
    guard let g = geo else { return }
    let now = nowMicros()
    let t = Double(now - t0) / 1e6
    if case .synthetic(let idle) = p.source, idle, t.truncatingRemainder(dividingBy: 6) >= 3 {
      if !wasIdle { cb.onIdle() }
      wasIdle = true
      return
    }
    wasIdle = false
    let fmt = pixelFormat(for: p.codec)
    if pool == nil || poolKey != (g.outWidth, g.outHeight, fmt) {
      pool = makePool(g.outWidth, g.outHeight, fmt)
      poolKey = (g.outWidth, g.outHeight, fmt)
    }
    guard let pool else { return }
    var pbOut: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pbOut) == kCVReturnSuccess, let pb = pbOut else {
      log("synthetic: no pixel buffer from the pool")
      return
    }
    frameNo += 1
    render(pb, g, t)
    cb.onFrame(pb, now)
  }

  private func makePool(_ w: Int, _ h: Int, _ fmt: OSType) -> CVPixelBufferPool? {
    let attrs: [String: Any] = [
      kCVPixelBufferPixelFormatTypeKey as String: fmt,
      kCVPixelBufferWidthKey as String: w,
      kCVPixelBufferHeightKey as String: h,
      kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
    ]
    var pool: CVPixelBufferPool?
    CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &pool)
    return pool
  }

  // MARK: rendering

  private func render(_ pb: CVPixelBuffer, _ g: Geometry, _ t: Double) {
    let W = g.outWidth, H = g.outHeight
    let c = p.crop
    let cx0 = c.x * Double(Self.VW), cw = c.w * Double(Self.VW)
    let cy0 = c.y * Double(Self.VH), ch = c.h * Double(Self.VH)
    if colMap.count != W {
      colMap = [Int32](repeating: 0, count: W)
      row = [UInt8](repeating: 0, count: W)
    }
    for x in 0..<W { colMap[x] = Int32(cx0 + (Double(x) + 0.5) * cw / Double(W)) }
    let scroll = Int(t * 3 * 32)  // 3 lines of 32 px per second
    let curX = Int(1280 + 900 * sin(t * 0.7)), curY = Int(800 + 500 * sin(t * 1.1))
    let frame = frameNo
    let bgra = CVPixelBufferGetPixelFormatType(pb) == kCVPixelFormatType_32BGRA

    CVPixelBufferLockBaseAddress(pb, [])
    defer { CVPixelBufferUnlockBaseAddress(pb, []) }
    let plane0 = bgra ? CVPixelBufferGetBaseAddress(pb)! : CVPixelBufferGetBaseAddressOfPlane(pb, 0)!
    let stride0 = bgra ? CVPixelBufferGetBytesPerRow(pb) : CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
    let out = plane0.assumingMemoryBound(to: UInt8.self)

    colMap.withUnsafeBufferPointer { cm in
      row.withUnsafeMutableBufferPointer { rw in
        for y in 0..<H {
          let vy = Int(cy0 + (Double(y) + 0.5) * ch / Double(H))
          fillRow(vy: vy, scroll: scroll, frame: frame, curX: curX, curY: curY, cm: cm, row: rw)
          let dst = out + y * stride0
          if bgra {
            for x in 0..<W {
              let v = rw[x]
              dst[4 * x] = v
              dst[4 * x + 1] = v
              dst[4 * x + 2] = v
              dst[4 * x + 3] = 255
            }
          } else {
            yLut.withUnsafeBufferPointer { lut in for x in 0..<W { dst[x] = lut[Int(rw[x])] } }
          }
        }
      }
    }

    // Colour: the cursor square is orange so the chroma path is exercised too.
    let ox0 = Int((Double(curX) - cx0) * Double(W) / cw), ox1 = Int((Double(curX + 28) - cx0) * Double(W) / cw)
    let oy0 = Int((Double(curY) - cy0) * Double(H) / ch), oy1 = Int((Double(curY + 28) - cy0) * Double(H) / ch)
    if bgra {
      for y in max(0, oy0)..<max(max(0, oy0), min(H, oy1)) {
        let dst = out + y * stride0
        for x in max(0, ox0)..<max(max(0, ox0), min(W, ox1)) {
          dst[4 * x] = 20
          dst[4 * x + 1] = 120
          dst[4 * x + 2] = 240
        }
      }
    } else {
      let uv = CVPixelBufferGetBaseAddressOfPlane(pb, 1)!.assumingMemoryBound(to: UInt8.self)
      let strideUV = CVPixelBufferGetBytesPerRowOfPlane(pb, 1)
      let hw = (W + 1) / 2
      for y in 0..<((H + 1) / 2) {
        let dst = uv + y * strideUV
        let inCur = 2 * y >= oy0 && 2 * y < oy1
        for x in 0..<hw {
          if inCur && 2 * x >= ox0 && 2 * x < ox1 {
            dst[2 * x] = 70
            dst[2 * x + 1] = 200
          } else {
            dst[2 * x] = 128
            dst[2 * x + 1] = 128
          }
        }
      }
    }
  }

  /// One row of luma (0 = black, 255 = white) at virtual row `vy`.
  @inline(__always)
  private func fillRow(
    vy: Int, scroll: Int, frame: Int, curX: Int, curY: Int,
    cm: UnsafeBufferPointer<Int32>, row: UnsafeMutableBufferPointer<UInt8>
  ) {
    let W = row.count
    if vy < 48 {  // menu bar: static
      for x in 0..<W { row[x] = 238 }
      return
    }
    let base: UInt8 = 206 &+ UInt8((vy >> 6) & 1) &* 4
    // Editor window rows.
    let inEditor = vy >= 120 && vy < 1450
    let edTitle = vy < 170
    let ly = vy - 170 + scroll
    let eLine = ly >> 5, eR = ly & 31
    let eGlyphRow = !edTitle && eR >= 8 && eR < 26
    let eGy = (eR - 8) / 3
    let eHash = mix(eLine, 0, 7)
    let eLen = 16 + Int(eHash % 72), eIndent = Int((eHash >> 8) % 4) * 2
    // Terminal panel rows.
    let inTerm = vy >= 300 && vy < 1100
    let tTitle = vy < 340
    let tl = vy - 340
    let tLine = tl >> 5, tR = tl & 31
    let tGlyphRow = !tTitle && tR >= 8 && tR < 26
    let tGy = (tR - 8) / 3
    let tHash = mix(tLine, frame, 11)
    let tLen = 8 + Int(tHash % 32)
    let inCursor = vy >= curY && vy < curY + 28

    for x in 0..<W {
      let vx = Int(cm[x])
      var v = base
      if inEditor && vx >= 200 && vx < 1700 {
        if edTitle {
          v = 214
        } else {
          v = 252
          if eGlyphRow {
            let col = (vx - 216) >> 4, cx = (vx - 216) & 15
            if vx >= 216 && col >= eIndent && col < eIndent + eLen && cx < 12 && mix(eLine, col, 1) % 7 != 0 {
              if (mix(eLine, col, eGy + 2) >> UInt32(cx >> 1)) & 1 == 1 { v = 28 }
            }
          }
        }
      } else if inTerm && vx >= 1800 && vx < 2450 {
        if tTitle {
          v = 64
        } else {
          v = 30
          if tGlyphRow {
            let col = (vx - 1812) >> 4, cx = (vx - 1812) & 15
            if vx >= 1812 && col < tLen && cx < 12 && mix(tLine, col, frame) % 5 != 0 {
              if (mix(tLine &+ frame, col, tGy + 2) >> UInt32(cx >> 1)) & 1 == 1 { v = 224 }
            }
          }
        }
      }
      if inCursor && vx >= curX && vx < curX + 28 { v = 12 }
      row[x] = v
    }
  }
}
