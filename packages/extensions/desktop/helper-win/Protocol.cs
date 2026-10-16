// Protocol: the process contract (helper/PROTOCOL.md, the same one the macOS helper keeps).
// stdin = JSON lines, stdout = length-prefixed binary records, stderr = human log lines.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace WpDesktop
{
    static class Log
    {
        static readonly object gate = new object();
        static readonly Stream err = Console.OpenStandardError();

        public static void Say(string s)
        {
            var b = Encoding.UTF8.GetBytes("wp-desktop: " + s + "\n");
            lock (gate) { try { err.Write(b, 0, b.Length); err.Flush(); } catch (Exception) { } }
        }
    }

    static class Clock
    {
        /// QueryPerformanceCounter in µs: strictly increasing within the process.
        public static ulong NowMicros()
        {
            return (ulong)(Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency * 1e6);
        }
    }

    static class Json
    {
        static JavaScriptSerializer Ser()
        {
            var s = new JavaScriptSerializer();
            s.MaxJsonLength = 4 << 20;
            return s;
        }

        public static Dictionary<string, object> Parse(string line)
        {
            try { return Ser().DeserializeObject(line) as Dictionary<string, object>; }
            catch (Exception) { return null; }
        }

        public static string Write(object o) { return Ser().Serialize(o); }

        public static Dictionary<string, object> Obj(object v) { return v as Dictionary<string, object>; }

        /// A JSON number (never a bool), else null.
        public static double? Num(object v)
        {
            if (v == null || v is bool || v is string) return null;
            try { return Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture); } catch (Exception) { return null; }
        }

        public static bool? Bool(object v) { if (v is bool) return (bool)v; return null; }

        public static string Str(object v) { return v as string; }

        public static List<string> Strings(object v)
        {
            var out_ = new List<string>();
            var e = v as IEnumerable;
            if (e == null || v is string) return out_;
            foreach (var x in e) { var s = x as string; if (s != null) out_.Add(s); }
            return out_;
        }

        public static object Get(Dictionary<string, object> o, string k)
        {
            object v;
            return o != null && o.TryGetValue(k, out v) ? v : null;
        }
    }

    /// Which region of the source a frame was encoded for (PROTOCOL.md, "Regions").
    sealed class Region
    {
        public readonly int Seq;
        public readonly Crop Crop;
        public Region(int seq, Crop crop) { Seq = seq; Crop = crop; }
    }

    /// stdout. One lock so records never interleave; it also owns the region the OUTPUT is in, so
    /// the first frame of a new region is preceded, in the same locked write, by a status naming it.
    /// A failed write means the reader is gone: exit.
    static class Output
    {
        public const byte H264 = 1, JPEG = 2, JSON = 4;
        static readonly object gate = new object();
        static readonly Stream stdout = Console.OpenStandardOutput();
        static Region announced;
        static Dictionary<string, object> lastStatus;

        public static void Frame(byte kind, bool key, ulong pts, byte[] payload, int len, Region region)
        {
            lock (gate)
            {
                if (announced == null || announced.Seq != region.Seq)
                {
                    announced = region;
                    var o = lastStatus != null ? new Dictionary<string, object>(lastStatus) : new Dictionary<string, object> { { "t", "status" }, { "state", "running" } };
                    Stamp(o);
                    PutJson(o);
                }
                Put(kind, key, pts, payload, len);
            }
        }

        public static void Status(Dictionary<string, object> o)
        {
            lock (gate)
            {
                lastStatus = o;
                var s = new Dictionary<string, object>(o);
                Stamp(s);
                PutJson(s);
            }
        }

        public static void Json_(Dictionary<string, object> o) { lock (gate) PutJson(o); }

        /// Forget the announced region: the next frame announces its own (a restarted source).
        public static void ForgetRegion() { lock (gate) announced = null; }

        static void Stamp(Dictionary<string, object> o)
        {
            if (announced == null) return;
            var c = announced.Crop;
            o["crop"] = new Dictionary<string, object> { { "x", c.X }, { "y", c.Y }, { "w", c.W }, { "h", c.H } };
            o["regionSeq"] = announced.Seq;
        }

        static void PutJson(Dictionary<string, object> o)
        {
            var b = Encoding.UTF8.GetBytes(Json.Write(o));
            Put(JSON, false, Clock.NowMicros(), b, b.Length);
        }

        static readonly byte[] hdr = new byte[14];

        static void Put(byte kind, bool key, ulong pts, byte[] payload, int len)
        {
            uint l = (uint)(10 + len);
            for (int i = 0; i < 4; i++) hdr[i] = (byte)(l >> (8 * i));
            hdr[4] = kind;
            hdr[5] = (byte)(key ? 1 : 0);
            for (int i = 0; i < 8; i++) hdr[6 + i] = (byte)(pts >> (8 * i));
            try
            {
                stdout.Write(hdr, 0, 14);
                if (len > 0) stdout.Write(payload, 0, len);
                stdout.Flush();
            }
            catch (Exception e)
            {
                Log.Say("stdout closed (" + e.Message + "), exiting");
                Environment.Exit(0);
            }
        }
    }

    /// One parsed stdin line.
    sealed class Command
    {
        public string T;
        public Dictionary<string, object> Obj;
        public int Kbps;
        public Dictionary<string, object> Ev;

        public static Command Parse(string line)
        {
            var s = line.Trim();
            if (s.Length == 0) return null;
            var o = Json.Parse(s);
            var t = Json.Str(Json.Get(o, "t"));
            if (o == null || t == null)
            {
                Log.Say("ignored a stdin line that is not a JSON object with \"t\": " + (s.Length > 120 ? s.Substring(0, 120) : s));
                return null;
            }
            var c = new Command { T = t, Obj = o };
            switch (t)
            {
                case "config": case "keyframe": case "stop": case "probe": return c;
                case "bitrate":
                    var k = Json.Num(Json.Get(o, "kbps"));
                    if (k == null) { Log.Say("ignored bitrate without a numeric kbps"); return null; }
                    c.Kbps = (int)k.Value;
                    return c;
                case "input":
                    c.Ev = Json.Obj(Json.Get(o, "ev"));
                    if (c.Ev == null) { Log.Say("ignored input without an ev object"); return null; }
                    return c;
                default:
                    Log.Say("ignored unknown command t=" + t);
                    return null;
            }
        }
    }
}
