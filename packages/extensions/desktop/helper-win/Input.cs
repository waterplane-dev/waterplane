// Input: phone gestures → SendInput. Coordinates arrive normalised 0..1 of the CURRENT SOURCE's
// full bounds (display or window, not the crop) and are mapped to the virtual desktop here.
// `cmd` is the Windows key (what a desktop browser calls metaKey on Windows).
//
// With --dry-input every event is built exactly as it would be sent, then logged instead.
// Windows refuses synthetic input into a window running elevated (UIPI) and on the secure desktop
// (lock screen, UAC prompt), and says nothing about it: the view must never claim "typed".

using System;
using System.Collections.Generic;
using System.Globalization;

namespace WpDesktop
{
    sealed class InputInjector
    {
        readonly bool dry;
        string held;

        public InputInjector(bool dry) { this.dry = dry; }

        static readonly Dictionary<string, ushort> named = new Dictionary<string, ushort> {
            { "Escape", 0x1B }, { "Esc", 0x1B }, { "Tab", 0x09 }, { "Return", 0x0D }, { "Enter", 0x0D }, { "Backspace", 0x08 },
            { "Delete", 0x2E }, { "ArrowUp", 0x26 }, { "ArrowDown", 0x28 }, { "ArrowLeft", 0x25 }, { "ArrowRight", 0x27 },
            { "Home", 0x24 }, { "End", 0x23 }, { "PageUp", 0x21 }, { "PageDown", 0x22 }, { "Space", 0x20 }, { " ", 0x20 },
            { "F1", 0x70 }, { "F2", 0x71 }, { "F3", 0x72 }, { "F4", 0x73 }, { "F5", 0x74 }, { "F6", 0x75 },
            { "F7", 0x76 }, { "F8", 0x77 }, { "F9", 0x78 }, { "F10", 0x79 }, { "F11", 0x7A }, { "F12", 0x7B },
        };

        /// Keys whose scan code needs the E0 prefix: without it Windows reads the numpad's twin.
        static readonly HashSet<ushort> extended = new HashSet<ushort> { 0x2E, 0x26, 0x28, 0x25, 0x27, 0x24, 0x23, 0x21, 0x22, 0x2D, 0x5B };

        static readonly Dictionary<char, ushort> punct = new Dictionary<char, ushort> {
            { ';', 0xBA }, { '=', 0xBB }, { ',', 0xBC }, { '-', 0xBD }, { '.', 0xBE }, { '/', 0xBF }, { '`', 0xC0 },
            { '[', 0xDB }, { '\\', 0xDC }, { ']', 0xDD }, { '\'', 0xDE },
        };

        static readonly Dictionary<char, char> shifted = new Dictionary<char, char> {
            { '!', '1' }, { '@', '2' }, { '#', '3' }, { '$', '4' }, { '%', '5' }, { '^', '6' }, { '&', '7' }, { '*', '8' }, { '(', '9' }, { ')', '0' },
            { '_', '-' }, { '+', '=' }, { '{', '[' }, { '}', ']' }, { '|', '\\' }, { ':', ';' }, { '"', '\'' }, { '<', ',' }, { '>', '.' }, { '?', '/' },
            { '~', '`' },
        };

        static readonly Dictionary<string, ushort> mods = new Dictionary<string, ushort> {
            { "cmd", 0x5B }, { "meta", 0x5B }, { "alt", 0x12 }, { "option", 0x12 }, { "ctrl", 0x11 }, { "control", 0x11 }, { "shift", 0x10 },
        };

        /// US-layout virtual key (+ whether Shift is implied) for a `key` name.
        public static bool KeyCode(string key, out ushort vk, out bool shift)
        {
            vk = 0; shift = false;
            if (key == null) return false;
            if (named.TryGetValue(key, out vk)) return true;
            if (key.Length != 1) return false;
            char ch = key[0];
            if (ch >= 'a' && ch <= 'z') { vk = (ushort)char.ToUpperInvariant(ch); return true; }
            if (ch >= 'A' && ch <= 'Z') { vk = ch; shift = true; return true; }
            if (ch >= '0' && ch <= '9') { vk = ch; return true; }
            if (punct.TryGetValue(ch, out vk)) return true;
            char b;
            if (shifted.TryGetValue(ch, out b))
            {
                shift = true;
                if (b >= '0' && b <= '9') { vk = b; return true; }
                return punct.TryGetValue(b, out vk);
            }
            return false;
        }

        /// null when handled; otherwise the sentence why the event was ignored.
        public string Handle(Dictionary<string, object> ev, Geometry g)
        {
            var k = Json.Str(Json.Get(ev, "k"));
            if (k == null) return "input without k";
            var modVks = new List<ushort>();
            foreach (var m in Json.Strings(Json.Get(ev, "mods")))
            {
                ushort v;
                if (mods.TryGetValue(m, out v) && !modVks.Contains(v)) modVks.Add(v);
            }
            double px = 0, py = 0;
            Func<bool> point = () =>
            {
                var x = Json.Num(Json.Get(ev, "x")); var y = Json.Num(Json.Get(ev, "y"));
                if (!x.HasValue || !y.HasValue || double.IsNaN(x.Value) || double.IsNaN(y.Value)) return false;
                if (x.Value < -0.05 || x.Value > 1.05 || y.Value < -0.05 || y.Value > 1.05) return false;
                px = g.X + Math.Min(1, Math.Max(0, x.Value)) * (g.SrcWidth - 1);
                py = g.Y + Math.Min(1, Math.Max(0, y.Value)) * (g.SrcHeight - 1);
                return true;
            };
            var bRaw = Json.Get(ev, "b");
            string btn = bRaw == null ? "l" : Json.Str(bRaw);
            bool btnOk = btn == "l" || btn == "r" || btn == "m";

            switch (k)
            {
                case "move":
                    if (!point()) return "move needs x,y in 0..1";
                    Mouse(W32.MOUSEEVENTF_MOVE, px, py, 0, held != null ? "mouseDragged" : "mouseMoved", "");
                    break;
                case "down":
                case "up":
                    if (!point()) return k + " needs x,y in 0..1";
                    if (!btnOk) return k + ": b must be l, r or m";
                    Mods(modVks, true);
                    if (k == "down") { held = btn; Mouse(Down(btn), px, py, 0, Name(btn, true), "button=" + btn + " clicks=1"); }
                    else { if (held == btn) held = null; Mouse(Up(btn), px, py, 0, Name(btn, false), "button=" + btn + " clicks=1"); }
                    Mods(modVks, false);
                    break;
                case "click":
                    {
                        if (!point()) return "click needs x,y in 0..1";
                        if (!btnOk) return "click: b must be l, r or m";
                        var nn = Json.Num(Json.Get(ev, "n"));
                        int n = Math.Min(3, Math.Max(1, nn.HasValue ? (int)nn.Value : 1));
                        Mouse(W32.MOUSEEVENTF_MOVE, px, py, 0, "mouseMoved", "");
                        Mods(modVks, true);
                        for (int i = 1; i <= n; i++)
                        {
                            Mouse(Down(btn), px, py, 0, Name(btn, true), "button=" + btn + " clicks=" + i);
                            Mouse(Up(btn), px, py, 0, Name(btn, false), "button=" + btn + " clicks=" + i);
                        }
                        Mods(modVks, false);
                        break;
                    }
                case "scroll":
                    {
                        if (!point()) return "scroll needs x,y in 0..1";
                        var dxn = Json.Num(Json.Get(ev, "dx")); var dyn = Json.Num(Json.Get(ev, "dy"));
                        double dx = dxn ?? 0, dy = dyn ?? 0;
                        if (double.IsNaN(dx) || double.IsNaN(dy) || double.IsInfinity(dx) || double.IsInfinity(dy)) return "scroll needs finite dx,dy";
                        // DOM sign (dy > 0 scrolls the content down) in points. Windows' wheel is 120 a notch,
                        // positive away from the user (content up), and a notch is about 40 points of a page.
                        int w1 = (int)Math.Max(-12000, Math.Min(12000, Math.Round(-dy * 3))), w2 = (int)Math.Max(-12000, Math.Min(12000, Math.Round(dx * 3)));
                        Mouse(W32.MOUSEEVENTF_MOVE, px, py, 0, held != null ? "mouseDragged" : "mouseMoved", "");
                        Mods(modVks, true);
                        if (w1 != 0) Mouse(W32.WHEEL, px, py, w1, "scrollWheel", "wheel=" + w1 + ",0");
                        if (w2 != 0) Mouse(W32.HWHEEL, px, py, w2, "scrollWheel", "wheel=0," + w2);
                        Mods(modVks, false);
                        break;
                    }
                case "key":
                    {
                        var name = Json.Str(Json.Get(ev, "key"));
                        ushort vk; bool shift;
                        if (!KeyCode(name, out vk, out shift)) return "key: unknown key " + (name ?? "nil");
                        var all = new List<ushort>(modVks);
                        if (shift && !all.Contains(0x10)) all.Add(0x10);
                        Mods(all, true);
                        Key(vk, true, Flags(all));
                        Key(vk, false, Flags(all));
                        Mods(all, false);
                        break;
                    }
                case "text":
                    {
                        var s = Json.Str(Json.Get(ev, "s"));
                        if (string.IsNullOrEmpty(s)) return "text needs a non-empty s";
                        if (s.Length > 4096) return "text longer than 4096 UTF-16 units";
                        foreach (var chunk in Chunks(s, 20)) Text(chunk);
                        break;
                    }
                default:
                    return "unknown input kind " + k;
            }
            return null;
        }

        static int Down(string b) { return b == "l" ? W32.LEFTDOWN : b == "r" ? W32.RIGHTDOWN : W32.MIDDLEDOWN; }
        static int Up(string b) { return b == "l" ? W32.LEFTUP : b == "r" ? W32.RIGHTUP : W32.MIDDLEUP; }
        static string Name(string b, bool down) { return (b == "l" ? "leftMouse" : b == "r" ? "rightMouse" : "otherMouse") + (down ? "Down" : "Up"); }

        static string Flags(List<ushort> vks)
        {
            int f = 0;
            foreach (var v in vks) f |= v == 0x10 ? 0x20000 : v == 0x11 ? 0x40000 : v == 0x12 ? 0x80000 : v == 0x5B ? 0x100000 : 0;
            return "0x" + f.ToString("x");
        }

        /// ≤ n UTF-16 units, never splitting a surrogate pair.
        public static List<string> Chunks(string s, int n)
        {
            var out_ = new List<string>();
            int i = 0;
            while (i < s.Length)
            {
                int j = Math.Min(s.Length, i + n);
                if (j < s.Length && j - i > 1 && char.IsHighSurrogate(s[j - 1])) j--;
                out_.Add(s.Substring(i, j - i));
                i = j;
            }
            return out_;
        }

        void Mouse(int flags, double x, double y, int data, string what, string extra)
        {
            if (dry)
            {
                Log.Say(string.Format(CultureInfo.InvariantCulture, "dry-input: {0} x={1:0.0} y={2:0.0} flags=0x0 {3}", what, x, y, extra).TrimEnd());
                return;
            }
            var v = Screens.VirtualScreen();
            int vw = Math.Max(2, v.Right - v.Left), vh = Math.Max(2, v.Bottom - v.Top);
            int ax = (int)Math.Round((x - v.Left) * 65535.0 / (vw - 1)), ay = (int)Math.Round((y - v.Top) * 65535.0 / (vh - 1));
            var inp = new INPUT { type = W32.INPUT_MOUSE };
            inp.mi.dx = ax; inp.mi.dy = ay; inp.mi.mouseData = data;
            inp.mi.dwFlags = flags | W32.MOUSEEVENTF_MOVE | W32.ABSOLUTE | W32.VIRTUALDESK;
            Send(inp);
        }

        void Mods(List<ushort> vks, bool down)
        {
            if (down) foreach (var v in vks) Key(v, true, null);
            else for (int i = vks.Count - 1; i >= 0; i--) Key(vks[i], false, null);
        }

        void Key(ushort vk, bool down, string flags)
        {
            if (dry)
            {
                // Modifier presses are part of the chord line, as on the Mac (flags=…).
                if (flags != null) Log.Say("dry-input: " + (down ? "keyDown" : "keyUp") + " x=0.0 y=0.0 flags=" + flags + " key=0x" + vk.ToString("x2"));
                return;
            }
            var inp = new INPUT { type = W32.INPUT_KEYBOARD };
            inp.ki.wVk = vk;
            inp.ki.dwFlags = (down ? 0 : W32.KEYEVENTF_KEYUP) | (extended.Contains(vk) ? W32.KEYEVENTF_EXTENDEDKEY : 0);
            Send(inp);
        }

        void Text(string chunk)
        {
            if (dry)
            {
                foreach (var down in new[] { true, false })
                    Log.Say("dry-input: " + (down ? "keyDown" : "keyUp") + " x=0.0 y=0.0 flags=0x0 text=" + Json.Write(chunk) + " units=" + chunk.Length);
                return;
            }
            var list = new INPUT[chunk.Length * 2];
            for (int i = 0; i < chunk.Length; i++)
            {
                list[2 * i] = new INPUT { type = W32.INPUT_KEYBOARD };
                list[2 * i].ki.wScan = chunk[i];
                list[2 * i].ki.dwFlags = W32.KEYEVENTF_UNICODE;
                list[2 * i + 1] = new INPUT { type = W32.INPUT_KEYBOARD };
                list[2 * i + 1].ki.wScan = chunk[i];
                list[2 * i + 1].ki.dwFlags = W32.KEYEVENTF_UNICODE | W32.KEYEVENTF_KEYUP;
            }
            W32.SendInput(list.Length, list, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
        }

        static void Send(INPUT inp)
        {
            W32.SendInput(1, new[] { inp }, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
        }
    }
}
