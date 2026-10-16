// Capture: ScreenCaptureKit on one display, one window, or the frontmost
// app's window (re-aimed at ≤1 Hz). SCK delivers a frame only when pixels
// change (SCFrameStatus.complete); a still screen sends .idle and costs nothing.
//
// SAFETY: nothing in this file runs unless CGPreflightScreenCaptureAccess()
// already says yes, so no code path here can raise the Screen Recording
// prompt. The server checks too; `start()` checks again.

import CoreGraphics
import CoreMedia
import Foundation
@preconcurrency import ScreenCaptureKit

private struct CaptureError: Error {
  let sentence: String
}

final class ScreenSource: NSObject, FrameSource, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  private let q: DispatchQueue
  private var p: Params
  private let cb: SourceCallbacks
  private var stream: SCStream?
  private var geo: Geometry?
  private var windowID: CGWindowID?
  private var followTimer: DispatchSourceTimer?
  private var stopped = false
  private var retargeting = false

  init(queue: DispatchQueue, params: Params, callbacks: SourceCallbacks) {
    q = queue
    p = params
    cb = callbacks
  }

  // MARK: lifecycle (all on q)

  func start() {
    guard screenRecordingGranted() else {
      cb.onError(screenRecordingSentence)
      return
    }
    let want = p
    Task {
      do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let (filter, g, wid) = try self.resolve(content, want)
        let s = SCStream(filter: filter, configuration: self.config(g, want), delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.q)
        try await s.startCapture()
        self.q.async {
          if self.stopped {
            s.stopCapture { _ in }
            return
          }
          self.stream = s
          self.windowID = wid
          self.setGeometry(g)
          if self.p != want { self.update(self.p) }  // params moved on while we were starting
          if wid != nil { self.startFollowing() }
        }
      } catch {
        self.q.async { self.cb.onError(Self.sentence(for: error)) }
      }
    }
  }

  func update(_ np: Params) {
    let old = p
    p = np
    guard let s = stream, !retargeting else { return }
    if case .window(let a) = old.source, case .window(let b) = np.source, a != b {
      retarget(to: b)
      return
    }
    guard let g = geo else { return }
    let ng = geometry(srcWidth: g.srcWidth, srcHeight: g.srcHeight, bounds: g.globalBounds)
    s.updateConfiguration(config(ng, np)) { err in
      if let err { self.q.async { self.cb.onError("capture could not change settings: \(err.localizedDescription)") } }
    }
    setGeometry(ng)
  }

  func stop() {
    stopped = true
    followTimer?.cancel()
    followTimer = nil
    stream?.stopCapture { _ in }
    stream = nil
  }

  // MARK: SCK callbacks

  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sb.isValid,
      let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let raw = atts.first?[.status] as? Int, let status = SCFrameStatus(rawValue: raw)
    else { return }
    switch status {
    case .complete:
      guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
      let t = CMSampleBufferGetPresentationTimeStamp(sb)
      let us = t.isValid && t.seconds > 0 ? UInt64(t.seconds * 1e6) : nowMicros()
      cb.onFrame(pb, us)
    case .idle:
      cb.onIdle()
    default:
      break
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    q.async {
      if self.stopped { return }
      self.cb.onError("capture stopped: " + Self.sentence(for: error))
    }
  }

  // MARK: geometry

  private func geometry(srcWidth: Int, srcHeight: Int, bounds: CGRect) -> Geometry {
    let (w, h) = outputSize(srcW: srcWidth, srcH: srcHeight, crop: p.crop, maxWidth: p.maxWidth, codec: p.codec)
    return Geometry(srcWidth: srcWidth, srcHeight: srcHeight, globalBounds: bounds, outWidth: w, outHeight: h)
  }

  private func setGeometry(_ g: Geometry) {
    if g != geo {
      geo = g
      cb.onGeometry(g)
    }
  }

  private func resolve(_ content: SCShareableContent, _ want: Params) throws -> (SCContentFilter, Geometry, CGWindowID?) {
    switch want.source {
    case .display(let id):
      let did = id ?? CGMainDisplayID()
      guard let d = content.displays.first(where: { $0.displayID == did }) else {
        throw CaptureError(sentence: "Display \(did) is not active on the Mac.")
      }
      let mode = CGDisplayCopyDisplayMode(did)
      let filter = SCContentFilter(display: d, excludingWindows: [])
      let g = geometry(srcWidth: mode?.pixelWidth ?? d.width, srcHeight: mode?.pixelHeight ?? d.height,
        bounds: CGDisplayBounds(did))
      return (filter, g, nil)
    case .window(let wid):
      return try windowFilter(content, wid)
    case .front:
      guard let (wid, _) = windowBounds(nil) else { throw CaptureError(sentence: "No window is in front on the Mac.") }
      return try windowFilter(content, wid)
    case .synthetic:
      throw CaptureError(sentence: "internal: the synthetic source is not a screen capture")
    }
  }

  private func windowFilter(_ content: SCShareableContent, _ wid: CGWindowID) throws -> (SCContentFilter, Geometry, CGWindowID?) {
    guard let w = content.windows.first(where: { $0.windowID == wid }) else {
      throw CaptureError(sentence: "Window \(wid) is not on screen any more.")
    }
    let filter = SCContentFilter(desktopIndependentWindow: w)
    let scale = Double(filter.pointPixelScale)
    let bounds = windowBounds(wid)?.1 ?? w.frame
    let g = geometry(srcWidth: Int(bounds.width * scale), srcHeight: Int(bounds.height * scale), bounds: bounds)
    return (filter, g, wid)
  }

  private func config(_ g: Geometry, _ p: Params) -> SCStreamConfiguration {
    let c = SCStreamConfiguration()
    c.width = g.outWidth
    c.height = g.outHeight
    c.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(p.fps))
    c.queueDepth = 3
    c.showsCursor = p.cursor
    c.capturesAudio = false
    c.pixelFormat = pixelFormat(for: p.codec)
    if p.codec == .h264 { c.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2 }
    // sourceRect is in points of the source (display-local or window-local).
    let pw = g.globalBounds.width, ph = g.globalBounds.height
    c.sourceRect = CGRect(x: p.crop.x * pw, y: p.crop.y * ph, width: p.crop.w * pw, height: p.crop.h * ph)
    c.scalesToFit = true
    return c
  }

  // MARK: following a window / the front window (≤1 Hz)

  private func startFollowing() {
    followTimer?.cancel()
    let t = DispatchSource.makeTimerSource(queue: q)
    t.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(100))
    t.setEventHandler { [weak self] in self?.follow() }
    t.resume()
    followTimer = t
  }

  private func follow() {
    guard stream != nil, !retargeting, let g = geo else { return }
    if case .front = p.source, let (wid, _) = windowBounds(nil), wid != windowID {
      retarget(to: wid)
      return
    }
    guard let wid = windowID else { return }
    guard let (_, rect) = windowBounds(wid) else {
      if case .front = p.source { return }  // the next poll picks the new front window
      cb.onError("The captured window was closed.")
      stop()
      return
    }
    if rect != g.globalBounds {
      let scale = g.globalBounds.width > 0 ? Double(g.srcWidth) / g.globalBounds.width : 2
      let ng = geometry(srcWidth: Int(rect.width * scale), srcHeight: Int(rect.height * scale), bounds: rect)
      stream?.updateConfiguration(config(ng, p)) { _ in }
      setGeometry(ng)
    }
  }

  private func retarget(to wid: CGWindowID) {
    guard let s = stream else { return }
    retargeting = true
    let want = p
    Task {
      do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let (filter, g, _) = try self.windowFilter(content, wid)
        try await s.updateContentFilter(filter)
        try await s.updateConfiguration(self.config(g, want))
        self.q.async {
          self.retargeting = false
          self.windowID = wid
          self.setGeometry(g)
          log("capture: now following window \(wid)")
        }
      } catch {
        self.q.async {
          self.retargeting = false
          self.cb.onError(Self.sentence(for: error))
        }
      }
    }
  }

  private static func sentence(for error: Error) -> String {
    if let e = error as? CaptureError { return e.sentence }
    let ns = error as NSError
    if ns.domain == SCStreamErrorDomain && ns.code == SCStreamError.userDeclined.rawValue { return screenRecordingSentence }
    return ns.localizedDescription
  }
}
