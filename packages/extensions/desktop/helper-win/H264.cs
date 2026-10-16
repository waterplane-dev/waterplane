// H264: Media Foundation's H.264 encoder MFT (the software one every Windows 8+ carries,
// CLSID_MSH264EncoderMFT), driven synchronously: BGRA → NV12 here, ProcessInput, drain
// ProcessOutput. Main profile, low-latency mode, no B-frames; output is Annex-B. A key record
// begins with SPS and PPS (the sequence header is prepended when the encoder left it out).
//
// A size change is a new encoder: its first record is a key with the new SPS (PROTOCOL.md).

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace WpDesktop
{
    sealed class EncodedFrame
    {
        public byte Kind;
        public byte[] Data;
        public int Len;
        public bool Key;
        public ulong Pts;
        public Region Region;
        public ulong EncodeMicros;
        public string Avc;
    }

    interface IFrameEncoder : IDisposable
    {
        int Width { get; }
        int Height { get; }
        string Codec { get; }
        /// Every record the encoder produced for this input (H.264 may lag by one).
        List<EncodedFrame> Encode(IntPtr bgra, ulong pts, bool forceKey, Region region);
        void SetBitrate(int kbps);
        void Update(Params p);
    }

    sealed class H264Encoder : IFrameEncoder
    {
        readonly int w, h;
        int fps;
        IMFTransform mft;
        ICodecAPI api;
        IMFSample inSample, outSample;
        IMFMediaBuffer inBuf, outBuf;
        int outCap;
        byte[] seqHeader;
        string avc;
        bool started;
        long firstPts = -1;
        readonly Queue<KeyValuePair<ulong, Region>> pending = new Queue<KeyValuePair<ulong, Region>>();
        readonly Queue<ulong> submittedAt = new Queue<ulong>();

        public int Width { get { return w; } }
        public int Height { get { return h; } }
        public string Codec { get { return "h264"; } }

        H264Encoder(int w, int h) { this.w = w; this.h = h; }

        public static H264Encoder Create(int w, int h, Params p, out string why)
        {
            why = null;
            var e = new H264Encoder(w, h);
            try
            {
                why = e.Open(p);
                if (why == null) return e;
            }
            catch (Exception ex) { why = "The H.264 encoder could not start at " + w + "×" + h + ": " + ex.Message; }
            e.Dispose();
            return null;
        }

        void Set(Guid g, object v)
        {
            if (api == null) return;
            int hr = api.SetValue(ref g, ref v);
            if (hr < 0) Log.Say("h264: codec setting " + g + " refused (0x" + hr.ToString("x8") + ")");
        }

        string Open(Params p)
        {
            if (!MF.Start()) return "Media Foundation is not available on this Windows (an N edition without the Media Feature Pack?). Try Stills (JPEG).";
            fps = p.Fps;
            var t = Type.GetTypeFromCLSID(MF.CLSID_H264Encoder);
            mft = (IMFTransform)Activator.CreateInstance(t);
            api = mft as ICodecAPI;
            // Rate control and latency are fixed before the media types are set.
            Set(MF.AVEncCommonRateControlMode, (uint)2); // peak-constrained VBR
            Set(MF.AVEncCommonMeanBitRate, (uint)(p.BitrateKbps * 1000));
            Set(MF.AVEncCommonMaxBitRate, (uint)(p.BitrateKbps * 1500));
            Set(MF.AVLowLatencyMode, true);
            Set(MF.AVEncMPVDefaultBPictureCount, (uint)0);
            Set(MF.AVEncMPVGOPSize, (uint)Math.Min(65535, Math.Max(1, p.Fps) * 600));
            Set(MF.AVEncCommonQualityVsSpeed, (uint)33);

            int hr = 0;
            foreach (int profile in new[] { 77 /* Main */, 66 /* Baseline */ })
            {
                IMFMediaType ot;
                MF.MFCreateMediaType(out ot);
                ot.SetGUID(ref MF.MT_MAJOR_TYPE, ref MF.MediaType_Video);
                ot.SetGUID(ref MF.MT_SUBTYPE, ref MF.VideoFormat_H264);
                ot.SetUINT32(ref MF.MT_AVG_BITRATE, p.BitrateKbps * 1000);
                ot.SetUINT32(ref MF.MT_INTERLACE_MODE, 2); // progressive
                ot.SetUINT64(ref MF.MT_FRAME_SIZE, ((long)w << 32) | (uint)h);
                ot.SetUINT64(ref MF.MT_FRAME_RATE, ((long)Math.Max(1, p.Fps) << 32) | 1);
                ot.SetUINT64(ref MF.MT_PIXEL_ASPECT_RATIO, (1L << 32) | 1);
                ot.SetUINT32(ref MF.MT_MPEG2_PROFILE, profile);
                hr = mft.SetOutputType(0, ot, 0);
                Marshal.ReleaseComObject(ot);
                if (hr >= 0) break;
            }
            if (hr < 0) return "The H.264 encoder refused " + w + "×" + h + " (0x" + hr.ToString("x8") + "). Try a smaller size, or Stills (JPEG).";

            IMFMediaType it;
            MF.MFCreateMediaType(out it);
            it.SetGUID(ref MF.MT_MAJOR_TYPE, ref MF.MediaType_Video);
            it.SetGUID(ref MF.MT_SUBTYPE, ref MF.VideoFormat_NV12);
            it.SetUINT32(ref MF.MT_INTERLACE_MODE, 2);
            it.SetUINT64(ref MF.MT_FRAME_SIZE, ((long)w << 32) | (uint)h);
            it.SetUINT64(ref MF.MT_FRAME_RATE, ((long)Math.Max(1, p.Fps) << 32) | 1);
            it.SetUINT64(ref MF.MT_PIXEL_ASPECT_RATIO, (1L << 32) | 1);
            hr = mft.SetInputType(0, it, 0);
            Marshal.ReleaseComObject(it);
            if (hr < 0) return "The H.264 encoder refused NV12 input at " + w + "×" + h + " (0x" + hr.ToString("x8") + "). Try Stills (JPEG).";

            ReadSequenceHeader();
            mft.ProcessMessage(MF.MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, IntPtr.Zero);
            mft.ProcessMessage(MF.MFT_MESSAGE_NOTIFY_START_OF_STREAM, IntPtr.Zero);
            started = true;

            int size = w * h * 3 / 2;
            MF.MFCreateSample(out inSample);
            MF.MFCreateMemoryBuffer(size, out inBuf);
            inSample.AddBuffer(inBuf);
            return null;
        }

        void ReadSequenceHeader()
        {
            IMFMediaType ct;
            if (mft.GetOutputCurrentType(0, out ct) < 0 || ct == null) return;
            int n;
            if (ct.GetBlobSize(ref MF.MT_MPEG_SEQUENCE_HEADER, out n) >= 0 && n > 0)
            {
                var b = new byte[n];
                int got;
                if (ct.GetBlob(ref MF.MT_MPEG_SEQUENCE_HEADER, b, n, out got) >= 0) { seqHeader = b; NoteAvc(b, got); }
            }
            Marshal.ReleaseComObject(ct);
        }

        public void SetBitrate(int kbps)
        {
            Set(MF.AVEncCommonMeanBitRate, (uint)(kbps * 1000));
            Set(MF.AVEncCommonMaxBitRate, (uint)(kbps * 1500));
        }

        public void Update(Params p) { fps = p.Fps; SetBitrate(p.BitrateKbps); }

        public List<EncodedFrame> Encode(IntPtr bgra, ulong pts, bool forceKey, Region region)
        {
            var outList = new List<EncodedFrame>();
            IntPtr dst; int max, cur;
            if (inBuf.Lock(out dst, out max, out cur) < 0) return outList;
            Yuv.BgraToNv12(bgra, dst, w, h);
            inBuf.Unlock();
            inBuf.SetCurrentLength(w * h * 3 / 2);
            if (firstPts < 0) firstPts = (long)pts;
            inSample.SetSampleTime(((long)pts - firstPts) * 10);
            inSample.SetSampleDuration(10000000L / Math.Max(1, fps));
            if (forceKey) Set(MF.AVEncVideoForceKeyFrame, (uint)1);
            int hr = mft.ProcessInput(0, inSample, 0);
            if (hr == MF.E_NOTACCEPTING) { Drain(outList); hr = mft.ProcessInput(0, inSample, 0); }
            if (hr < 0) { Log.Say("h264: ProcessInput failed (0x" + hr.ToString("x8") + ")"); return outList; }
            pending.Enqueue(new KeyValuePair<ulong, Region>(pts, region));
            submittedAt.Enqueue(Clock.NowMicros());
            Drain(outList);
            return outList;
        }

        void Drain(List<EncodedFrame> outList)
        {
            for (int guard = 0; guard < 8; guard++)
            {
                MFT_OUTPUT_STREAM_INFO info;
                mft.GetOutputStreamInfo(0, out info);
                bool provides = (info.dwFlags & MF.MFT_OUTPUT_STREAM_PROVIDES_SAMPLES) != 0;
                IntPtr ps = IntPtr.Zero;
                if (!provides)
                {
                    int need = Math.Max(info.cbSize, w * h * 3 / 2 + 65536);
                    if (outSample == null || outCap < need)
                    {
                        if (outSample != null) { Marshal.ReleaseComObject(outSample); Marshal.ReleaseComObject(outBuf); }
                        MF.MFCreateSample(out outSample);
                        MF.MFCreateMemoryBuffer(need, out outBuf);
                        outSample.AddBuffer(outBuf);
                        outCap = need;
                    }
                    outBuf.SetCurrentLength(0);
                    ps = Marshal.GetComInterfaceForObject(outSample, typeof(IMFSample));
                }
                var arr = new MFT_OUTPUT_DATA_BUFFER[1];
                arr[0].pSample = ps;
                int status;
                int hr = mft.ProcessOutput(0, 1, arr, out status);
                if (arr[0].pEvents != IntPtr.Zero) Marshal.Release(arr[0].pEvents);
                IMFSample got = null;
                if (provides && arr[0].pSample != IntPtr.Zero)
                {
                    got = (IMFSample)Marshal.GetObjectForIUnknown(arr[0].pSample);
                    Marshal.Release(arr[0].pSample);
                }
                else if (!provides) got = outSample;
                if (ps != IntPtr.Zero) Marshal.Release(ps);
                if (hr == MF.E_NEED_MORE_INPUT) return;
                if (hr == MF.E_STREAM_CHANGE)
                {
                    IMFMediaType t;
                    if (mft.GetOutputAvailableType(0, 0, out t) >= 0) { mft.SetOutputType(0, t, 0); Marshal.ReleaseComObject(t); }
                    ReadSequenceHeader();
                    continue;
                }
                if (hr < 0) { Log.Say("h264: ProcessOutput failed (0x" + hr.ToString("x8") + ")"); return; }
                if (got == null) continue;
                var f = Take(got);
                if (provides) Marshal.ReleaseComObject(got);
                if (f != null) outList.Add(f);
            }
        }

        EncodedFrame Take(IMFSample s)
        {
            IMFMediaBuffer b;
            if (s.ConvertToContiguousBuffer(out b) < 0 || b == null) return null;
            IntPtr p; int max, cur;
            if (b.Lock(out p, out max, out cur) < 0) { if (b != outBuf) Marshal.ReleaseComObject(b); return null; }
            var data = new byte[cur];
            Marshal.Copy(p, data, 0, cur);
            b.Unlock();
            if (b != outBuf) Marshal.ReleaseComObject(b);
            if (cur == 0) return null;
            bool hasIdr, hasSps;
            AnnexB.Scan(data, out hasIdr, out hasSps);
            int clean;
            bool key = hasIdr || (s.GetUINT32(ref MF.SampleExtension_CleanPoint, out clean) >= 0 && clean != 0);
            if (key && !hasSps && seqHeader != null)
            {
                var joined = new byte[seqHeader.Length + data.Length];
                Buffer.BlockCopy(seqHeader, 0, joined, 0, seqHeader.Length);
                Buffer.BlockCopy(data, 0, joined, seqHeader.Length, data.Length);
                data = joined;
            }
            if (key) NoteAvc(data, data.Length);
            ulong pts = 0; Region region = null; ulong at = Clock.NowMicros();
            if (pending.Count > 0) { var kv = pending.Dequeue(); pts = kv.Key; region = kv.Value; }
            if (submittedAt.Count > 0) at = submittedAt.Dequeue();
            if (region == null) return null;
            return new EncodedFrame { Kind = Output.H264, Data = data, Len = data.Length, Key = key, Pts = pts, Region = region, EncodeMicros = Clock.NowMicros() - at, Avc = avc };
        }

        void NoteAvc(byte[] d, int n)
        {
            var a = AnnexB.CodecString(d, n);
            if (a != null) avc = a;
        }

        public void Dispose()
        {
            try { if (mft != null && started) mft.ProcessMessage(MF.MFT_MESSAGE_NOTIFY_END_STREAMING, IntPtr.Zero); } catch (Exception) { }
            foreach (var o in new object[] { inSample, inBuf, outSample, outBuf, mft })
                if (o != null) try { Marshal.ReleaseComObject(o); } catch (Exception) { }
            inSample = null; inBuf = null; outSample = null; outBuf = null; mft = null; api = null;
        }
    }

    static class AnnexB
    {
        /// Which NAL units an Annex-B access unit holds (5 = IDR slice, 7 = SPS).
        public static void Scan(byte[] d, out bool idr, out bool sps)
        {
            idr = sps = false;
            for (int i = 0; i + 3 < d.Length; i++)
            {
                if (d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1)
                {
                    int t = d[i + 3] & 0x1f;
                    if (t == 5) idr = true;
                    if (t == 7) sps = true;
                    i += 2;
                }
            }
        }

        /// `avc1.PPCCLL` off the first SPS, or null.
        public static string CodecString(byte[] d, int n)
        {
            for (int i = 0; i + 6 < n; i++)
            {
                if (d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1 && (d[i + 3] & 0x1f) == 7)
                    return "avc1." + d[i + 4].ToString("x2") + d[i + 5].ToString("x2") + d[i + 6].ToString("x2");
            }
            return null;
        }
    }

    static class Yuv
    {
        /// BT.601 limited range, chroma averaged over each 2×2 block. w and h are even.
        public static unsafe void BgraToNv12(IntPtr src, IntPtr dst, int w, int h)
        {
            byte* s = (byte*)src.ToPointer();
            byte* y = (byte*)dst.ToPointer();
            byte* uv = y + (long)w * h;
            int stride = w * 4;
            for (int j = 0; j < h; j += 2)
            {
                byte* p0 = s + (long)j * stride, p1 = p0 + stride;
                byte* y0 = y + (long)j * w, y1 = y0 + w;
                byte* c = uv + (long)(j / 2) * w;
                for (int i = 0; i < w; i += 2)
                {
                    int b00 = p0[0], g00 = p0[1], r00 = p0[2];
                    int b01 = p0[4], g01 = p0[5], r01 = p0[6];
                    int b10 = p1[0], g10 = p1[1], r10 = p1[2];
                    int b11 = p1[4], g11 = p1[5], r11 = p1[6];
                    y0[0] = (byte)(((66 * r00 + 129 * g00 + 25 * b00 + 128) >> 8) + 16);
                    y0[1] = (byte)(((66 * r01 + 129 * g01 + 25 * b01 + 128) >> 8) + 16);
                    y1[0] = (byte)(((66 * r10 + 129 * g10 + 25 * b10 + 128) >> 8) + 16);
                    y1[1] = (byte)(((66 * r11 + 129 * g11 + 25 * b11 + 128) >> 8) + 16);
                    int rr = (r00 + r01 + r10 + r11) >> 2, gg = (g00 + g01 + g10 + g11) >> 2, bb = (b00 + b01 + b10 + b11) >> 2;
                    c[0] = (byte)(((-38 * rr - 74 * gg + 112 * bb + 128) >> 8) + 128);
                    c[1] = (byte)(((112 * rr - 94 * gg - 18 * bb + 128) >> 8) + 128);
                    p0 += 8; p1 += 8; y0 += 2; y1 += 2; c += 2;
                }
            }
        }
    }
}
