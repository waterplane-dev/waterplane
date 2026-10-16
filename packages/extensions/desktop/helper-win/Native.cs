// Native: every Win32 and Media Foundation declaration the helper uses, in one place.
// C# 5 (the compiler every Windows ships in the .NET Framework directory), x64.

using System;
using System.Runtime.InteropServices;

namespace WpDesktop
{
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public int dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct BITMAPINFOHEADER
    {
        public int biSize, biWidth, biHeight;
        public short biPlanes, biBitCount;
        public int biCompression, biSizeImage, biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct CURSORINFO { public int cbSize, flags; public IntPtr hCursor; public POINT ptScreenPos; }

    [StructLayout(LayoutKind.Sequential)]
    struct ICONINFO { public bool fIcon; public int xHotspot, yHotspot; public IntPtr hbmMask, hbmColor; }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy, mouseData, dwFlags, time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk, wScan; public int dwFlags, time; public IntPtr dwExtraInfo; }

    /// x64 layout: type, 4 bytes of padding, then the union.
    [StructLayout(LayoutKind.Explicit)]
    struct INPUT
    {
        [FieldOffset(0)] public int type;
        [FieldOffset(8)] public MOUSEINPUT mi;
        [FieldOffset(8)] public KEYBDINPUT ki;
    }

    delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rc, IntPtr data);
    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr data);

    static class W32
    {
        public const int SRCCOPY = 0x00CC0020;
        public const int HALFTONE = 4;
        public const int DI_NORMAL = 3;
        public const int CURSOR_SHOWING = 1;
        public const int INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
        public const int MOUSEEVENTF_MOVE = 0x1, LEFTDOWN = 0x2, LEFTUP = 0x4, RIGHTDOWN = 0x8, RIGHTUP = 0x10,
            MIDDLEDOWN = 0x20, MIDDLEUP = 0x40, WHEEL = 0x800, HWHEEL = 0x1000, VIRTUALDESK = 0x4000, ABSOLUTE = 0x8000;
        public const int KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4;
        public const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;
        public const uint ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x1;
        public const int GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80;
        public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;

        [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
        [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
        [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
        [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFOHEADER bmi, int usage, out IntPtr bits, IntPtr section, int offset);
        [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, int rop);
        [DllImport("gdi32.dll")] public static extern bool StretchBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, int sw, int sh, int rop);
        [DllImport("gdi32.dll")] public static extern int SetStretchBltMode(IntPtr hdc, int mode);
        [DllImport("gdi32.dll")] public static extern bool SetBrushOrgEx(IntPtr hdc, int x, int y, IntPtr prev);
        [DllImport("gdi32.dll")] public static extern bool GdiFlush();

        [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO ci);
        [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
        [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int w, int h, int step, IntPtr brush, int flags);

        [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr hmon, ref MONITORINFOEX info);
        [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmon, int type, out uint dpiX, out uint dpiY);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);

        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
        [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr data);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, int cmd);
        [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder s, int max);
        [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hwnd, out int pid);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rc);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT value, int size);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);

        [DllImport("user32.dll", SetLastError = true)] public static extern int SendInput(int n, INPUT[] inputs, int size);

        [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
        [DllImport("kernel32.dll")] public static extern int WTSGetActiveConsoleSessionId();
        [DllImport("kernel32.dll")] public static extern bool ProcessIdToSessionId(int pid, out int session);
        [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(int flags, bool inherit, int access);
        [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desk);

        [DllImport("msvcrt.dll", CallingConvention = CallingConvention.Cdecl)] public static extern int memcmp(IntPtr a, IntPtr b, UIntPtr n);
        [DllImport("msvcrt.dll", CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr memcpy(IntPtr dst, IntPtr src, UIntPtr n);

        /// Physical pixels everywhere (capture, monitors, input), whatever the display scaling.
        public static void DpiAware()
        {
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (Exception) { }
            try { if (SetProcessDpiAwareness(2) == 0) return; } catch (Exception) { }
            try { SetProcessDPIAware(); } catch (Exception) { }
        }
    }

    // ---- Media Foundation ----

    [StructLayout(LayoutKind.Sequential)]
    struct MFT_OUTPUT_STREAM_INFO { public int dwFlags, cbSize, cbAlignment; }

    [StructLayout(LayoutKind.Sequential)]
    struct MFT_OUTPUT_DATA_BUFFER { public int dwStreamID; public IntPtr pSample; public int dwStatus; public IntPtr pEvents; }

    /// IMFAttributes' 30 methods are repeated in every interface that derives from it: a C#
    /// ComImport interface does not inherit its base's vtable slots. Placeholders hold slots
    /// that are never called.
    [ComImport, Guid("44ae0fa8-ea31-4109-8d2e-4cae4997c555"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFMediaType
    {
        void _GetItem(); void _GetItemType(); void _CompareItem(); void _Compare();
        [PreserveSig] int GetUINT32([In] ref Guid key, out int value);
        [PreserveSig] int GetUINT64([In] ref Guid key, out long value);
        void _GetDouble();
        [PreserveSig] int GetGUID([In] ref Guid key, out Guid value);
        void _GetStringLength(); void _GetString(); void _GetAllocatedString();
        [PreserveSig] int GetBlobSize([In] ref Guid key, out int size);
        [PreserveSig] int GetBlob([In] ref Guid key, [Out] byte[] buf, int size, out int got);
        void _GetAllocatedBlob(); void _GetUnknown(); void _SetItem(); void _DeleteItem(); void _DeleteAllItems();
        [PreserveSig] int SetUINT32([In] ref Guid key, int value);
        [PreserveSig] int SetUINT64([In] ref Guid key, long value);
        void _SetDouble();
        [PreserveSig] int SetGUID([In] ref Guid key, [In] ref Guid value);
        void _SetString(); void _SetBlob(); void _SetUnknown(); void _LockStore(); void _UnlockStore();
        void _GetCount(); void _GetItemByIndex(); void _CopyAllItems();
        // IMFMediaType
        void _GetMajorType(); void _IsCompressedFormat(); void _IsEqual(); void _GetRepresentation(); void _FreeRepresentation();
    }

    [ComImport, Guid("c40a00f2-b93a-4d80-ae8c-5a1c634f58e4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFSample
    {
        void _GetItem(); void _GetItemType(); void _CompareItem(); void _Compare();
        [PreserveSig] int GetUINT32([In] ref Guid key, out int value);
        void _GetUINT64(); void _GetDouble(); void _GetGUID();
        void _GetStringLength(); void _GetString(); void _GetAllocatedString();
        void _GetBlobSize(); void _GetBlob(); void _GetAllocatedBlob(); void _GetUnknown(); void _SetItem(); void _DeleteItem(); void _DeleteAllItems();
        [PreserveSig] int SetUINT32([In] ref Guid key, int value);
        void _SetUINT64(); void _SetDouble(); void _SetGUID();
        void _SetString(); void _SetBlob(); void _SetUnknown(); void _LockStore(); void _UnlockStore();
        void _GetCount(); void _GetItemByIndex(); void _CopyAllItems();
        // IMFSample
        void _GetSampleFlags(); void _SetSampleFlags(); void _GetSampleTime();
        [PreserveSig] int SetSampleTime(long t);
        void _GetSampleDuration();
        [PreserveSig] int SetSampleDuration(long d);
        void _GetBufferCount(); void _GetBufferByIndex();
        [PreserveSig] int ConvertToContiguousBuffer(out IMFMediaBuffer buf);
        [PreserveSig] int AddBuffer(IMFMediaBuffer buf);
        void _RemoveBufferByIndex();
        [PreserveSig] int RemoveAllBuffers();
        void _GetTotalLength(); void _CopyToBuffer();
    }

    [ComImport, Guid("045FA593-8799-42b8-BC8D-8968C6453507"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFMediaBuffer
    {
        [PreserveSig] int Lock(out IntPtr buf, out int max, out int cur);
        [PreserveSig] int Unlock();
        [PreserveSig] int GetCurrentLength(out int len);
        [PreserveSig] int SetCurrentLength(int len);
        [PreserveSig] int GetMaxLength(out int len);
    }

    [ComImport, Guid("bf94c121-5b05-4e6f-8000-ba598961414d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMFTransform
    {
        void _GetStreamLimits(); void _GetStreamCount(); void _GetStreamIDs();
        void _GetInputStreamInfo();
        [PreserveSig] int GetOutputStreamInfo(int id, out MFT_OUTPUT_STREAM_INFO info);
        void _GetAttributes(); void _GetInputStreamAttributes(); void _GetOutputStreamAttributes();
        void _DeleteInputStream(); void _AddInputStreams();
        void _GetInputAvailableType();
        [PreserveSig] int GetOutputAvailableType(int id, int index, out IMFMediaType type);
        [PreserveSig] int SetInputType(int id, IMFMediaType type, int flags);
        [PreserveSig] int SetOutputType(int id, IMFMediaType type, int flags);
        void _GetInputCurrentType();
        [PreserveSig] int GetOutputCurrentType(int id, out IMFMediaType type);
        void _GetInputStatus(); void _GetOutputStatus(); void _SetOutputBounds(); void _ProcessEvent();
        [PreserveSig] int ProcessMessage(int msg, IntPtr param);
        [PreserveSig] int ProcessInput(int id, IMFSample sample, int flags);
        [PreserveSig] int ProcessOutput(int flags, int count, [In, Out] MFT_OUTPUT_DATA_BUFFER[] bufs, out int status);
    }

    [ComImport, Guid("901db4c7-31ce-41a2-85dc-8fa0bf41b8da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ICodecAPI
    {
        void _IsSupported(); void _IsModifiable(); void _GetParameterRange(); void _GetParameterValues();
        void _GetDefaultValue(); void _GetValue();
        [PreserveSig] int SetValue([In] ref Guid api, [In] ref object value);
    }

    static class MF
    {
        public const int MF_VERSION = 0x00020070;
        public const int MFT_MESSAGE_COMMAND_FLUSH = 0, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING = 0x10000000,
            MFT_MESSAGE_NOTIFY_END_STREAMING = 0x10000001, MFT_MESSAGE_NOTIFY_START_OF_STREAM = 0x10000003;
        public const int MFT_OUTPUT_STREAM_PROVIDES_SAMPLES = 0x100, MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES = 0x200;
        public const int E_NEED_MORE_INPUT = unchecked((int)0xC00D6D72);
        public const int E_STREAM_CHANGE = unchecked((int)0xC00D6D61);
        public const int E_NOTACCEPTING = unchecked((int)0xC00D36B5);

        public static readonly Guid CLSID_H264Encoder = new Guid("6CA50344-051A-4DED-9779-A43305165E35");
        public static Guid MT_MAJOR_TYPE = new Guid("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
        public static Guid MT_SUBTYPE = new Guid("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
        public static Guid MT_AVG_BITRATE = new Guid("20332624-fb0d-4d9e-bd0d-cbf6786c102e");
        public static Guid MT_INTERLACE_MODE = new Guid("e2724bb8-e676-4806-b4b2-a8d6efb44ccd");
        public static Guid MT_FRAME_SIZE = new Guid("1652c33d-d6b2-4012-b834-72030849a37d");
        public static Guid MT_FRAME_RATE = new Guid("c459a2e8-3d2c-4e44-b132-fee5156c7bb0");
        public static Guid MT_PIXEL_ASPECT_RATIO = new Guid("c6376a1e-8d0a-4027-be45-6d9a0ad39bb6");
        public static Guid MT_MPEG2_PROFILE = new Guid("ad76a80b-2d5c-4e0b-b375-64e520137036");
        public static Guid MT_MPEG_SEQUENCE_HEADER = new Guid("3c036de7-3ad0-4c9e-9216-ee6d6ac21cb3");
        public static Guid MediaType_Video = new Guid("73646976-0000-0010-8000-00AA00389B71");
        public static Guid VideoFormat_H264 = new Guid("34363248-0000-0010-8000-00AA00389B71");
        public static Guid VideoFormat_NV12 = new Guid("3231564E-0000-0010-8000-00AA00389B71");
        public static Guid SampleExtension_CleanPoint = new Guid("9cdf01d8-a0f0-43ba-b077-eaa06cbd728a");

        public static Guid AVEncCommonRateControlMode = new Guid("1c0608e9-370c-4710-8a58-cb6181c42423");
        public static Guid AVEncCommonMeanBitRate = new Guid("f7222374-2144-4815-b550-a37f8e12ee52");
        public static Guid AVEncCommonMaxBitRate = new Guid("9651eae4-39b9-4ebf-85ef-d7f444ec7465");
        public static Guid AVLowLatencyMode = new Guid("9c27891a-ed7a-40e1-88e8-b22727a024ee");
        public static Guid AVEncMPVGOPSize = new Guid("95f31b26-95a4-41aa-9303-246a7fc6eef1");
        public static Guid AVEncMPVDefaultBPictureCount = new Guid("8d390aac-dc5c-4200-b57f-814d04babab2");
        public static Guid AVEncVideoForceKeyFrame = new Guid("398c1b98-8353-475a-9ef2-8f265d260345");
        public static Guid AVEncCommonQualityVsSpeed = new Guid("98332df8-03cd-476b-89fa-3f9e442dec9f");

        [DllImport("mfplat.dll")] public static extern int MFStartup(int version, int flags);
        [DllImport("mfplat.dll")] public static extern int MFCreateMediaType(out IMFMediaType type);
        [DllImport("mfplat.dll")] public static extern int MFCreateSample(out IMFSample sample);
        [DllImport("mfplat.dll")] public static extern int MFCreateMemoryBuffer(int size, out IMFMediaBuffer buf);

        static bool started;
        public static bool Start()
        {
            if (started) return true;
            try { started = MFStartup(MF_VERSION, 0) >= 0; } catch (Exception) { started = false; }
            return started;
        }
    }
}
