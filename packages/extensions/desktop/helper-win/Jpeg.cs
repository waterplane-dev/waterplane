// Jpeg: one baseline JFIF per frame through GDI+ (System.Drawing). Every record is a key.
// Grayscale is three equal channels (GDI+ writes no one-component JPEG); the chroma then costs
// next to nothing, which is most of the saving the Mac's one-component file gets.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

namespace WpDesktop
{
    sealed class JpegEncoder : IFrameEncoder
    {
        readonly int w, h;
        int quality;
        bool gray;
        readonly ImageCodecInfo codec;
        IntPtr grayBuf;
        readonly MemoryStream ms = new MemoryStream();

        public int Width { get { return w; } }
        public int Height { get { return h; } }
        public string Codec { get { return "jpeg"; } }

        public JpegEncoder(int w, int h, Params p)
        {
            this.w = w; this.h = h;
            foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") codec = c;
            Update(p);
        }

        public void SetBitrate(int kbps) { }

        public void Update(Params p) { quality = p.JpegQuality; gray = p.Grayscale; }

        public List<EncodedFrame> Encode(IntPtr bgra, ulong pts, bool forceKey, Region region)
        {
            var list = new List<EncodedFrame>();
            ulong t0 = Clock.NowMicros();
            IntPtr src = bgra;
            if (gray) { ToGray(bgra); src = grayBuf; }
            ms.SetLength(0);
            using (var bmp = new Bitmap(w, h, w * 4, PixelFormat.Format32bppRgb, src))
            using (var ep = new EncoderParameters(1))
            {
                ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                bmp.Save(ms, codec, ep);
            }
            var data = ms.ToArray();
            list.Add(new EncodedFrame { Kind = Output.JPEG, Data = data, Len = data.Length, Key = true, Pts = pts, Region = region, EncodeMicros = Clock.NowMicros() - t0 });
            return list;
        }

        unsafe void ToGray(IntPtr bgra)
        {
            if (grayBuf == IntPtr.Zero) grayBuf = Marshal.AllocHGlobal(w * h * 4);
            byte* s = (byte*)bgra.ToPointer();
            byte* d = (byte*)grayBuf.ToPointer();
            long n = (long)w * h;
            for (long i = 0; i < n; i++, s += 4, d += 4)
            {
                byte v = (byte)((29 * s[0] + 150 * s[1] + 77 * s[2]) >> 8);
                d[0] = v; d[1] = v; d[2] = v; d[3] = 255;
            }
        }

        public void Dispose()
        {
            if (grayBuf != IntPtr.Zero) Marshal.FreeHGlobal(grayBuf);
            grayBuf = IntPtr.Zero;
        }
    }
}
