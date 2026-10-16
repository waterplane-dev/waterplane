// Params: the one parameter object a `config` carries, clamped here (PROTOCOL.md, "Params").
// A config is a FULL params object: a field left out takes its default, not its previous value.

using System;
using System.Collections.Generic;

namespace WpDesktop
{
    sealed class Crop
    {
        public double X, Y, W = 1, H = 1;
        public bool IsFull { get { return X == 0 && Y == 0 && W == 1 && H == 1; } }
        public bool Same(Crop o) { return o != null && X == o.X && Y == o.Y && W == o.W && H == o.H; }
    }

    /// display(id?) | window(id) | front | synthetic(idle)
    sealed class SourceSpec
    {
        public string Kind = "display";
        public long? Id;
        public bool Idle;
        public bool Same(SourceSpec o) { return o != null && Kind == o.Kind && Id == o.Id && Idle == o.Idle; }
    }

    sealed class Params
    {
        public string Codec = "h264";
        public SourceSpec Source = new SourceSpec();
        public Crop Crop = new Crop();
        public int MaxWidth = 1280;
        public int Fps = 15;
        public int BitrateKbps = 1000;
        public int JpegQuality = 50;
        public bool Grayscale;
        public double KeyframeEverySec;
        public bool Cursor = true;

        public static int ClampBitrate(int v) { return Math.Min(20000, Math.Max(50, v)); }

        public static Params Parse(Dictionary<string, object> o)
        {
            var p = new Params();
            Func<string, double?> num = k =>
            {
                var v = Json.Get(o, k);
                if (v == null) return null;
                var n = Json.Num(v);
                if (n == null) Log.Say("param " + k + ": expected a number, ignored");
                return n;
            };
            Func<string, bool?> boolean = k =>
            {
                var v = Json.Get(o, k);
                if (v == null) return null;
                var b = Json.Bool(v);
                if (b == null) Log.Say("param " + k + ": expected true/false, ignored");
                return b;
            };
            var codec = Json.Get(o, "codec");
            if (codec != null)
            {
                var s = Json.Str(codec);
                if (s == "h264" || s == "jpeg") p.Codec = s; else Log.Say("param codec: expected \"h264\" or \"jpeg\", ignored");
            }
            var src = Json.Get(o, "source");
            if (src != null)
            {
                var d = Json.Obj(src);
                var kind = Json.Str(Json.Get(d, "kind"));
                var id = Json.Num(Json.Get(d, "id"));
                if (kind == "display") p.Source = new SourceSpec { Kind = "display", Id = id.HasValue ? (long?)(long)id.Value : null };
                else if (kind == "window")
                {
                    if (id.HasValue) p.Source = new SourceSpec { Kind = "window", Id = (long)id.Value };
                    else Log.Say("param source: a window needs an id, using the main display");
                }
                else if (kind == "front") p.Source = new SourceSpec { Kind = "front" };
                else if (kind == "synthetic") p.Source = new SourceSpec { Kind = "synthetic", Idle = Json.Bool(Json.Get(d, "idle")) == true };
                else Log.Say("param source: expected {kind:…}, using the main display");
            }
            var crop = Json.Get(o, "crop");
            if (crop != null)
            {
                var d = Json.Obj(crop);
                if (d == null) Log.Say("param crop: expected {x,y,w,h}, ignored");
                else
                {
                    Func<string, double, double> f = (k, def) =>
                    {
                        var n = Json.Num(Json.Get(d, k));
                        return n.HasValue && !double.IsNaN(n.Value) && !double.IsInfinity(n.Value) ? n.Value : def;
                    };
                    double x = Math.Min(0.98, Math.Max(0, f("x", 0))), y = Math.Min(0.98, Math.Max(0, f("y", 0)));
                    double w = Math.Min(1, Math.Max(0.02, f("w", 1))), h = Math.Min(1, Math.Max(0.02, f("h", 1)));
                    if (x + w > 1) w = 1 - x;
                    if (y + h > 1) h = 1 - y;
                    if (w < 0.02) { x = 0.98; w = 0.02; }
                    if (h < 0.02) { y = 0.98; h = 0.02; }
                    p.Crop = new Crop { X = x, Y = y, W = w, H = h };
                }
            }
            double? nv;
            if ((nv = num("maxWidth")).HasValue) p.MaxWidth = nv.Value <= 0 ? 0 : Math.Min(8192, Math.Max(64, (int)nv.Value));
            if ((nv = num("fps")).HasValue) p.Fps = Math.Min(60, Math.Max(1, (int)Math.Round(nv.Value)));
            if ((nv = num("bitrateKbps")).HasValue) p.BitrateKbps = ClampBitrate((int)Math.Max(-1e9, Math.Min(1e9, nv.Value)));
            if ((nv = num("jpegQuality")).HasValue) p.JpegQuality = Math.Min(100, Math.Max(1, (int)nv.Value));
            bool? nb;
            if ((nb = boolean("grayscale")).HasValue) p.Grayscale = nb.Value;
            if ((nv = num("keyframeEverySec")).HasValue) p.KeyframeEverySec = nv.Value <= 0 ? 0 : Math.Min(3600, nv.Value);
            if ((nb = boolean("cursor")).HasValue) p.Cursor = nb.Value;
            return p;
        }

        /// Output size for a crop of a source: keep aspect, never upscale, even numbers.
        public static void OutputSize(int srcW, int srcH, Crop crop, int maxWidth, string codec, out int outW, out int outH)
        {
            double cw = Math.Max(2.0, srcW * crop.W), ch = Math.Max(2.0, srcH * crop.H);
            double w = maxWidth == 0 ? cw : Math.Min(cw, maxWidth);
            double h = w * ch / cw;
            // Level 5.1/5.2 H.264 stops at 4096 on either side.
            double cap = codec == "h264" ? 4096.0 : 8192.0;
            if (h > cap) { w = w * cap / h; h = cap; }
            if (w > cap) { h = h * cap / w; w = cap; }
            outW = Math.Max(16, (int)(w / 2) * 2);
            outH = Math.Max(16, (int)(h / 2) * 2);
        }
    }

    /// What one source looks like right now (PROTOCOL.md: full source, never the crop).
    sealed class Geometry
    {
        public int SrcWidth, SrcHeight;
        /// Full source bounds in virtual-desktop pixels (physical; the helper is per-monitor DPI aware).
        public int X, Y;
        public int OutWidth, OutHeight;
        public bool Same(Geometry o) { return o != null && SrcWidth == o.SrcWidth && SrcHeight == o.SrcHeight && X == o.X && Y == o.Y && OutWidth == o.OutWidth && OutHeight == o.OutHeight; }
    }
}
