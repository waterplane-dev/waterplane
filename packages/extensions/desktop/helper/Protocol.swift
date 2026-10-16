// Protocol: the process contract (PROTOCOL.md). stdin = JSON lines, stdout =
// length-prefixed binary records, stderr = human log lines.

import Foundation

let helperVersion = "0.1.0"

enum RecordKind: UInt8 {
  case h264 = 1
  case jpeg = 2
  case json = 4
}

enum RecordFlag {
  static let key: UInt8 = 1
}

/// CLOCK_UPTIME_RAW in µs: the clock of mach_absolute_time, of CoreMedia's host
/// time clock (so SCK's sample times), and of node's process.hrtime on macOS.
@inline(__always) func nowMicros() -> UInt64 { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1000 }

private let logLock = NSLock()
func log(_ s: String) {
  let line = "wp-desktop: \(s)\n"
  logLock.lock()
  defer { logLock.unlock() }
  line.withCString { p in _ = Darwin.write(2, p, strlen(p)) }
}

/// Which region of the source a frame was encoded for. `seq` grows by one on every config that
/// changes the crop or the source, and on every source restart; frames carry the region that was
/// current when they were SUBMITTED, so the VideoToolbox thread's late output still says which
/// config produced it.
struct Region: Equatable {
  let seq: Int
  let crop: Crop
}

/// stdout. One lock so records from the encoder thread and the control queue
/// never interleave. A failed write means the reader is gone: exit.
///
/// The lock also owns the region the OUTPUT is in (`announced`): a video record whose region is not
/// the announced one is preceded, under the same lock, by a status record naming the new region, and
/// every status written carries the announced region. So on this one ordered stream a status naming
/// region N is followed by that region's frames and by no earlier region's (PROTOCOL.md, "Regions").
final class Output {
  static let shared = Output()
  private let lock = NSLock()
  private(set) var bytesOut: UInt64 = 0
  private var announced: Region?
  private var lastStatus: [String: Any]?

  /// A non-video record that carries no region.
  func record(_ kind: RecordKind, key: Bool, pts: UInt64, payload: Data) {
    lock.lock()
    defer { lock.unlock() }
    put(kind, key: key, pts: pts, payload: payload)
  }

  /// A video record of `region`. The first of a new region announces it with a status record first.
  func frame(_ kind: RecordKind, key: Bool, pts: UInt64, payload: Data, region: Region) {
    lock.lock()
    defer { lock.unlock() }
    if announced?.seq != region.seq {
      announced = region
      var o = lastStatus ?? ["t": "status", "state": "running"]
      stamp(&o)
      putJSON(o)
    }
    put(kind, key: key, pts: pts, payload: payload)
  }

  /// A status record: remembered (the announcing status is a copy of the newest one) and stamped
  /// with the region the output is in right now, which is not necessarily the newest config's.
  func status(_ obj: [String: Any]) {
    lock.lock()
    defer { lock.unlock() }
    lastStatus = obj
    var o = obj
    stamp(&o)
    putJSON(o)
  }

  func json(_ obj: [String: Any]) {
    lock.lock()
    defer { lock.unlock() }
    putJSON(obj)
  }

  private func stamp(_ o: inout [String: Any]) {
    guard let r = announced else { return }
    o["crop"] = ["x": r.crop.x, "y": r.crop.y, "w": r.crop.w, "h": r.crop.h]
    o["regionSeq"] = r.seq
  }

  private func putJSON(_ obj: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(obj),
      let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    else {
      log("internal: status object is not JSON-serialisable")
      return
    }
    put(.json, key: false, pts: nowMicros(), payload: d)
  }

  /// Caller holds the lock.
  private func put(_ kind: RecordKind, key: Bool, pts: UInt64, payload: Data) {
    var hdr = [UInt8](repeating: 0, count: 14)
    let len = UInt32(10 + payload.count)
    for i in 0..<4 { hdr[i] = UInt8(truncatingIfNeeded: len >> (8 * UInt32(i))) }
    hdr[4] = kind.rawValue
    hdr[5] = key ? RecordFlag.key : 0
    for i in 0..<8 { hdr[6 + i] = UInt8(truncatingIfNeeded: pts >> (8 * UInt64(i))) }
    hdr.withUnsafeBytes { writeAll($0.baseAddress!, $0.count) }
    payload.withUnsafeBytes { if $0.count > 0 { writeAll($0.baseAddress!, $0.count) } }
    bytesOut += UInt64(14 + payload.count)
  }

  private func writeAll(_ p: UnsafeRawPointer, _ n: Int) {
    var off = 0
    while off < n {
      let r = Darwin.write(1, p + off, n - off)
      if r > 0 { off += r; continue }
      if r < 0 && errno == EINTR { continue }
      // EPIPE (SIGPIPE is ignored) or anything else: nobody is reading.
      log("stdout closed (\(String(cString: strerror(errno)))), exiting")
      exit(0)
    }
  }
}

enum Command {
  case config([String: Any])
  case keyframe
  case bitrate(Int)
  case input([String: Any])
  case stop
  case probe
}

func parseCommand(_ line: Substring) -> Command? {
  let trimmed = line.trimmingCharacters(in: .whitespaces)
  if trimmed.isEmpty { return nil }
  guard let obj = try? JSONSerialization.jsonObject(with: Data(trimmed.utf8)) as? [String: Any],
    let t = obj["t"] as? String
  else {
    log("ignored a stdin line that is not a JSON object with \"t\": \(trimmed.prefix(120))")
    return nil
  }
  switch t {
  case "config": return .config(obj)
  case "keyframe": return .keyframe
  case "bitrate":
    guard let k = (obj["kbps"] as? NSNumber)?.intValue else {
      log("ignored bitrate without a numeric kbps")
      return nil
    }
    return .bitrate(k)
  case "input":
    guard let ev = obj["ev"] as? [String: Any] else {
      log("ignored input without an ev object")
      return nil
    }
    return .input(ev)
  case "stop": return .stop
  case "probe": return .probe
  default:
    log("ignored unknown command t=\(t)")
    return nil
  }
}

/// Reads stdin on its own thread; EOF ⇒ `onEOF`. A line longer than 1 MB is
/// dropped whole (an input text chunk is never that long).
final class StdinReader {
  private let onCommand: (Command) -> Void
  private let onEOF: () -> Void

  init(onCommand: @escaping (Command) -> Void, onEOF: @escaping () -> Void) {
    self.onCommand = onCommand
    self.onEOF = onEOF
  }

  func start() {
    let t = Thread { [self] in self.loop() }
    t.name = "stdin"
    t.start()
  }

  private func loop() {
    var buf = [UInt8]()
    var chunk = [UInt8](repeating: 0, count: 64 * 1024)
    var discarding = false
    while true {
      let n = chunk.withUnsafeMutableBytes { Darwin.read(0, $0.baseAddress!, $0.count) }
      if n < 0 && errno == EINTR { continue }
      if n <= 0 { break }
      var start = 0
      for i in 0..<n where chunk[i] == 0x0A {
        if !discarding {
          buf.append(contentsOf: chunk[start..<i])
          if let s = String(bytes: buf, encoding: .utf8), let c = parseCommand(Substring(s)) { onCommand(c) }
        }
        buf.removeAll(keepingCapacity: true)
        discarding = false
        start = i + 1
      }
      if start < n && !discarding {
        buf.append(contentsOf: chunk[start..<n])
        if buf.count > 1 << 20 {
          log("ignored a stdin line longer than 1 MB")
          buf.removeAll()
          discarding = true
        }
      }
    }
    onEOF()
  }
}

func jsonLine(_ obj: [String: Any]) -> String {
  guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return "{}" }
  return String(decoding: d, as: UTF8.self)
}
