// Responsibility: which process TCC charges for this helper's Screen Recording
// and Accessibility checks.
//
// macOS attributes a TCC request to the RESPONSIBLE process. A process launched
// by launchd is responsible for itself; a child spawned with plain fork/
// posix_spawn inherits its parent's. The host is node under a
// LaunchAgent (measured: every child of the live host reports node's pid as its
// responsible pid), so a plainly spawned wp-desktop would be judged as
// /opt/homebrew/bin/node: the grant would land on node (every node script gets
// it, and a Homebrew upgrade of node silently drops it).
//
// Fix, done here so the host needs nothing native:
//  1. If this process is not responsible for itself, re-exec the same binary in
//     place (POSIX_SPAWN_SETEXEC keeps pid, stdin, stdout, stderr) with
//     responsibility_spawnattrs_setdisclaim(attr, 1).
//  2. If the re-exec'd image is STILL not responsible for itself, fall back to
//     a disclaimed child: posix_spawn without SETEXEC, the child inherits the
//     same stdio fds, the parent forwards TERM/INT/HUP and exits with the
//     child's status. The child exits when its parent goes (Server watchdog).
// The SPI lives in libSystem (macOS 10.14+); Chromium, LLDB and Qt Creator use
// it for the same reason. It is looked up with dlsym, so a missing symbol
// degrades to "not disclaimed", reported as responsibleSelf:false.
//
// WP_DESKTOP_DISCLAIMED records the stage: "exec" after step 1, "child" in step 2.

import Darwin
import Foundation

private typealias GetResponsible = @convention(c) (pid_t) -> pid_t
private typealias SetDisclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32

private let libSystem = dlopen(nil, RTLD_NOW)

func responsibility() -> (pid: pid_t, responsible: pid_t) {
  let me = getpid()
  guard let sym = dlsym(libSystem, "responsibility_get_pid_responsible_for_pid") else { return (me, -1) }
  return (me, unsafeBitCast(sym, to: GetResponsible.self)(me))
}

func executablePath() -> String? {
  var size: UInt32 = 0
  _NSGetExecutablePath(nil, &size)
  var buf = [CChar](repeating: 0, count: Int(size) + 1)
  guard _NSGetExecutablePath(&buf, &size) == 0 else { return nil }
  var real = [CChar](repeating: 0, count: Int(PATH_MAX))
  guard realpath(buf, &real) != nil else { return String(cString: buf) }
  return String(cString: real)
}

/// Re-exec (or, failing that, spawn a child) with responsibility disclaimed when
/// needed. Returns only in the process that should go on running the command.
/// `force` / `forceChild` take a path even when already responsible (selftest).
func disclaimResponsibilityIfNeeded(force: Bool, forceChild: Bool) {
  let env = ProcessInfo.processInfo.environment
  if env["WP_DESKTOP_NO_DISCLAIM"] == "1" { return }
  let stage = env["WP_DESKTOP_DISCLAIMED"]
  if stage == "child" { return }
  let r = responsibility()
  let isSelf = r.responsible == r.pid
  if stage == "exec" {
    if isSelf && !forceChild { return }
    log("still judged for pid \(r.responsible) after re-exec; starting a disclaimed child instead")
    runDisclaimedChild()
    return
  }
  if forceChild {
    runDisclaimedChild()
    return
  }
  if isSelf && !force { return }
  var attr: posix_spawnattr_t?
  guard let path = executablePath(), disclaimAttr(&attr) else { return }
  defer { posix_spawnattr_destroy(&attr) }
  posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETEXEC))
  var pid: pid_t = 0
  let rc = spawn(&pid, path, &attr, stage: "exec")
  // Only reached on failure: SETEXEC replaces this image on success.
  log("re-exec with disclaimed responsibility failed (\(String(cString: strerror(rc)))); trying a child")
  runDisclaimedChild()
}

private func disclaimAttr(_ attr: inout posix_spawnattr_t?) -> Bool {
  guard let set = dlsym(libSystem, "responsibility_spawnattrs_setdisclaim") else {
    log("cannot disclaim responsibility on this system; permissions will be judged for pid \(responsibility().responsible)")
    return false
  }
  posix_spawnattr_init(&attr)
  guard unsafeBitCast(set, to: SetDisclaim.self)(&attr, 1) == 0 else {
    log("responsibility_spawnattrs_setdisclaim failed; permissions will be judged for pid \(responsibility().responsible)")
    return false
  }
  return true
}

private func spawn(_ pid: inout pid_t, _ path: String, _ attr: inout posix_spawnattr_t?, stage: String) -> Int32 {
  var argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) }
  argv[0] = strdup(path)
  argv.append(nil)
  var envp: [UnsafeMutablePointer<CChar>?] =
    ProcessInfo.processInfo.environment.filter { $0.key != "WP_DESKTOP_DISCLAIMED" }.map { strdup("\($0.key)=\($0.value)") }
  envp.append(strdup("WP_DESKTOP_DISCLAIMED=\(stage)"))
  envp.append(nil)
  return posix_spawn(&pid, path, nil, &attr, argv, envp)
}

/// Spawns the disclaimed child on the same stdio, then waits and mirrors its
/// exit. Returns only if the child could not be started (the caller then runs
/// the command itself, not disclaimed).
private func runDisclaimedChild() {
  var attr: posix_spawnattr_t?
  guard let path = executablePath(), disclaimAttr(&attr) else { return }
  defer { posix_spawnattr_destroy(&attr) }
  var pid: pid_t = 0
  let rc = spawn(&pid, path, &attr, stage: "child")
  guard rc == 0 else {
    log("disclaimed child failed to start (\(String(cString: strerror(rc)))); running undisclaimed")
    return
  }
  var sources = [DispatchSourceSignal]()
  for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig, SIG_IGN)
    let s = DispatchSource.makeSignalSource(signal: sig, queue: .global())
    s.setEventHandler { kill(pid, sig) }
    s.resume()
    sources.append(s)
  }
  // The child reads stdin and writes stdout; this process only waits.
  var st: Int32 = 0
  while waitpid(pid, &st, 0) < 0 && errno == EINTR {}
  _ = sources
  let sig = st & 0x7f
  exit(sig == 0 ? (st >> 8) & 0xff : 128 + sig)
}
