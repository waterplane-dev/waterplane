// JPEG through ImageIO: the fallback where the phone has no WebCodecs (plain
// http, no secure context). Every frame is a key frame; grayscale goes through
// a DeviceGray bitmap so the JPEG carries one component, not three.

import CoreGraphics
import CoreVideo
import Foundation
import ImageIO

final class JpegEncoder: FrameEncoder {
  let width: Int
  let height: Int
  let codec = Codec.jpeg
  let inFlight = 0  // synchronous
  private var quality: Int
  private var grayscale: Bool
  private let sink: (EncodedFrame) -> Void
  private let rgb = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
  private let gray = CGColorSpaceCreateDeviceGray()
  private var warnedFormat = false

  init(width: Int, height: Int, params: Params, sink: @escaping (EncodedFrame) -> Void) {
    self.width = width
    self.height = height
    quality = params.jpegQuality
    grayscale = params.grayscale
    self.sink = sink
    log("jpeg: \(width)x\(height) q\(quality)\(grayscale ? " grayscale" : "")")
  }

  func update(_ p: Params) {
    quality = p.jpegQuality
    grayscale = p.grayscale
  }

  func setBitrate(_ kbps: Int) {}  // JPEG has no bitrate; quality and fps are its knobs.
  func invalidate() {}

  func encode(_ pb: CVPixelBuffer, pts: UInt64, forceKey: Bool, region: Region) {
    let t0 = nowMicros()
    guard CVPixelBufferGetPixelFormatType(pb) == kCVPixelFormatType_32BGRA else {
      if !warnedFormat { log("jpeg: frame is not BGRA, dropped") }
      warnedFormat = true
      return
    }
    guard let image = makeImage(pb), let data = jpegData(image) else {
      log("jpeg: encode failed")
      return
    }
    sink(EncodedFrame(data: data, key: true, pts: pts, encodeMicros: nowMicros() - t0, kind: .jpeg, avc: nil, region: region))
  }

  /// One copy out of the pixel buffer (the buffer goes back to its pool right after).
  private func makeImage(_ pb: CVPixelBuffer) -> CGImage? {
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pb) else { return nil }
    let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb), bpr = CVPixelBufferGetBytesPerRow(pb)
    let info = CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    guard let src = CGContext(data: base, width: w, height: h, bitsPerComponent: 8, bytesPerRow: bpr,
      space: rgb, bitmapInfo: info)
    else { return nil }
    guard grayscale else { return src.makeImage() }
    guard let img = src.makeImage(),
      let g = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: gray,
        bitmapInfo: CGImageAlphaInfo.none.rawValue)
    else { return nil }
    g.interpolationQuality = .none
    g.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return g.makeImage()
  }

  private func jpegData(_ img: CGImage) -> Data? {
    let out = NSMutableData()
    guard let dst = CGImageDestinationCreateWithData(out as CFMutableData, "public.jpeg" as CFString, 1, nil) else { return nil }
    let opts: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: Double(quality) / 100]
    CGImageDestinationAddImage(dst, img, opts as CFDictionary)
    guard CGImageDestinationFinalize(dst) else { return nil }
    return out as Data
  }
}
