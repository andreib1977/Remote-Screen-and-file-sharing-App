using System.Runtime.InteropServices;

namespace PeerLink.Input;

/// <summary>
/// Converts normalised [0..1] remote input into absolute SendInput events covering
/// the whole virtual desktop (all monitors).
/// </summary>
internal sealed class Injector
{
    private readonly int _vx;
    private readonly int _vy;
    private readonly int _vw;
    private readonly int _vh;

    // SendInput absolute coordinates are expressed on a 0..65535 scale.
    private const double AbsMax = 65535.0;

    public Injector()
    {
        _vx = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
        _vy = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
        _vw = Math.Max(1, Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN));
        _vh = Math.Max(1, Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN));
    }

    public int VirtualX => _vx;
    public int VirtualY => _vy;
    public int VirtualWidth => _vw;
    public int VirtualHeight => _vh;

    private static void Send(params Native.INPUT[] inputs)
    {
        Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Native.INPUT>());
    }

    private static Native.INPUT MouseInput(uint flags, int dx = 0, int dy = 0, uint data = 0)
        => new()
        {
            type = Native.INPUT_MOUSE,
            u = new Native.INPUTUNION
            {
                mi = new Native.MOUSEINPUT
                {
                    dx = dx,
                    dy = dy,
                    mouseData = data,
                    dwFlags = flags,
                    time = 0,
                    dwExtraInfo = IntPtr.Zero
                }
            }
        };

    private static Native.INPUT KeyInput(ushort vk, bool up, bool extended = false)
        => new()
        {
            type = Native.INPUT_KEYBOARD,
            u = new Native.INPUTUNION
            {
                ki = new Native.KEYBDINPUT
                {
                    wVk = vk,
                    wScan = 0,
                    dwFlags = (up ? Native.KEYEVENTF_KEYUP : 0) | (extended ? Native.KEYEVENTF_EXTENDEDKEY : 0),
                    time = 0,
                    dwExtraInfo = IntPtr.Zero
                }
            }
        };

    private static Native.INPUT UnicodeInput(char ch, bool up)
        => new()
        {
            type = Native.INPUT_KEYBOARD,
            u = new Native.INPUTUNION
            {
                ki = new Native.KEYBDINPUT
                {
                    wVk = 0,
                    wScan = ch,
                    dwFlags = Native.KEYEVENTF_UNICODE | (up ? Native.KEYEVENTF_KEYUP : 0),
                    time = 0,
                    dwExtraInfo = IntPtr.Zero
                }
            }
        };

    /// <summary>Move the pointer to a normalised position over the virtual desktop.</summary>
    public void MouseMove(double nx, double ny)
    {
        double x = Clamp01(nx);
        double y = Clamp01(ny);
        int ax = (int)Math.Round(x * AbsMax);
        int ay = (int)Math.Round(y * AbsMax);
        Send(MouseInput(Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK, ax, ay));
    }

    public void MouseButton(string? button, bool down, int clicks = 1)
    {
        if (clicks < 1) clicks = 1;
        if (clicks > 3) clicks = 3;

        for (int i = 0; i < clicks; i++)
        {
            switch ((button ?? "left").ToLowerInvariant())
            {
                case "left":
                    Send(MouseInput(down ? Native.MOUSEEVENTF_LEFTDOWN : Native.MOUSEEVENTF_LEFTUP));
                    break;
                case "right":
                    Send(MouseInput(down ? Native.MOUSEEVENTF_RIGHTDOWN : Native.MOUSEEVENTF_RIGHTUP));
                    break;
                case "middle":
                    Send(MouseInput(down ? Native.MOUSEEVENTF_MIDDLEDOWN : Native.MOUSEEVENTF_MIDDLEUP));
                    break;
                case "back":
                    Send(MouseInput(down ? Native.MOUSEEVENTF_XDOWN : Native.MOUSEEVENTF_XUP, 0, 0, Native.XBUTTON1));
                    break;
                case "forward":
                    Send(MouseInput(down ? Native.MOUSEEVENTF_XDOWN : Native.MOUSEEVENTF_XUP, 0, 0, Native.XBUTTON2));
                    break;
            }
        }
    }

    /// <summary>Wheel scroll; positive dy scrolls up, positive dx scrolls right.</summary>
    public void Wheel(int dx, int dy)
    {
        if (dy != 0)
        {
            int notches = Math.Clamp(dy, -20, 20);
            Send(MouseInput(Native.MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)(notches * 120))));
        }
        if (dx != 0)
        {
            int notches = Math.Clamp(dx, -20, 20);
            Send(MouseInput(Native.MOUSEEVENTF_HWHEEL, 0, 0, unchecked((uint)(notches * 120))));
        }
    }

    private static bool IsDown(ushort vk) => (Native.GetAsyncKeyState(vk) & 0x8000) != 0;

    /// <summary>Press or release a key identified by DOM code (or a raw virtual key).</summary>
    public void Key(string? code, int? vkRaw, bool down)
    {
        ushort vk;
        if (vkRaw is > 0 and < 256)
        {
            vk = (ushort)vkRaw.Value;
        }
        else if (!KeyMap.TryFromDomCode(code, out vk))
        {
            return;
        }

        Send(KeyInput(vk, up: !down, extended: IsExtended(vk)));
    }

    /// <summary>Type a character, synthesising the modifier state the layout requires.</summary>
    public void Text(string text)
    {
        foreach (char ch in text)
        {
            if (ch == '\r') continue;
            if (ch == '\n' || ch == '\t')
            {
                ushort special = ch == '\n' ? (ushort)0x0D : (ushort)0x09;
                Send(KeyInput(special, false), KeyInput(special, true));
                continue;
            }

            if (!KeyMap.TryFromChar(ch, out ushort vk, out bool shift, out bool ctrl, out bool alt))
            {
                // Not reachable through the keyboard layout: inject as a Unicode packet.
                Send(UnicodeInput(ch, false), UnicodeInput(ch, true));
                continue;
            }

            var sequence = new List<Native.INPUT>(8);
            if (shift) sequence.Add(KeyInput(0xA0, false));
            if (ctrl) sequence.Add(KeyInput(0xA2, false));
            if (alt) sequence.Add(KeyInput(0xA4, false));
            sequence.Add(KeyInput(vk, false));
            sequence.Add(KeyInput(vk, true));
            if (alt) sequence.Add(KeyInput(0xA4, true));
            if (ctrl) sequence.Add(KeyInput(0xA2, true));
            if (shift) sequence.Add(KeyInput(0xA0, true));
            Send(sequence.ToArray());
        }
    }

    /// <summary>Ctrl+Alt+Del cannot be synthesised by SendInput; report it instead of failing silently.</summary>
    public static bool IsSecureAttention(string? code)
        => code is "Delete" && IsDown(0xA2) && IsDown(0xA4);

    private static bool IsExtended(ushort vk) => vk switch
    {
        0x21 or 0x22 or 0x23 or 0x24 or 0x25 or 0x26 or 0x27 or 0x28 => true, // nav cluster
        0x2D or 0x2E => true,                                                  // insert / delete
        0x5B or 0x5C or 0x5D => true,                                          // win / menu
        0x6F => true,                                                          // numpad divide
        0x0D => false,
        0x90 => true,                                                          // num lock
        0x2C => true,                                                          // print screen
        0xA3 or 0xA5 => true,                                                  // right ctrl / right alt
        _ => false
    };

    private static double Clamp01(double v) => v < 0 ? 0 : v > 1 ? 1 : v;
}
