# PeerLink

Minimal remote desktop and file sharing for Windows. Share a screen, take control of it,
and move files of any size — directly between the two machines, with no time limit and no
account. Available in **English** and **Română**.

```
┌─ your machine ─┐          ┌─ their machine ─┐
│  PeerLink host │ ⇄ P2P ⇄  │ PeerLink viewer │
└────────────────┘          └─────────────────┘
        └──── rendezvous only ────┘
```

---

## Get it running

**From a packaged build:** run `PeerLink-<version>-setup.exe`. It installs per-user (no admin
prompt) and creates a **desktop shortcut** plus a Start Menu entry.

**From this repository:** the installer is not committed (build artifacts are ignored), so
build it first:

```powershell
npm install
npm run build      # app + remote-control helper + bundled signalling server
npm run package    # -> release/PeerLink-<version>-setup.exe and -portable.exe
npm start          # or just run it straight from source
```

Then:

1. **Choose your language** at the start of setup: *Language / Limbă* offers **English** and
   **Română**, and the rest of the wizard follows your choice.
2. Double-click the **PeerLink** shortcut. The app opens already in the language you picked.

That is the whole startup sequence. **The app starts its own signalling server**, so there is
no separate server step and no ordering to get right:

* PeerLink first checks whether a server already answers on port 8787 — on this machine *or*
  on your LAN. If one does, it uses it and starts nothing new.
* Otherwise it launches the bundled server as a detached, windowless process (using
  Electron's own runtime, so nothing extra needs installing) and waits until it is healthy
  **before** opening the window.
* The server keeps running after you close the window, so the person connected to your
  machine is not cut off mid-session.

A **portable** build is produced too: same app, no installation and no desktop shortcut, for
running straight off a USB stick.

**Windows SmartScreen** will warn about an unsigned app the first time ("Windows protected
your PC" → *More info* → *Run anyway*). Code signing needs a paid certificate; the app makes
no network connections except to your own signalling server and the peer you connect to.

### Connecting two machines

1. On the machine to be seen: **Share this PC → Start sharing**.
2. PeerLink shows the **server address to send** alongside the session code and password. On
   your LAN that is this machine's own address, e.g. `ws://192.168.1.20:8787`.
3. On the other machine: **Settings → Signalling server** → paste that address → **Save**
   (remembered from then on). Then **Connect** with the code and password.

Both machines must use the **same** signalling server. Whoever starts sharing first is the
natural place for it; for a permanent/shared server see
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

If the Connect screen reports the server is unreachable, it offers a **Start server on this
PC** button, so you never have to go looking for a script.

### Changing the language later

**Settings → Limbă / Language** switches between English and Română and applies immediately —
no restart. The choice is stored in your profile, so it survives updates. A fresh install
takes the language picked in the installer, and a machine that has never chosen one falls back
to the Windows display language.

---

## What it does

| | |
| --- | --- |
| **English / Română** | Chosen during setup, remembered, and changeable any time in Settings. |
| **Two devices per session** | Exactly one host and one viewer. Enforced by the server, not the UI — see below. |
| **Screen sharing** | Full desktop, any monitor, 15/30/60 fps, optional system audio. |
| **Remote control** | Mouse, keyboard, wheel and clipboard — granted per session, revocable at any time. |
| **File transfer** | Both directions over a WebRTC data channel. **No size limit**, resumable, folders keep their structure. |
| **No time limit** | Sessions stay up until you stop them. |
| **Small UI** | Three screens: Connect, Share this PC, Settings. |

Everything except the initial handshake is **peer to peer**. The server never sees your
screen, your files, or your keystrokes.

## The two-device rule

A session is **one host + one viewer, and nothing else**. This is enforced server-side, so it
cannot be bypassed by a modified client:

* The server's join handler holds a single viewer slot per session. There is no code path
  that puts a third socket into a room.
* When a second viewer joins with the right code and password, it takes the slot, the
  previous viewer is sent `replaced`, and **its socket is then closed** — it cannot keep
  feeding SDP/ICE into a host that is already negotiating with its successor.
* Every viewer slot has a number that only moves forward. Signals stamped with an old slot
  are refused by the server (`stale-viewer`) and ignored by the host, so a replaced viewer's
  late packets can never disturb the new connection.
* A replaced viewer's in-flight file transfer is abandoned and its partial file is *not*
  published under the finished name.
* The freed slot can be taken again later; the session stays alive for its host.

If two people need to watch the same machine at once, run two sessions from two hosts, or
use separate accounts/sessions — PeerLink deliberately will not multiplex viewers.

> Ordering note: the takeover is last-writer-wins, exactly like a phone line. Anyone who has
> the code **and** the password can take the slot. Keep both private, and treat a takeover
> you did not expect as a reason to stop sharing and change the password.

---

## Building from source

```powershell
npm install
npm run build          # main + preload + renderer + input helper + bundled server
npm start              # run from source
npm run package        # -> release/PeerLink-<version>-setup.exe and -portable.exe
```

`npm start` uses the same bundled-server logic, so it is also a single command. To run a
server by hand instead (for a central server, or debugging):

```powershell
npm run signal                      # listens on 0.0.0.0:8787
npm run signal -- --port 9000
```

`start-peerlink.bat` and `start-server.bat` remain for source checkouts.

### Using PeerLink

1. On the machine that will be seen: **Share this PC → Start sharing**.
2. Read the **six digit code** and the **password** to the other person.
3. On the other machine: **Connect**, type both, press **Connect**.
4. To control the remote machine: flip **Allow remote control** on the host, then press
   **Request control** in the viewer and **Allow** on the host.
5. Drag files onto the remote screen (or use **Send files… / Send folder…**) to transfer.

To stop, press **Stop sharing**. The input helper exits with the session; the signalling
server keeps running so a reconnecting viewer is not locked out the moment you close a window.

---

## Features in detail

### Remote control

* Control is **off by default** and doubly gated: the host must enable *Allow remote
  control*, and then explicitly approve the viewer's request. Either side can revoke.
* Press **Ctrl+Alt+Shift+Q** in the viewer to release control instantly — the viewer's
  keyboard stops being forwarded the moment you touch it.
* Input is injected by a small self-contained helper (`resources/input/PeerLink.Input.exe`,
  10 MB, no runtime needed) that is spawned only while control is actually granted, and
  killed when the session ends.
* **Ctrl+Alt+Del cannot be sent** and UAC prompts cannot be answered. That is a Windows
  security boundary, not a PeerLink bug (see `native/README.md`).

### File transfer

* Drag and drop onto the remote screen, or use the pickers. Folders are transferred with
  their structure.
* **Any size**: files are streamed chunk by chunk from disk, with the transfer window
  bounded to a few megabytes. A 100 GB file uses the same memory as a 100 KB one.
* **Resumable**: an interrupted transfer keeps its partial file and continues from where it
  stopped when retried, because every chunk carries its own file offset.
* Incoming files land in **Settings → Save received files to** (default
  `Downloads\PeerLink`), written to a `.part` file and renamed into place only when complete.
* Received names are sanitised, so a hostile sender cannot escape the download folder with
  `..\..\` style names.

### Viewing

* Zoom with the `−` / `+` buttons or Ctrl+wheel; **Fit to window** resets.
* Toolbar shows live fps, bitrate and round-trip time.
* Fullscreen button, hideable toolbar, and a `Live` / session-time indicator.
* Clipboard text syncs both ways while control is granted.

---

## Requirements

* **Windows 10/11 x64.** Nothing else — the installer bundles the app, the signalling server
  and the remote-control helper, and needs no .NET, no Node.js and no admin rights.
* **.NET 8 SDK** only if you want to rebuild the input helper from source.

Both machines need the same signalling server (see above), and both need a network path to
each other for the peer-to-peer connection.

---

## Tests

```powershell
npm test              # unit tests: framing, transfer engine, backpressure, resume, server limits, translations
npm run typecheck     # strict TypeScript over main, preload, renderer and shared code
npm run ui:check      # launches the app and verifies all views render, in English AND Romanian
npm run test:e2e      # two real app instances: connect, negotiate, transfer, verify checksum
npm run test:handover # three real app instances: proves the two-device rule under load
```

`npm run test:e2e` starts a real signalling server, two real PeerLink instances, connects
them over WebRTC and pushes a file across, then compares SHA-256 of both ends. Use `--size`
to change the payload:

```powershell
node scripts/e2e-smoke.js --size 2000   # 2 GB
```

`npm run test:handover` is the one that guards the session limit. It runs **three** app
instances: viewer A connects and starts a large transfer, viewer B then joins with the same
code, and the test asserts that B inherits a working session (its own transfer arrives with a
matching checksum) while A is evicted, its transfer is abandoned, and no half-written file is
published. It then adds a fourth device to confirm the session never holds more than two.

`npm run ui:check` seeds `settings.json` with each language and re-runs the whole render check
per language, so a broken translation fails the build rather than reaching a Romanian user.
`tests/i18n.test.ts` additionally proves the Romanian dictionary has every English key, the
same `{placeholders}`, and no untranslated English leaking into Romanian sentences.

Verified on this machine: 42/42 unit tests, all three views rendering in both languages, a
1 GB transfer with a matching SHA-256 at ~18 MB/s over loopback, and a clean three-device
handover where the evicted viewer's partial file never appeared as complete.

---

## Documentation

* [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, protocol, security model,
  troubleshooting and the design decisions behind them.
* [`native/README.md`](native/README.md) — the input helper and its command reference.
* [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — running the server for real users, including
  when you need a TURN relay.

---

## Honest limitations

* **Two devices per session, by design.** A second viewer takes the session over instead of
  joining it (see [The two-device rule](#the-two-device-rule)).
* **Sandboxed remote apps** (elevated windows, UAC, the lock screen) are visible as a black
  frame and cannot be driven, because Windows does not let a non-elevated process inject
  input there.
* **Strict NATs on both sides** can prevent a direct connection. On a LAN or typical home
  router it works as-is; otherwise configure a TURN server
  (see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)).
* **Windows hosts only** today. The renderer and server are portable; the input helper needs
  a macOS/Linux equivalent.

---

## License

MIT.
