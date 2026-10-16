// Capture: displays, windows, and the GDI screen source.
//
// GDI, not Desktop Duplication or Windows.Graphics.Capture: StretchBlt from the screen DC crops and
// scales in one call, needs no permission, no D3D device and no WinRT projection, and works under
// the .NET Framework compiler every Windows ships. It reads the composed desktop, so a window
// source shows whatever is in front of the window, which is also where a click lands. A still
// screen sends nothing: each grab is compared with the last and an equal one is dropped.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace WpDesktop
{
    sealed class DisplayInfo
    {
        public long Id;
        public RECT Rect;
        public double Scale;
        public bool Main;
        public string Device;

        public Dictionary<string, object> ToJson()
        {
            int w = Rect.Right - Rect.Left, h = Rect.Bottom - Rect.Top;
            return new Dictionary<string, object> {
                { "id", Id }, { "width", w }, { "height", h }, { "scale", Scale }, { "main", Main },
                // Points, as on the Mac: pixels over the scale. Input never uses these.
                { "bounds", new Dictionary<string, object> { { "x", Rect.Left / Scale }, { "y", Rect.Top / Scale }, { "w", w / Scale }, { "h", h / Scale } } },
            };
        }
    }

    static class Screens
    {
        public static List<DisplayInfo> Displays()
        {
            var list = new List<DisplayInfo>();
            MonitorEnumProc cb = (IntPtr hmon, IntPtr hdc, ref RECT rc, IntPtr data) =>
            {
                var mi = new MONITORINFOEX();
                mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
                if (!W32.GetMonitorInfo(hmon, ref mi)) return true;
                uint dx = 96, dy = 96;
                try { if (W32.GetDpiForMonitor(hmon, 0, out dx, out dy) != 0) dx = 96; } catch (Exception) { dx = 96; }
                list.Add(new DisplayInfo { Rect = mi.rcMonitor, Scale = dx / 96.0, Main = (mi.dwFlags & 1) != 0, Device = mi.szDevice ?? "" });
                return true;
            };
            try { W32.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero); } catch (Exception) { }
            GC.KeepAlive(cb);
            // The id is the number in \\.\DISPLAYn: it survives a re-enumeration, an index does not.
            var used = new HashSet<long>();
            foreach (var d in list)
            {
                long n = 0;
                var digits = new StringBuilder();
                for (int i = d.Device.Length - 1; i >= 0 && char.IsDigit(d.Device[i]); i--) digits.Insert(0, d.Device[i]);
                if (digits.Length > 0) long.TryParse(digits.ToString(), out n);
                if (n <= 0 || used.Contains(n)) n = 100 + list.IndexOf(d);
                used.Add(n);
                d.Id = n;
            }
            return list;
        }

        static bool Usable(IntPtr hwnd)
        {
            if (!W32.IsWindowVisible(hwnd) || W32.IsIconic(hwnd)) return false;
            if (W32.GetWindow(hwnd, 4 /* GW_OWNER */) != IntPtr.Zero) return false;
            if ((W32.GetWindowLong(hwnd, W32.GWL_EXSTYLE) & W32.WS_EX_TOOLWINDOW) != 0) return false;
            int cloaked = 0;
            try { if (W32.DwmGetWindowAttribute(hwnd, W32.DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return false; } catch (Exception) { }
            if (hwnd == W32.GetShellWindow()) return false;
            RECT r;
            if (!WindowRect(hwnd, out r)) return false;
            return r.Right - r.Left >= 16 && r.Bottom - r.Top >= 16;
        }

        public static bool WindowRect(IntPtr hwnd, out RECT r)
        {
            try { if (W32.DwmGetWindowAttribute(hwnd, W32.DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) == 0) return true; } catch (Exception) { }
            return W32.GetWindowRect(hwnd, out r);
        }

        public static List<Dictionary<string, object>> Windows()
        {
            var out_ = new List<Dictionary<string, object>>();
            var names = new Dictionary<int, string>();
            EnumWindowsProc cb = (hwnd, data) =>
            {
                long id = hwnd.ToInt64();
                if (id <= 0 || id > int.MaxValue || !Usable(hwnd)) return true;
                int len = W32.GetWindowTextLength(hwnd);
                var sb = new StringBuilder(Math.Max(1, len + 1));
                if (len > 0) W32.GetWindowText(hwnd, sb, sb.Capacity);
                int pid;
                W32.GetWindowThreadProcessId(hwnd, out pid);
                string owner;
                if (!names.TryGetValue(pid, out owner))
                {
                    try { owner = Process.GetProcessById(pid).ProcessName; } catch (Exception) { owner = ""; }
                    names[pid] = owner;
                }
                RECT r;
                WindowRect(hwnd, out r);
                var o = new Dictionary<string, object> {
                    { "id", id }, { "pid", pid }, { "owner", owner },
                    { "bounds", new Dictionary<string, object> { { "x", r.Left }, { "y", r.Top }, { "w", r.Right - r.Left }, { "h", r.Bottom - r.Top } } },
                };
                if (sb.Length > 0) o["name"] = sb.ToString();
                out_.Add(o);
                return true;
            };
            W32.EnumWindows(cb, IntPtr.Zero);
            GC.KeepAlive(cb);
            return out_;
        }

        public static RECT VirtualScreen()
        {
            int x = W32.GetSystemMetrics(W32.SM_XVIRTUALSCREEN), y = W32.GetSystemMetrics(W32.SM_YVIRTUALSCREEN);
            return new RECT { Left = x, Top = y, Right = x + W32.GetSystemMetrics(W32.SM_CXVIRTUALSCREEN), Bottom = y + W32.GetSystemMetrics(W32.SM_CYVIRTUALSCREEN) };
        }

        /// The session this process runs in, and whether it can read the desktop at all. A process in
        /// session 0 (a service, or a scheduled task set to run whether the user is signed in or not)
        /// sees a desktop nobody looks at; a locked screen or a UAC prompt is the secure desktop,
        /// which no user process can read.
        public static int SessionId()
        {
            int s;
            try { return W32.ProcessIdToSessionId(Process.GetCurrentProcess().Id, out s) ? s : -1; } catch (Exception) { return -1; }
        }

        public static bool InputDesktopReadable()
        {
            IntPtr d;
            try { d = W32.OpenInputDesktop(0, false, 0x0100 /* DESKTOP_READOBJECTS */); } catch (Exception) { return false; }
            if (d == IntPtr.Zero) return false;
            W32.CloseDesktop(d);
            return true;
        }

        public static bool CanCapture()
        {
            if (SessionId() == 0) return false;
            return InputDesktopReadable();
        }

        public const string NO_SESSION =
            "wp-desktop runs outside the signed-in Windows desktop (session 0), so there is no screen to show. "
            + "Run the host from the signed-in user's session: the scheduled task must be set to "
            + "\"Run only when user is logged on\".";
        public const string LOCKED =
            "The Windows desktop is locked, or a UAC prompt is up: Windows lets no app read that screen. The view resumes once the desktop is back.";
    }

    /// One grab: BGRA, top-down, stride = width * 4. Valid until the next grab of the same source.
    interface IFrameSource : IDisposable
    {
        /// Where the source is now and what the output is; null, or the sentence why not.
        string Resolve(Params p, out Geometry g);
        /// Fills the frame for `g`; false when nothing changed since the last grab (`force`: report it anyway).
        /// `why` is set when the grab failed.
        bool Grab(Params p, Geometry g, bool force, out IntPtr bits, out string why);
    }

    sealed class ScreenSource : IFrameSource
    {
        IntPtr memDC, dib, bits, old, prev;
        int w, h;
        IntPtr frontHwnd;
        ulong frontAt;
        bool havePrev;

        public string Resolve(Params p, out Geometry g)
        {
            g = null;
            RECT r;
            var s = p.Source;
            if (s.Kind == "window" || s.Kind == "front")
            {
                IntPtr hwnd;
                if (s.Kind == "window") hwnd = new IntPtr(s.Id ?? 0);
                else
                {
                    // `front` follows the foreground window, polled at 1 Hz (as on the Mac).
                    ulong now = Clock.NowMicros();
                    if (frontHwnd == IntPtr.Zero || now - frontAt > 1000000)
                    {
                        var f = W32.GetForegroundWindow();
                        if (f != IntPtr.Zero && f != W32.GetShellWindow()) frontHwnd = f;
                        frontAt = now;
                    }
                    hwnd = frontHwnd;
                    if (hwnd == IntPtr.Zero) return "No window is in front on the desktop.";
                }
                if (!W32.IsWindow(hwnd)) return s.Kind == "window" ? "That window was closed." : "The front window was closed.";
                if (W32.IsIconic(hwnd)) return "That window is minimised. Restore it on the desktop to see it.";
                if (!Screens.WindowRect(hwnd, out r)) return "The window's position could not be read.";
                var v = Screens.VirtualScreen();
                r.Left = Math.Max(r.Left, v.Left); r.Top = Math.Max(r.Top, v.Top);
                r.Right = Math.Min(r.Right, v.Right); r.Bottom = Math.Min(r.Bottom, v.Bottom);
                if (r.Right - r.Left < 16 || r.Bottom - r.Top < 16) return "That window is off the screen.";
            }
            else
            {
                var ds = Screens.Displays();
                DisplayInfo d = null;
                foreach (var x in ds) if (s.Id.HasValue ? x.Id == s.Id.Value : x.Main) d = x;
                if (d == null && s.Id.HasValue) return "Display " + s.Id.Value + " is not connected.";
                if (d == null && ds.Count > 0) d = ds[0];
                if (d == null) return "Windows reports no display.";
                r = d.Rect;
            }
            g = new Geometry { SrcWidth = r.Right - r.Left, SrcHeight = r.Bottom - r.Top, X = r.Left, Y = r.Top };
            Params.OutputSize(g.SrcWidth, g.SrcHeight, p.Crop, p.MaxWidth, p.Codec, out g.OutWidth, out g.OutHeight);
            return null;
        }

        void Ensure(int ow, int oh)
        {
            if (memDC != IntPtr.Zero && ow == w && oh == h) return;
            Free();
            var sdc = W32.GetDC(IntPtr.Zero);
            memDC = W32.CreateCompatibleDC(sdc);
            W32.ReleaseDC(IntPtr.Zero, sdc);
            var bmi = new BITMAPINFOHEADER { biSize = Marshal.SizeOf(typeof(BITMAPINFOHEADER)), biWidth = ow, biHeight = -oh, biPlanes = 1, biBitCount = 32 };
            dib = W32.CreateDIBSection(memDC, ref bmi, 0, out bits, IntPtr.Zero, 0);
            old = W32.SelectObject(memDC, dib);
            W32.SetStretchBltMode(memDC, W32.HALFTONE);
            W32.SetBrushOrgEx(memDC, 0, 0, IntPtr.Zero);
            prev = Marshal.AllocHGlobal(ow * oh * 4);
            havePrev = false;
            w = ow; h = oh;
        }

        public bool Grab(Params p, Geometry g, bool force, out IntPtr outBits, out string why)
        {
            outBits = IntPtr.Zero;
            why = null;
            Ensure(g.OutWidth, g.OutHeight);
            if (dib == IntPtr.Zero) { why = "Windows could not allocate a " + g.OutWidth + "×" + g.OutHeight + " bitmap."; return false; }
            int cx = g.X + (int)Math.Round(p.Crop.X * g.SrcWidth), cy = g.Y + (int)Math.Round(p.Crop.Y * g.SrcHeight);
            int cw = Math.Max(2, (int)Math.Round(p.Crop.W * g.SrcWidth)), ch = Math.Max(2, (int)Math.Round(p.Crop.H * g.SrcHeight));
            var sdc = W32.GetDC(IntPtr.Zero);
            if (sdc == IntPtr.Zero) { why = Screens.LOCKED; return false; }
            bool ok = cw == w && ch == h
                ? W32.BitBlt(memDC, 0, 0, w, h, sdc, cx, cy, W32.SRCCOPY)
                : W32.StretchBlt(memDC, 0, 0, w, h, sdc, cx, cy, cw, ch, W32.SRCCOPY);
            W32.ReleaseDC(IntPtr.Zero, sdc);
            if (!ok) { why = Screens.LOCKED; return false; }
            if (p.Cursor) DrawCursor(cx, cy, cw, ch);
            W32.GdiFlush();
            var n = new UIntPtr((uint)(w * h * 4));
            bool changed = !havePrev || W32.memcmp(bits, prev, n) != 0;
            if (changed) { W32.memcpy(prev, bits, n); havePrev = true; }
            outBits = bits;
            return changed || force;
        }

        void DrawCursor(int cx, int cy, int cw, int ch)
        {
            var ci = new CURSORINFO();
            ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
            if (!W32.GetCursorInfo(ref ci) || (ci.flags & W32.CURSOR_SHOWING) == 0 || ci.hCursor == IntPtr.Zero) return;
            ICONINFO ii;
            int hx = 0, hy = 0;
            if (W32.GetIconInfo(ci.hCursor, out ii))
            {
                hx = ii.xHotspot; hy = ii.yHotspot;
                if (ii.hbmMask != IntPtr.Zero) W32.DeleteObject(ii.hbmMask);
                if (ii.hbmColor != IntPtr.Zero) W32.DeleteObject(ii.hbmColor);
            }
            double sx = (double)w / cw, sy = (double)h / ch;
            int size = Math.Max(8, (int)Math.Round(32 * sx));
            int x = (int)Math.Round((ci.ptScreenPos.X - hx - cx) * sx), y = (int)Math.Round((ci.ptScreenPos.Y - hy - cy) * sy);
            if (x < -size || y < -size || x > w || y > h) return;
            W32.DrawIconEx(memDC, x, y, ci.hCursor, size, size, 0, IntPtr.Zero, W32.DI_NORMAL);
        }

        void Free()
        {
            if (memDC != IntPtr.Zero)
            {
                if (old != IntPtr.Zero) W32.SelectObject(memDC, old);
                if (dib != IntPtr.Zero) W32.DeleteObject(dib);
                W32.DeleteDC(memDC);
            }
            if (prev != IntPtr.Zero) Marshal.FreeHGlobal(prev);
            memDC = dib = bits = old = prev = IntPtr.Zero;
            w = h = 0;
        }

        public void Dispose() { Free(); }
    }
}
