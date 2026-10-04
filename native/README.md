# PeerLink native input helper

`PeerLink.Input.exe` is the piece that turns "screen viewing" into real **remote control**.

It is a tiny .NET 8 console app (no GUI, no background service, no installer hooks) that:

1. Starts, hides its console window, and prints one `{"type":"ready", ...}` line on stdout.
2. Then reads **newline-delimited JSON commands** from stdin until stdin closes, injecting each
   one with the Win32 `SendInput` API.

PeerLink (the Electron app) spawns exactly one instance per outgoing-control session and kills it
when the session ends, so nothing of ours keeps running in the background afterwards.

## Why a separate process?

`webContents.sendInputEvent` only works inside our own Electron window, and `robotjs`/`nut.js`
need native compilation. A small self-contained helper is faster, auditable, and keeps the
privileged surface tiny.

## Command reference

| Command | Effect |
| --- | --- |
| `{"t":"move","x":0.5,"y":0.25}` | Move pointer; `x`/`y` are normalised to the whole virtual desktop (all monitors) |
| `{"t":"button","b":"left","down":true,"clicks":1}` | `left`/`right`/`middle`/`back`/`forward` |
| `{"t":"wheel","dy":-3,"dx":0}` | Scroll wheel; `120` units per notch is applied internally |
| `{"t":"key","code":"KeyA","down":true}` | Keyboard by DOM `KeyboardEvent.code` |
| `{"t":"key","code":"F5","vk":116,"down":true}` | Or by raw Windows virtual-key code |
| `{"t":"text","s":"héllo 🙂"}` | Type a string; falls back to Unicode packets when no layout mapping exists |
| `{"t":"clipboard-set","s":"..."}` / `{"t":"clipboard-get","seq":1}` | Clipboard read/write |
| `{"t":"clipboard-poll"}` | Emits `{"type":"clipboard"}` only when the clipboard actually changed |
| `{"t":"screen"}` | Re-reads virtual desktop metrics |
| `{"t":"ping","seq":1}` | Liveness check |

Responses: `{"type":"ready"|"ok"|"error"|"warn"|"pong"|"clipboard"|"bye", ...}`.

## Known limitations

* **Ctrl+Alt+Del** cannot be synthesised. Windows only accepts the Secure Attention Sequence from
  real hardware; the helper reports `secure-attention` instead of pretending it worked.
* Windows **UAC prompts** appear on the secure desktop. Screen capture shows a black frame and
  injected input is ignored while a consent prompt is up. This is a Windows security boundary, not
  a PeerLink bug.
* If the host app runs elevated, input reaches elevated windows; otherwise Windows' UIPI blocks
  synthetic input into higher-integrity windows.

## Build

```powershell
npm run build:helper
```

or directly:

```powershell
dotnet publish native/PeerLink.Input/PeerLink.Input.csproj -c Release -o resources/input
```

Requires the .NET 8 **SDK** to build; the produced executable needs nothing installed on the
machine that runs it.

The project is set up as **self-contained + single-file + trimmed**, which is why the result is
~10 MB instead of ~64 MB. Two properties of this project are load-bearing and easy to break:

* **JSON output is hand-written** (`Json` in `Program.cs`). The reflection-based
  `JsonSerializer.Serialize` is not trim-safe: the linker cannot see anonymous-type properties
  and strips them, so every reply would silently become `{}`. `TreatWarningsAsErrors` is on, so
  reintroducing a reflection dependency fails the build instead of shipping a mute helper.
* **`IncludeNativeLibrariesForSelfExtract`** is on, so the single file unpacks its native
  libraries to a temp directory on first run. That costs ~240 ms once; the app allows 5 s.

Verify a build end to end by piping commands in and checking the replies, including a
clipboard round-trip with quotes and newlines to exercise the escaping.
