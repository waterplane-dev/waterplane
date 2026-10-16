// wp-desktop: capture, encode and inject for the live desktop view.
// The contract with the host is PROTOCOL.md; keep the two in step.

import Foundation

signal(SIGPIPE, SIG_IGN)

let argv = Array(CommandLine.arguments.dropFirst())
let cmd = argv.first ?? "help"
let flags = Set(argv.dropFirst())

func flagValue(_ name: String) -> String? {
  guard let i = argv.firstIndex(of: name), i + 1 < argv.count else { return nil }
  return argv[i + 1]
}

if flags.contains("--no-capture") { captureForbidden = true }

func disclaim() {
  if flags.contains("--no-disclaim") { return }
  disclaimResponsibilityIfNeeded(
    force: flags.contains("--force-disclaim"), forceChild: flags.contains("--force-disclaim-child"))
}

let usage = """
  usage: wp-desktop <command> [flags]
    serve      run the stream: JSON commands on stdin, binary records on stdout (PROTOCOL.md)
    probe      one JSON line: permissions, displays, OS, helper version
    windows    one JSON line: on-screen windows (id, owner, bounds; titles only where granted)
    whoami     one JSON line: pid and the responsible pid TCC judges
    request [screen|accessibility]  ASK macOS for the grant (shows its dialog on the desktop's
               screen), then one JSON line. The only command that can raise a dialog;
               --dry-request reads the state and asks nothing
    version    the helper version
  flags (serve):
    --source synthetic   test pattern instead of the screen; no capture API is touched
    --dry-input          log the CGEvents input would post instead of posting them
    --no-capture         behave as if Screen Recording were not granted
    --no-disclaim        keep the parent as the responsible process (see Responsibility.swift)
    --force-disclaim[-child]  take the re-exec (or child) path even when not needed (selftest)

  """

switch cmd {
case "serve":
  disclaim()
  let synthetic = flagValue("--source") == "synthetic"
  let server = Server(dryInput: flags.contains("--dry-input"), forceSynthetic: synthetic)
  // The App Nap / idle-sleep activity is the Server's, held only while a source runs.
  server.run()
  dispatchMain()
case "probe":
  disclaim()
  print(jsonLine(probeObject().filter { $0.key != "t" }))
case "windows":
  print(jsonLine(["windows": windowList()]))
case "whoami":
  disclaim()
  let r = responsibility()
  print(jsonLine([
    "pid": Int(r.pid), "ppid": Int(getppid()), "responsiblePid": Int(r.responsible),
    "responsibleSelf": r.pid == r.responsible,
    "disclaimed": ProcessInfo.processInfo.environment["WP_DESKTOP_DISCLAIMED"] ?? "",
    "path": executablePath() ?? "",
  ]))
case "request":
  disclaim()
  let what = argv.count > 1 && !argv[1].hasPrefix("-") ? argv[1] : nil
  guard let obj = requestObject(what, dry: flags.contains("--dry-request")) else {
    FileHandle.standardError.write(Data("wp-desktop: request takes screen or accessibility\n".utf8))
    exit(2)
  }
  print(jsonLine(obj))
case "version", "--version":
  print(helperVersion)
default:
  FileHandle.standardError.write(Data(usage.utf8))
  exit(cmd == "help" || cmd == "--help" ? 0 : 2)
}
