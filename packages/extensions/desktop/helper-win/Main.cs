// wp-desktop.exe: the live desktop helper for Windows. The same process contract as the macOS
// helper (helper/PROTOCOL.md); what differs on Windows is in that file's "Windows" section.
// Spawned by the host running in WSL, through WSL's interop, so it runs as the signed-in user
// in their desktop session.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;

namespace WpDesktop
{
    static class Probe
    {
        public static string OsString()
        {
            var v = Environment.OSVersion.Version;
            return "Windows " + v.Major + "." + v.Minor + "." + v.Build;
        }

        public static Dictionary<string, object> Object() { return Object(false); }

        public static Dictionary<string, object> Object(bool noCapture)
        {
            int pid = Process.GetCurrentProcess().Id;
            var displays = new List<object>();
            foreach (var d in Screens.Displays()) displays.Add(d.ToJson());
            return new Dictionary<string, object> {
                { "t", "probe" },
                // Windows has no per-app grant for either: the question is whether this process can
                // see the signed-in desktop at all (not session 0, not the secure desktop).
                { "screenRecording", !noCapture && Screens.CanCapture() },
                { "accessibility", true },
                { "session", Screens.SessionId() },
                { "displays", displays },
                { "os", OsString() },
                { "helperVersion", Program.Version },
                { "pid", pid }, { "responsiblePid", pid }, { "responsibleSelf", true },
            };
        }
    }

    static class Program
    {
        public const string Version = "0.1.0";

        static void Print(object o)
        {
            var b = Encoding.UTF8.GetBytes(Json.Write(o) + "\n");
            var s = Console.OpenStandardOutput();
            s.Write(b, 0, b.Length);
            s.Flush();
        }

        static int Main(string[] args)
        {
            W32.DpiAware();
            AppDomain.CurrentDomain.UnhandledException += (s, e) =>
            {
                Log.Say("crashed: " + e.ExceptionObject);
                Environment.Exit(70);
            };
            var flags = new HashSet<string>(args);
            string cmd = args.Length > 0 ? args[0] : "";
            bool noCapture = flags.Contains("--no-capture");
            switch (cmd)
            {
                case "version":
                    Console.Out.Write(Version + "\n");
                    return 0;
                case "probe":
                    var o = Probe.Object(noCapture);
                    o.Remove("t");
                    Print(o);
                    return 0;
                case "windows":
                    Print(new Dictionary<string, object> { { "windows", Screens.Windows() } });
                    return 0;
                case "whoami":
                    {
                        int pid = Process.GetCurrentProcess().Id;
                        Print(new Dictionary<string, object> {
                            { "pid", pid }, { "ppid", 0 }, { "responsiblePid", pid }, { "responsibleSelf", true }, { "disclaimed", "" },
                            { "path", Process.GetCurrentProcess().MainModule.FileName }, { "session", Screens.SessionId() },
                        });
                        return 0;
                    }
                case "request":
                    {
                        // Nothing to ask on Windows: no app needs a grant to read the screen or post input.
                        // Kept so the host's one code path answers the same shape.
                        string kind = args.Length > 1 && !args[1].StartsWith("--") ? args[1] : null;
                        if (kind != null && kind != "screen" && kind != "accessibility")
                        {
                            Log.Say("request: unknown kind " + kind + " (screen or accessibility)");
                            return 2;
                        }
                        bool screen = !noCapture && Screens.CanCapture();
                        var r = new Dictionary<string, object> { { "dry", flags.Contains("--dry-request") }, { "responsibleSelf", true }, { "accessibility", true } };
                        if (kind == null || kind == "screen") r["screen"] = new Dictionary<string, object> { { "already", screen }, { "asked", false }, { "granted", screen } };
                        if (kind == null || kind == "accessibility") r["accessibility"] = new Dictionary<string, object> { { "already", true }, { "asked", false }, { "granted", true } };
                        Print(r);
                        return 0;
                    }
                case "serve":
                    {
                        bool synthetic = false;
                        for (int i = 1; i + 1 < args.Length; i++) if (args[i] == "--source" && args[i + 1] == "synthetic") synthetic = true;
                        new Server(flags.Contains("--dry-input"), synthetic, noCapture).Run();
                        return 0;
                    }
                default:
                    Log.Say("usage: wp-desktop.exe serve|probe|windows|whoami|request [screen|accessibility]|version");
                    return 2;
            }
        }
    }
}
