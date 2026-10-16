// H.264 through VideoToolbox: hardware, real-time, no B-frames, Annex-B out
// with SPS+PPS in front of every keyframe, so any record that carries the key
// flag is a complete entry point for a decoder that just joined.

import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

struct EncodedFrame {
  let data: Data
  let key: Bool
  let pts: UInt64
  /// Submit → output, µs. For JPEG this is the whole synchronous encode.
  let encodeMicros: UInt64
  let kind: RecordKind
  /// `avc1.PPCCLL` from the SPS, on H.264 keyframes only.
  let avc: String?
  /// The region the frame was submitted for, carried through the encoder so late output still
  /// says which config produced it.
  let region: Region
}

protocol FrameEncoder: AnyObject {
  var width: Int { get }
  var height: Int { get }
  var codec: Codec { get }
  /// Frames submitted and not yet out. The server drops new frames past a few.
  var inFlight: Int { get }
  func encode(_ pb: CVPixelBuffer, pts: UInt64, forceKey: Bool, region: Region)
  /// Same size and codec, new knobs (bitrate, fps, keyframe interval, quality…).
  func update(_ p: Params)
  func setBitrate(_ kbps: Int)
  func invalidate()
}

final class H264Encoder: FrameEncoder {
  let width: Int
  let height: Int
  let codec = Codec.h264
  private(set) var profile = "main"
  private(set) var hardware = false
  private var session: VTCompressionSession?
  private let sink: (EncodedFrame) -> Void
  private let lock = NSLock()
  private var submitted: [UInt64: UInt64] = [:]
  private var pending = 0
  private var params: Params

  var inFlight: Int {
    lock.lock()
    defer { lock.unlock() }
    return pending
  }

  init?(width: Int, height: Int, params: Params, sink: @escaping (EncodedFrame) -> Void) {
    self.width = width
    self.height = height
    self.params = params
    self.sink = sink
    let spec: [String: Any] = [
      kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder as String: true
    ]
    var s: VTCompressionSession?
    let st = VTCompressionSessionCreate(
      allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264,
      encoderSpecification: spec as CFDictionary, imageBufferAttributes: nil, compressedDataAllocator: nil,
      outputCallback: nil, refcon: nil, compressionSessionOut: &s)
    guard st == noErr, let s else {
      log("h264: VTCompressionSessionCreate \(width)x\(height) failed (\(st))")
      return nil
    }
    session = s
    set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue)
    set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse)
    if set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_Main_AutoLevel, quiet: true) != noErr {
      set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_Baseline_AutoLevel)
      profile = "baseline"
    } else {
      set(kVTCompressionPropertyKey_H264EntropyMode, kVTH264EntropyMode_CABAC, quiet: true)
    }
    set(kVTCompressionPropertyKey_MaxFrameDelayCount, 0 as NSNumber, quiet: true)
    set(kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, kCFBooleanTrue, quiet: true)
    applyRate(params.bitrateKbps)
    applyTiming(params)
    var hw: Unmanaged<CFTypeRef>?
    if VTSessionCopyProperty(s, key: kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
      allocator: nil, valueOut: &hw) == noErr, let b = hw?.takeRetainedValue() as? Bool
    {
      hardware = b
    }
    VTCompressionSessionPrepareToEncodeFrames(s)
    log("h264: \(width)x\(height) \(profile) \(hardware ? "hardware" : "software") \(params.bitrateKbps) kbps \(params.fps) fps")
  }

  deinit { invalidate() }

  @discardableResult
  private func set(_ k: CFString, _ v: CFTypeRef?, quiet: Bool = false) -> OSStatus {
    guard let session else { return -1 }
    let st = VTSessionSetProperty(session, key: k, value: v)
    if st != noErr && !quiet { log("h264: setting \(k) failed (\(st))") }
    return st
  }

  private func applyRate(_ kbps: Int) {
    let bps = kbps * 1000
    set(kVTCompressionPropertyKey_AverageBitRate, bps as NSNumber)
    // Hard ceiling: 1.5× the average over any 1 s window.
    let limits = [NSNumber(value: Double(bps) / 8 * 1.5), NSNumber(value: 1.0)] as CFArray
    set(kVTCompressionPropertyKey_DataRateLimits, limits)
  }

  private func applyTiming(_ p: Params) {
    set(kVTCompressionPropertyKey_ExpectedFrameRate, p.fps as NSNumber)
    if p.keyframeEverySec > 0 {
      set(kVTCompressionPropertyKey_MaxKeyFrameInterval, max(1, Int((p.keyframeEverySec * Double(p.fps)).rounded())) as NSNumber)
      set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, p.keyframeEverySec as NSNumber)
    } else {
      // On demand only: an interval nobody reaches (a day of frames at 60 fps).
      set(kVTCompressionPropertyKey_MaxKeyFrameInterval, 5_184_000 as NSNumber)
      set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, 86_400 as NSNumber)
    }
  }

  func update(_ p: Params) {
    if p.bitrateKbps != params.bitrateKbps { applyRate(p.bitrateKbps) }
    if p.fps != params.fps || p.keyframeEverySec != params.keyframeEverySec { applyTiming(p) }
    params = p
  }

  func setBitrate(_ kbps: Int) {
    params.bitrateKbps = kbps
    applyRate(kbps)
  }

  func invalidate() {
    if let s = session { VTCompressionSessionInvalidate(s) }
    session = nil
  }

  func encode(_ pb: CVPixelBuffer, pts: UInt64, forceKey: Bool, region: Region) {
    guard let s = session else { return }
    let t = CMTime(value: CMTimeValue(pts), timescale: 1_000_000)
    let props: CFDictionary? =
      forceKey ? [kVTEncodeFrameOptionKey_ForceKeyFrame as String: true] as CFDictionary : nil
    lock.lock()
    submitted[pts] = nowMicros()
    pending += 1
    lock.unlock()
    let st = VTCompressionSessionEncodeFrame(
      s, imageBuffer: pb, presentationTimeStamp: t, duration: .invalid, frameProperties: props, infoFlagsOut: nil
    ) { [weak self] status, flags, sb in
      self?.output(status, flags, sb, pts, region)
    }
    if st != noErr {
      log("h264: encode failed (\(st))")
      lock.lock()
      submitted[pts] = nil
      pending -= 1
      lock.unlock()
    }
  }

  private func output(_ status: OSStatus, _ flags: VTEncodeInfoFlags, _ sb: CMSampleBuffer?, _ pts: UInt64, _ region: Region) {
    lock.lock()
    let sub = submitted.removeValue(forKey: pts)
    pending -= 1
    lock.unlock()
    guard status == noErr, let sb, let bb = CMSampleBufferGetDataBuffer(sb) else {
      if status != noErr { log("h264: encoder returned \(status)") }
      return
    }
    var key = true
    if let arr = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]],
      let a = arr.first, let notSync = a[kCMSampleAttachmentKey_NotSync] as? Bool
    {
      key = !notSync
    }
    let total = CMBlockBufferGetDataLength(bb)
    var avcc = Data(count: total)
    let copied = avcc.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(bb, atOffset: 0, dataLength: total, destination: $0.baseAddress!) }
    guard copied == kCMBlockBufferNoErr else { return }

    let startCode: [UInt8] = [0, 0, 0, 1]
    var out = Data(capacity: total + 64)
    var nalLen: Int32 = 4
    var avc: String?
    if let fd = CMSampleBufferGetFormatDescription(sb) {
      var count = 0
      CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        fd, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil,
        parameterSetCountOut: &count, nalUnitHeaderLengthOut: &nalLen)
      if key {
        for i in 0..<count {
          var p: UnsafePointer<UInt8>?
          var n = 0
          guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            fd, parameterSetIndex: i, parameterSetPointerOut: &p, parameterSetSizeOut: &n,
            parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let p
          else { continue }
          out.append(contentsOf: startCode)
          out.append(p, count: n)
          if i == 0 && n >= 4 { avc = String(format: "avc1.%02x%02x%02x", p[1], p[2], p[3]) }
        }
      }
    }
    // AVCC length prefixes → Annex-B start codes.
    let L = Int(nalLen)
    avcc.withUnsafeBytes { raw in
      let b = raw.bindMemory(to: UInt8.self)
      var off = 0
      while off + L <= total {
        var len = 0
        for i in 0..<L { len = (len << 8) | Int(b[off + i]) }
        off += L
        guard len > 0, off + len <= total else { break }
        out.append(contentsOf: startCode)
        out.append(b.baseAddress! + off, count: len)
        off += len
      }
    }
    let enc = sub.map { nowMicros() &- $0 } ?? 0
    sink(EncodedFrame(data: out, key: key, pts: pts, encodeMicros: enc, kind: .h264, avc: avc, region: region))
  }
}
