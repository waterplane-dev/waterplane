// Server: the `serve` pipeline. One worker thread owns all state: it applies commands, and on the
// frame clock grabs, encodes (synchronously) and writes. The stdin reader is the only other
// thread, and it only queues commands.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;

namespace WpDesktop
{
    sealed class Server
    {
        readonly bool dryInput, forceSynthetic, noCapture;
        readonly InputInjector input;
        readonly BlockingCollection<Command> q = new BlockingCollection<Command>();
        Params p;
        IFrameSource source;
        IFrameEncoder encoder;
        Geometry geo;
        string state = "stopped";
        bool forceKey, idle, held;
        int regionSeq;
        Region region = new Region(0, new Crop());
        ulong nextFrameAt, lastKeyAt, grabToldAt;
        string avc;

        // stats
        int frames, keys, captured, dropped;
        long bytes;
        ulong encSum, encMax, statsSince = Clock.NowMicros(), nextStats = Clock.NowMicros() + 2000000;

        public Server(bool dryInput, bool forceSynthetic, bool noCapture)
        {
            this.dryInput = dryInput;
            this.forceSynthetic = forceSynthetic;
            this.noCapture = noCapture;
            input = new InputInjector(dryInput);
        }

        public void Run()
        {
            var t = new Thread(ReadStdin) { IsBackground = true, Name = "stdin" };
            t.Start();
            Log.Say("serve: ready (" + (dryInput ? "dry input, " : "") + (forceSynthetic ? "synthetic source" : "screen source") + ")");
            Loop();
        }

        void ReadStdin()
        {
            var r = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            while (true)
            {
                string line;
                try { line = r.ReadLine(); } catch (Exception) { line = null; }
                if (line == null) break;
                if (line.Length > 1 << 20) { Log.Say("ignored a stdin line longer than 1 MB"); continue; }
                var c = Command.Parse(line);
                if (c != null) q.Add(c);
            }
            Log.Say("stdin closed, exiting");
            // Never leave a capture running: stop on the worker, and exit regardless after 0.5 s.
            var killer = new Thread(() => { Thread.Sleep(500); Environment.Exit(0); }) { IsBackground = true };
            killer.Start();
            q.Add(new Command { T = "eof" });
        }

        void Loop()
        {
            while (true)
            {
                ulong now = Clock.NowMicros();
                int wait = 1000;
                if (Running) wait = nextFrameAt > now ? (int)Math.Min(1000, (nextFrameAt - now) / 1000) : 0;
                if (nextStats > now) wait = Math.Min(wait, (int)((nextStats - now) / 1000)); else wait = 0;
                Command c;
                if (q.TryTake(out c, wait))
                {
                    Safe(c);
                    while (q.TryTake(out c)) Safe(c);
                }
                now = Clock.NowMicros();
                if (Running && now >= nextFrameAt)
                {
                    ulong interval = (ulong)(1000000 / Math.Max(1, p.Fps));
                    nextFrameAt = nextFrameAt + interval > now ? nextFrameAt + interval : now + interval;
                    try { Tick(); }
                    catch (Exception e) { Fail("The desktop helper hit an error while capturing: " + e.Message); }
                }
                if (now >= nextStats) { nextStats = now + 2000000; ReportStats(); }
            }
        }

        /// One bad command is one stderr line, never a crash (PROTOCOL.md).
        void Safe(Command c)
        {
            try { Apply(c); }
            catch (Exception e) { Log.Say("command " + c.T + " failed: " + e.GetType().Name + ": " + e.Message); }
        }

        bool Running { get { return source != null && (state == "running" || state == "starting"); } }

        void Apply(Command c)
        {
            switch (c.T)
            {
                case "config": Configure(c.Obj); break;
                case "keyframe": forceKey = true; nextFrameAt = Clock.NowMicros(); break;
                case "bitrate":
                    if (p == null) return;
                    p.BitrateKbps = Params.ClampBitrate(c.Kbps);
                    if (encoder != null) encoder.SetBitrate(p.BitrateKbps);
                    EmitStatus(null);
                    break;
                case "input": Inject(c.Ev); break;
                case "stop": Teardown(); state = "stopped"; EmitStatus(null); break;
                case "probe": Output.Json_(Probe.Object()); break;
                case "eof": Teardown(); Environment.Exit(0); break;
            }
        }

        void Configure(Dictionary<string, object> o)
        {
            var np = Params.Parse(o);
            if (forceSynthetic && np.Source.Kind != "synthetic") np.Source = new SourceSpec { Kind = "synthetic" };
            var old = p;
            p = np;
            bool restart = old == null || source == null || state == "error"
                || old.Source.Kind != np.Source.Kind || old.Codec != np.Codec
                || (np.Source.Kind == "display" && old.Source.Id != np.Source.Id)
                || (np.Source.Kind == "synthetic" && old.Source.Idle != np.Source.Idle);
            bool newRegion = restart || !old.Crop.Same(np.Crop) || !old.Source.Same(np.Source);
            if (newRegion) regionSeq++;
            region = new Region(regionSeq, np.Crop);
            if (restart)
            {
                Teardown();
                if (np.Source.Kind != "synthetic")
                {
                    if (noCapture || Screens.SessionId() == 0) { Fail(Screens.NO_SESSION); return; }
                }
                source = np.Source.Kind == "synthetic" ? (IFrameSource)new SyntheticSource() : new ScreenSource();
                Geometry g;
                var why = source.Resolve(np, out g);
                if (why != null) { Fail(why); return; }
                geo = g;
                state = "running";
                Hold();
                forceKey = true;
                nextFrameAt = Clock.NowMicros();
            }
            else
            {
                if (newRegion) { forceKey = true; nextFrameAt = Clock.NowMicros(); }
                if (encoder != null) encoder.Update(np);
                Geometry g;
                if (source.Resolve(np, out g) == null) geo = g;
            }
            EmitStatus(null);
        }

        void Hold()
        {
            if (held) return;
            try { W32.SetThreadExecutionState(W32.ES_CONTINUOUS | W32.ES_SYSTEM_REQUIRED); } catch (Exception) { }
            held = true;
            Log.Say("activity: held");
        }

        void Release()
        {
            if (!held) return;
            try { W32.SetThreadExecutionState(W32.ES_CONTINUOUS); } catch (Exception) { }
            held = false;
            Log.Say("activity: released");
        }

        void Teardown()
        {
            Release();
            if (source != null) source.Dispose();
            source = null;
            if (encoder != null) encoder.Dispose();
            encoder = null;
            geo = null;
            avc = null;
        }

        void Fail(string sentence)
        {
            Teardown();
            state = "error";
            Log.Say("error: " + sentence);
            EmitStatus(sentence);
        }

        void Inject(Dictionary<string, object> ev)
        {
            var g = geo;
            if (g == null)
            {
                var ds = Screens.Displays();
                DisplayInfo main = null;
                foreach (var d in ds) if (d.Main) main = d;
                g = main != null
                    ? new Geometry { X = main.Rect.Left, Y = main.Rect.Top, SrcWidth = main.Rect.Right - main.Rect.Left, SrcHeight = main.Rect.Bottom - main.Rect.Top }
                    : new Geometry { SrcWidth = 1280, SrcHeight = 800 };
            }
            var why = input.Handle(ev, g);
            if (why != null) Log.Say("input ignored: " + why);
        }

        void Tick()
        {
            Geometry g;
            var why = source.Resolve(p, out g);
            if (why != null) { Fail(why); return; }
            if (!g.Same(geo)) { geo = g; EmitStatus(null); }
            if (encoder != null && (encoder.Width != g.OutWidth || encoder.Height != g.OutHeight || encoder.Codec != p.Codec))
            {
                encoder.Dispose();
                encoder = null;
            }
            if (encoder == null)
            {
                if (p.Codec == "h264")
                {
                    string err;
                    encoder = H264Encoder.Create(g.OutWidth, g.OutHeight, p, out err);
                    if (encoder == null) { Fail(err ?? ("The H.264 encoder could not start at " + g.OutWidth + "×" + g.OutHeight + ". Try JPEG or a smaller size.")); return; }
                }
                else encoder = new JpegEncoder(g.OutWidth, g.OutHeight, p);
                forceKey = true;
            }
            ulong now = Clock.NowMicros();
            bool key = forceKey || (p.KeyframeEverySec > 0 && now - lastKeyAt > (ulong)(p.KeyframeEverySec * 1e6));
            IntPtr bits;
            string grabWhy;
            bool changed = source.Grab(p, g, key, out bits, out grabWhy);
            if (grabWhy != null)
            {
                // The lock screen or a UAC prompt: transient. Say it at most every 10 s and keep trying.
                if (now - grabToldAt > 10000000) { grabToldAt = now; EmitStatus(grabWhy); }
                return;
            }
            if (!changed) { idle = true; return; }
            idle = false;
            captured++;
            forceKey = false;
            foreach (var f in encoder.Encode(bits, now, key, region)) Emit(f);
        }

        void Emit(EncodedFrame f)
        {
            frames++;
            bytes += f.Len;
            if (f.Key) { keys++; lastKeyAt = Clock.NowMicros(); }
            encSum += f.EncodeMicros;
            encMax = Math.Max(encMax, f.EncodeMicros);
            Output.Frame(f.Kind, f.Key, f.Pts, f.Data, f.Len, f.Region);
            if (f.Avc != null && f.Avc != avc) { avc = f.Avc; EmitStatus(null); }
        }

        void EmitStatus(string reason)
        {
            var o = new Dictionary<string, object> {
                { "t", "status" }, { "state", state },
                { "width", geo != null ? geo.OutWidth : 0 }, { "height", geo != null ? geo.OutHeight : 0 },
                { "srcWidth", geo != null ? geo.SrcWidth : 0 }, { "srcHeight", geo != null ? geo.SrcHeight : 0 },
                { "fps", p != null ? p.Fps : 0 }, { "codec", p != null ? p.Codec : "h264" },
                { "bitrateKbps", p != null ? p.BitrateKbps : 0 }, { "source", p != null ? p.Source.Kind : "none" },
                { "screenRecording", !noCapture && Screens.CanCapture() }, { "accessibility", true },
                { "responsibleSelf", true }, { "helperVersion", Program.Version },
            };
            if (reason != null) o["reason"] = reason;
            if (avc != null && p != null && p.Codec == "h264") o["avc"] = avc;
            Output.Status(o);
            Log.Say("status " + state + " " + o["width"] + "x" + o["height"] + " " + o["codec"] + " " + o["fps"] + "fps" + (reason != null ? " — " + reason : ""));
        }

        void ReportStats()
        {
            ulong now = Clock.NowMicros();
            double span = (now - statsSince) / 1e6;
            int f = frames, k = keys, c = captured, d = dropped;
            long b = bytes;
            ulong es = encSum, em = encMax;
            frames = keys = captured = dropped = 0; bytes = 0; encSum = encMax = 0;
            statsSince = now;
            if (state != "running" || span <= 0 || (f == 0 && c == 0)) return;
            double fps = f / span, kbps = b * 8 / 1000.0 / span;
            double encAvg = f > 0 ? es / (double)f / 1000 : 0, encMaxMs = em / 1000.0;
            Log.Say(string.Format(System.Globalization.CultureInfo.InvariantCulture,
                "stats fps={0:0.0} kbps={1:0} keys={2} enc={3:0.00}ms max={4:0.00}ms captured={5} dropped={6}", fps, kbps, k, encAvg, encMaxMs, c, d));
            Output.Json_(new Dictionary<string, object> {
                { "t", "stats" }, { "fps", Math.Round(fps, 1) }, { "kbps", Math.Round(kbps) }, { "keys", k },
                { "encodeMsAvg", Math.Round(encAvg, 2) }, { "encodeMsMax", Math.Round(encMaxMs, 2) },
                { "captured", c }, { "dropped", d }, { "periodMs", (int)(span * 1000) }, { "idle", idle },
            });
        }
    }
}
