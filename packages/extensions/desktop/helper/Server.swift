// Server: the `serve` pipeline. One serial queue owns all state; the source
// delivers frames on it, commands are applied on it, and only the H.264
// encoder's output callback (VideoToolbox's thread) writes from elsewhere,
// through Output's lock.

import CoreGraphics
import CoreVideo
import Foundation

final class Server {
  let q = DispatchQueue(label: "wp-desktop.server", qos: .userInteractive)
  private let dryInput: Bool
  private let forceSynthetic: Bool
  private let input: InputInjector
  private var params: Params?
  private var source: FrameSource?
  private var encoder: FrameEncoder?
  private var geo: Geometry?
  private var state = "stopped"
  private var inConfigure = false
  private var lastFrame: CVPixelBuffer?
  private var lastFrameAt: UInt64 = 0
  private var lastPts: UInt64 = 0
  private var forceKey = false
  /// The region the NEXT submitted frame belongs to (see `Region`): bumped by every config that
  /// moves the crop or the source, and by every source restart.
  private var regionSeq = 0
  private var region = Region(seq: 0, crop: Crop())
  /// Held only while a source is running: App Nap off and no idle system sleep. A helper that sits
  /// in "error" or "stopped" (Screen Recording not granted, the view left open on that sentence)
  /// must not keep the Mac awake.
  private var activity: NSObjectProtocol?
  private var idle = false
  private var axCache: (at: UInt64, ok: Bool) = (0, false)
  private var axToldAt: UInt64 = 0
  private var statsTimer: DispatchSourceTimer?
  private var watchdog: DispatchSourceTimer?
  private let parentAtStart = getppid()

  // Written from the encoder's thread.
  private let statsLock = NSLock()
  private var frames = 0, keys = 0, bytes = 0, captured = 0, dropped = 0
  private var encSum: UInt64 = 0, encMax: UInt64 = 0
  private var statsSince = nowMicros()
  private var avc: String?

  init(dryInput: Bool, forceSynthetic: Bool) {
    self.dryInput = dryInput
    self.forceSynthetic = forceSynthetic
    input = InputInjector(dry: dryInput)
  }

  func run() {
    StdinReader(
      onCommand: { [self] c in q.async { self.apply(c) } },
      onEOF: { [self] in
        log("stdin closed, exiting")
        // Never leave a capture running: stop on the queue, and exit regardless after 0.5 s.
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { exit(0) }
        q.async {
          self.source?.stop()
          self.encoder?.invalidate()
          exit(0)
        }
      }
    ).start()
    startTimers()
    log("serve: ready (\(dryInput ? "dry input, " : "")\(forceSynthetic ? "synthetic source" : "screen source"))")
  }

  // MARK: commands

  private func apply(_ c: Command) {
    switch c {
    case .config(let o): configure(o)
    case .keyframe: requestKey()
    case .bitrate(let k):
      guard var p = params else { return }
      p.bitrateKbps = Params.clampBitrate(k)
      params = p
      encoder?.setBitrate(p.bitrateKbps)
      emitStatus()
    case .input(let ev): inject(ev)
    case .stop: stopAll(reason: nil)
    case .probe: Output.shared.json(probeObject())
    }
  }

  private func configure(_ o: [String: Any]) {
    var np = Params.parse(o, warn: { log($0) })
    if forceSynthetic, np.source.kind != "synthetic" { np.source = .synthetic(idle: false) }
    let old = params
    params = np
    inConfigure = true
    defer { inConfigure = false }
    let restart: Bool = {
      guard let old, source != nil, state != "error" else { return true }
      if !old.source.sameKind(np.source) || old.codec != np.codec { return true }
      if case .display(let a) = old.source, case .display(let b) = np.source, a != b { return true }
      if case .synthetic(let a) = old.source, case .synthetic(let b) = np.source, a != b { return true }
      return false
    }()
    if restart || old?.crop != np.crop || old?.source != np.source { regionSeq += 1 }
    region = Region(seq: regionSeq, crop: np.crop)
    if restart {
      teardown()
      if np.source.kind != "synthetic" && !screenRecordingGranted() {
        fail(screenRecordingSentence)
        return
      }
      state = "starting"
      let cb = SourceCallbacks(
        onGeometry: { [weak self] g in self?.geometryChanged(g) },
        onFrame: { [weak self] pb, pts in self?.frame(pb, pts) },
        onIdle: { [weak self] in self?.idle = true },
        onError: { [weak self] s in self?.fail(s) })
      let s: FrameSource =
        np.source.kind == "synthetic"
        ? SyntheticSource(queue: q, params: np, callbacks: cb)
        : ScreenSource(queue: q, params: np, callbacks: cb)
      source = s
      s.start()
      if state == "error" { return }  // fail() already said why
      holdActivity()
    } else {
      // A new region (crop, or another window) must start on a key OF THAT REGION: the phone
      // treats the next key after a crop change as the new picture. Forget the old frame so a
      // keyframe request cannot re-encode the previous region, and key the next captured one.
      if old?.crop != np.crop || old?.source != np.source {
        lastFrame = nil
        forceKey = true
      }
      source?.update(np)
      encoder?.update(np)
    }
    emitStatus()  // "running" (synthetic knows its size at once) or "starting" (SCK resolving)
  }

  private func holdActivity() {
    guard activity == nil else { return }
    // A background CLI gets App Nap timer coalescing: a 66 ms timer fired at ~180 ms.
    activity = ProcessInfo.processInfo.beginActivity(
      options: [.userInitiated, .latencyCritical, .idleSystemSleepDisabled], reason: "live desktop stream")
    log("activity: held")
  }

  private func releaseActivity() {
    guard let a = activity else { return }
    ProcessInfo.processInfo.endActivity(a)
    activity = nil
    log("activity: released")
  }

  private func teardown() {
    releaseActivity()
    source?.stop()
    source = nil
    encoder?.invalidate()
    encoder = nil
    geo = nil
    lastFrame = nil
    statsLock.lock()
    avc = nil
    statsLock.unlock()
  }

  private func stopAll(reason: String?) {
    teardown()
    state = "stopped"
    emitStatus(reason: reason)
  }

  private func fail(_ sentence: String) {
    teardown()
    state = "error"
    log("error: \(sentence)")
    emitStatus(reason: sentence)
  }

  private func requestKey() {
    guard let p = params, let enc = encoder else {
      forceKey = true
      return
    }
    // On a still screen no frame will come: re-encode the last one as an IDR now.
    let interval = UInt64(1_000_000 / p.fps)
    if let last = lastFrame, nowMicros() - lastFrameAt > 2 * interval {
      lastPts = max(nowMicros(), lastPts + 1)
      enc.encode(last, pts: lastPts, forceKey: true, region: region)
    } else {
      forceKey = true
    }
  }

  private func inject(_ ev: [String: Any]) {
    if !dryInput {
      let now = nowMicros()
      if now - axCache.at > 2_000_000 { axCache = (now, accessibilityTrusted()) }
      if !axCache.ok {
        if now - axToldAt > 10_000_000 {
          axToldAt = now
          emitStatus(reason: accessibilitySentence)
        }
        return
      }
    }
    var bounds = geo?.globalBounds ?? CGDisplayBounds(CGMainDisplayID())
    if bounds.width < 1 { bounds = CGRect(x: 0, y: 0, width: 1280, height: 800) }
    if let why = input.handle(ev, bounds: bounds) { log("input ignored: \(why)") }
  }

  // MARK: source callbacks (on q)

  private func geometryChanged(_ g: Geometry) {
    geo = g
    if state != "error" { state = "running" }
    if !inConfigure { emitStatus() }
  }

  private func frame(_ pb: CVPixelBuffer, _ ptsIn: UInt64) {
    guard let p = params else { return }
    idle = false
    statsLock.lock()
    captured += 1
    statsLock.unlock()
    let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
    if encoder == nil || encoder!.width != w || encoder!.height != h || encoder!.codec != p.codec {
      encoder?.invalidate()
      let sink: (EncodedFrame) -> Void = { [weak self] f in self?.encoded(f) }
      encoder =
        p.codec == .h264
        ? H264Encoder(width: w, height: h, params: p, sink: sink)
        : JpegEncoder(width: w, height: h, params: p, sink: sink)
      if encoder == nil {
        fail("The H.264 encoder could not start at \(w)×\(h). Try JPEG or a smaller size.")
        return
      }
      forceKey = true
    }
    guard let enc = encoder else { return }
    if enc.inFlight > 2 && !forceKey {
      statsLock.lock()
      dropped += 1
      statsLock.unlock()
      return
    }
    let pts = max(ptsIn, lastPts + 1)
    lastPts = pts
    lastFrame = pb
    lastFrameAt = nowMicros()
    let k = forceKey
    forceKey = false
    enc.encode(pb, pts: pts, forceKey: k, region: region)
  }

  /// Encoder output: H.264 on VideoToolbox's thread, JPEG on q.
  private func encoded(_ f: EncodedFrame) {
    var newAvc = false
    statsLock.lock()
    frames += 1
    bytes += f.data.count
    if f.key { keys += 1 }
    encSum += f.encodeMicros
    encMax = max(encMax, f.encodeMicros)
    if let a = f.avc, a != avc {
      avc = a
      newAvc = true
    }
    statsLock.unlock()
    // The region the frame was SUBMITTED for: Output announces it (a status) before its first frame.
    Output.shared.frame(f.kind, key: f.key, pts: f.pts, payload: f.data, region: f.region)
    if newAvc { q.async { self.emitStatus() } }
  }

  // MARK: status + stats

  private func emitStatus(reason: String? = nil) {
    let p = params
    var o: [String: Any] = [
      "t": "status", "state": state,
      "width": geo?.outWidth ?? 0, "height": geo?.outHeight ?? 0,
      "srcWidth": geo?.srcWidth ?? 0, "srcHeight": geo?.srcHeight ?? 0,
      "fps": p?.fps ?? 0, "codec": (p?.codec ?? .h264).rawValue,
      "bitrateKbps": p?.bitrateKbps ?? 0, "source": p?.source.kind ?? "none",
      "screenRecording": screenRecordingGranted(), "accessibility": accessibilityTrusted(),
      "responsibleSelf": { let r = responsibility(); return r.pid == r.responsible }(),
      "helperVersion": helperVersion,
    ]
    if let reason { o["reason"] = reason }
    statsLock.lock()
    if let avc, p?.codec == .h264 { o["avc"] = avc }
    statsLock.unlock()
    Output.shared.status(o)
    log("status \(state) \(o["width"]!)x\(o["height"]!) \(o["codec"]!) \(o["fps"]!)fps\(reason.map { " — " + $0 } ?? "")")
  }

  private func startTimers() {
    let t = DispatchSource.makeTimerSource(queue: q)
    t.schedule(deadline: .now() + 2, repeating: 2)
    t.setEventHandler { [weak self] in self?.reportStats() }
    t.resume()
    statsTimer = t
    // The host dying closes stdin, which is the main exit path. Being re-parented is the backstop.
    let w = DispatchSource.makeTimerSource(queue: .global())
    w.schedule(deadline: .now() + 1, repeating: 1)
    w.setEventHandler { [parentAtStart] in
      if getppid() != parentAtStart {
        log("parent went away, exiting")
        exit(0)
      }
    }
    w.resume()
    watchdog = w
  }

  private func reportStats() {
    let now = nowMicros()
    statsLock.lock()
    let span = Double(now - statsSince) / 1e6
    let s = (frames, keys, bytes, captured, dropped, encSum, encMax)
    frames = 0; keys = 0; bytes = 0; captured = 0; dropped = 0; encSum = 0; encMax = 0
    statsSince = now
    statsLock.unlock()
    guard state == "running", span > 0, s.0 > 0 || s.3 > 0 else { return }
    let fps = Double(s.0) / span, kbps = Double(s.2) * 8 / 1000 / span
    let encAvg = s.0 > 0 ? Double(s.5) / Double(s.0) / 1000 : 0, encMaxMs = Double(s.6) / 1000
    log(String(format: "stats fps=%.1f kbps=%.0f keys=%d enc=%.2fms max=%.2fms captured=%d dropped=%d", fps, kbps, s.1, encAvg, encMaxMs, s.3, s.4))
    Output.shared.json([
      "t": "stats", "fps": (fps * 10).rounded() / 10, "kbps": kbps.rounded(), "keys": s.1,
      "encodeMsAvg": (encAvg * 100).rounded() / 100, "encodeMsMax": (encMaxMs * 100).rounded() / 100,
      "captured": s.3, "dropped": s.4, "periodMs": Int(span * 1000), "idle": idle,
    ])
  }
}
