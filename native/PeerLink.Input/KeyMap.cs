namespace PeerLink.Input;

/// <summary>
/// Maps DOM <c>KeyboardEvent.code</c> values and characters to Windows virtual-key codes.
/// </summary>
internal static class KeyMap
{
    /// <summary>DOM code -> virtual key, for keys that are not printable characters.</summary>
    public static bool TryFromDomCode(string? code, out ushort vk)
    {
        vk = 0;
        if (string.IsNullOrEmpty(code)) return false;

        switch (code)
        {
            case "Backspace": vk = 0x08; return true;
            case "Tab": vk = 0x09; return true;
            case "Enter": vk = 0x0D; return true;
            case "NumpadEnter": vk = 0x0D; return true;
            case "ShiftLeft": vk = 0xA0; return true;
            case "ShiftRight": vk = 0xA1; return true;
            case "ControlLeft": vk = 0xA2; return true;
            case "ControlRight": vk = 0xA3; return true;
            case "AltLeft": vk = 0xA4; return true;
            case "AltRight": vk = 0xA5; return true;
            case "MetaLeft": vk = 0x5B; return true;
            case "MetaRight": vk = 0x5C; return true;
            case "ContextMenu": vk = 0x5D; return true;
            case "Escape": vk = 0x1B; return true;
            case "Space": vk = 0x20; return true;
            case "CapsLock": vk = 0x14; return true;
            case "NumLock": vk = 0x90; return true;
            case "ScrollLock": vk = 0x91; return true;
            case "PrintScreen": vk = 0x2C; return true;
            case "Pause": vk = 0x13; return true;
            case "Insert": vk = 0x2D; return true;
            case "Delete": vk = 0x2E; return true;
            case "Home": vk = 0x24; return true;
            case "End": vk = 0x23; return true;
            case "PageUp": vk = 0x21; return true;
            case "PageDown": vk = 0x22; return true;
            case "ArrowLeft": vk = 0x25; return true;
            case "ArrowUp": vk = 0x26; return true;
            case "ArrowRight": vk = 0x27; return true;
            case "ArrowDown": vk = 0x28; return true;
            case "NumpadAdd": vk = 0x6B; return true;
            case "NumpadSubtract": vk = 0x6D; return true;
            case "NumpadMultiply": vk = 0x6A; return true;
            case "NumpadDivide": vk = 0x6F; return true;
            case "NumpadDecimal": vk = 0x6E; return true;
            case "AudioVolumeMute": vk = 0xAD; return true;
            case "AudioVolumeDown": vk = 0xAE; return true;
            case "AudioVolumeUp": vk = 0xAF; return true;
            case "MediaTrackNext": vk = 0xB0; return true;
            case "MediaTrackPrevious": vk = 0xB1; return true;
            case "MediaStop": vk = 0xB2; return true;
            case "MediaPlayPause": vk = 0xB3; return true;
        }

        if (code.Length == 4 && code.StartsWith("Key", StringComparison.Ordinal))
        {
            char c = code[3];
            if (c >= 'A' && c <= 'Z') { vk = (ushort)c; return true; }
        }

        if (code.StartsWith("Digit", StringComparison.Ordinal) && code.Length == 6)
        {
            char c = code[5];
            if (c >= '0' && c <= '9') { vk = (ushort)c; return true; }
        }

        if (code.StartsWith("Numpad", StringComparison.Ordinal) && code.Length == 7)
        {
            char c = code[6];
            if (c >= '0' && c <= '9') { vk = (ushort)(0x60 + (c - '0')); return true; }
        }

        if (code.Length >= 2 && code[0] == 'F' && int.TryParse(code.AsSpan(1), out int fn) && fn >= 1 && fn <= 24)
        {
            vk = (ushort)(0x70 + (fn - 1));
            return true;
        }

        return false;
    }

    /// <summary>Printable character -> virtual key, using the layout-aware VkKeyScan mapping.</summary>
    public static bool TryFromChar(char ch, out ushort vk, out bool shift, out bool ctrl, out bool alt)
    {
        vk = 0;
        shift = ctrl = alt = false;

        // Fast path for plain ASCII letters/digits - avoids layout surprises.
        if (ch >= 'a' && ch <= 'z') { vk = (ushort)(ch - 32); return true; }
        if (ch >= 'A' && ch <= 'Z') { vk = (ushort)ch; shift = true; return true; }
        if (ch >= '0' && ch <= '9') { vk = (ushort)ch; return true; }

        short scan = (short)Native.VkKeyScanW(ch);
        if (scan == -1) return false;
        int v = scan & 0xFF;
        int state = (scan >> 8) & 0xFF;
        if (v == 0) return false;
        vk = (ushort)v;
        shift = (state & 1) != 0;
        ctrl = (state & 2) != 0;
        alt = (state & 4) != 0;
        return true;
    }
}
