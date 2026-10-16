// Synthetic: the test pattern (`--source synthetic`, or a `synthetic` source in a config). Never the
// screen. A 2560×1600 virtual desktop: an editor scrolling 3 lines a second on the left, a terminal
// whose glyphs change every frame on the right, and a square crossing it. `idle` stands still for
// 3 s of every 6 s, the way a still real screen sends nothing.

using System;
using System.Runtime.InteropServices;

namespace WpDesktop
{
    sealed class SyntheticSource : IFrameSource
    {
        public const int SrcW = 2560, SrcH = 1600;
        IntPtr buf;
        int w, h;
        long frame;
        readonly ulong t0 = Clock.NowMicros();

        public string Resolve(Params p, out Geometry g)
        {
            g = new Geometry { SrcWidth = SrcW, SrcHeight = SrcH, X = 0, Y = 0 };
            Params.OutputSize(SrcW, SrcH, p.Crop, p.MaxWidth, p.Codec, out g.OutWidth, out g.OutHeight);
            return null;
        }

        static uint Hash(long a, long b)
        {
            unchecked
            {
                uint x = (uint)(a * 73856093) ^ (uint)(b * 19349663);
                x ^= x >> 13; x *= 0x5bd1e995; x ^= x >> 15;
                return x;
            }
        }

        public unsafe bool Grab(Params p, Geometry g, bool force, out IntPtr bits, out string why)
        {
            why = null;
            if (buf == IntPtr.Zero || w != g.OutWidth || h != g.OutHeight)
            {
                if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
                w = g.OutWidth; h = g.OutHeight;
                buf = Marshal.AllocHGlobal(w * h * 4);
                force = true;
            }
            bits = buf;
            double secs = (Clock.NowMicros() - t0) / 1e6;
            if (p.Source.Idle && (secs % 6.0) >= 3.0 && !force) return false;
            frame++;
            double cx = p.Crop.X * SrcW, cy = p.Crop.Y * SrcH, sx = p.Crop.W * SrcW / w, sy = p.Crop.H * SrcH / h;
            int scroll = (int)(secs * 3 * 24);
            int sqX = (int)((secs * 400) % (SrcW - 200)), sqY = 600;
            uint* px = (uint*)buf.ToPointer();
            for (int oy = 0; oy < h; oy++)
            {
                int y = (int)(cy + oy * sy);
                uint* row = px + (long)oy * w;
                for (int ox = 0; ox < w; ox++)
                {
                    int x = (int)(cx + ox * sx);
                    uint c;
                    if (x >= sqX && x < sqX + 200 && y >= sqY && y < sqY + 200) c = 0xFFE0A030;
                    else if (y < 40) c = 0xFF3C3C3C; // a title bar
                    else if (x < SrcW * 7 / 10)
                    {
                        int line = (y + scroll) / 24, col = x / 12;
                        bool glyph = (y + scroll) % 24 > 6 && (y + scroll) % 24 < 20 && x % 12 < 9 && (Hash(line, col / 6) & 3) != 0 && col < 20 + (int)(Hash(line, 7) % 140);
                        c = glyph ? 0xFFD4D4D4 : 0xFF1E1E1E;
                    }
                    else
                    {
                        int line = y / 20, col = x / 10;
                        bool glyph = y % 20 > 4 && y % 20 < 17 && x % 10 < 8 && (Hash(frame + line, col) & 1) != 0;
                        c = glyph ? 0xFF6AD06A : 0xFF0C0C0C;
                    }
                    row[ox] = c;
                }
            }
            return true;
        }

        public void Dispose()
        {
            if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
            buf = IntPtr.Zero;
        }
    }
}
