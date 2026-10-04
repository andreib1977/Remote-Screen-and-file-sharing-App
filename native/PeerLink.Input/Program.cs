using System.Text;
using System.Text.Json.Nodes;

namespace PeerLink.Input;

/// <summary>
/// Minimal JSON output writer.
///
/// Hand-rolled on purpose. The reflection-based <c>JsonSerializer.Serialize</c> is not
/// trim-safe: the linker cannot see the properties of anonymous types and strips them, which
/// would silently turn every reply into <c>{}</c>. Using this removes the last reflection
/// dependency, which is what allows the helper to ship trimmed and self-contained (~12 MB
/// instead of ~64 MB), so the app needs no .NET runtime installed on the target machine.
///
/// The reply shapes are tiny and fixed, so a serializer would earn nothing here.
/// </summary>
internal static class Json
{
    /// <summary>Escapes a string for use inside JSON double quotes.</summary>
    public static string Escape(string? value)
    {
        if (string.IsNullOrEmpty(value)) return string.Empty;
        var builder = new StringBuilder(value.Length + 8);
        foreach (char c in value)
        {
            switch (c)
            {
                case '"': builder.Append("\\\""); break;
                case '\\': builder.Append("\\\\"); break;
                case '\b': builder.Append("\\b"); break;
                case '\f': builder.Append("\\f"); break;
                case '\n': builder.Append("\\n"); break;
                case '\r': builder.Append("\\r"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    if (c < 0x20) builder.Append("\\u").Append(((int)c).ToString("x4"));
                    else builder.Append(c);
                    break;
            }
        }
        return builder.ToString();
    }

    /// <summary>A quoted, escaped JSON string.</summary>
    public static string Str(string? value) => "\"" + Escape(value) + "\"";

    /// <summary>The virtual-desktop geometry, as reported in `ready` and `screen`.</summary>
    public static string Screen(Injector injector) =>
        $"{{\"x\":{injector.VirtualX},\"y\":{injector.VirtualY},\"width\":{injector.VirtualWidth},\"height\":{injector.VirtualHeight}}}";
}

/// <summary>
/// PeerLink input helper.
///
/// Persistent worker process: PeerLink spawns it once per session and writes newline
/// delimited JSON commands to stdin. Keeping the process alive is what makes remote control
/// feel native - spawning a process per mouse move would be unusable.
///
/// Output is newline delimited JSON on stdout ("ready", "ok", "error", "warn", "clipboard",
/// "pong", "bye"). See native/README.md for the full command reference.
/// </summary>
internal static class Program
{
    private static StreamWriter _out = null!;

    private static void Reply(string json)
    {
        lock (_out)
        {
            _out.Write(json);
            _out.Write('\n');
            _out.Flush();
        }
    }

    private static int Main()
    {
        // The helper is a child process; it must never flash a console window.
        IntPtr console = Native.GetConsoleWindow();
        if (console != IntPtr.Zero) Native.ShowWindow(console, 0);

        _out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = false };
        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));

        Injector injector;
        try
        {
            injector = new Injector();
        }
        catch (Exception ex)
        {
            Reply($"{{\"type\":\"error\",\"message\":{Json.Str("injector-init-failed: " + ex.Message)}}}");
            return 2;
        }

        Reply($"{{\"type\":\"ready\",\"pid\":{Environment.ProcessId},\"screen\":{Json.Screen(injector)}}}");

        string? lastClipboard = null;
        string? line;
        while ((line = stdin.ReadLine()) != null)
        {
            if (line.Length == 0) continue;

            try
            {
                JsonNode? node = JsonNode.Parse(line);
                if (node is not JsonObject cmd) continue;
                string kind = (string?)cmd["t"] ?? "";

                switch (kind)
                {
                    case "move":
                        injector.MouseMove(Num(cmd["x"]), Num(cmd["y"]));
                        break;

                    case "button":
                        injector.MouseButton((string?)cmd["b"], (bool?)cmd["down"] ?? false, (int?)cmd["clicks"] ?? 1);
                        break;

                    case "wheel":
                        injector.Wheel((int?)cmd["dx"] ?? 0, (int?)cmd["dy"] ?? 0);
                        break;

                    case "key":
                        {
                            string? code = (string?)cmd["code"];
                            if (Injector.IsSecureAttention(code) && (bool?)cmd["down"] == true)
                            {
                                Reply(
                                    "{\"type\":\"warn\",\"code\":\"secure-attention\",\"message\":" +
                                    Json.Str("Ctrl+Alt+Del must be sent with the host's own keyboard (Windows blocks synthetic SAS).") +
                                    "}"
                                );
                                break;
                            }
                            int? vk = (int?)cmd["vk"];
                            injector.Key(code, vk, (bool?)cmd["down"] ?? true);
                            break;
                        }

                    case "text":
                        injector.Text((string?)cmd["s"] ?? "");
                        break;

                    case "clipboard-set":
                        if (Native.SetClipboardText((string?)cmd["s"] ?? ""))
                        {
                            lastClipboard = (string?)cmd["s"];
                            Reply("{\"type\":\"ok\",\"op\":\"clipboard-set\"}");
                        }
                        else
                        {
                            Reply("{\"type\":\"error\",\"op\":\"clipboard-set\",\"message\":\"clipboard busy\"}");
                        }
                        break;

                    case "clipboard-get":
                        {
                            string? text = Native.GetClipboardText();
                            lastClipboard = text;
                            Reply($"{{\"type\":\"clipboard\",\"s\":{Json.Str(text)},\"seq\":{(long?)cmd["seq"] ?? 0}}}");
                            break;
                        }

                    case "clipboard-poll":
                        {
                            string? text = Native.GetClipboardText();
                            if (text != lastClipboard)
                            {
                                lastClipboard = text;
                                Reply($"{{\"type\":\"clipboard\",\"s\":{Json.Str(text)},\"changed\":true}}");
                            }
                            break;
                        }

                    case "ping":
                        Reply($"{{\"type\":\"pong\",\"echo\":{(long?)cmd["seq"] ?? 0}}}");
                        break;

                    case "screen":
                        {
                            var fresh = new Injector();
                            Reply($"{{\"type\":\"screen\",\"screen\":{Json.Screen(fresh)}}}");
                            break;
                        }

                    case "quit":
                        Reply("{\"type\":\"bye\"}");
                        return 0;

                    default:
                        Reply($"{{\"type\":\"error\",\"message\":{Json.Str("unknown-command:" + kind)}}}");
                        break;
                }
            }
            catch (Exception ex)
            {
                Reply($"{{\"type\":\"error\",\"message\":{Json.Str(ex.Message)}}}");
            }
        }

        return 0;
    }

    private static double Num(JsonNode? node)
    {
        if (node is null) return 0;
        try
        {
            return node.GetValue<double>();
        }
        catch
        {
            return 0;
        }
    }
}
