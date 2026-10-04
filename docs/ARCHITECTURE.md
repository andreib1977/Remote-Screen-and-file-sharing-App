# PeerLink architecture

## Components

```
PeerLink/
├─ src/main/            Electron main process (privileged)
│  ├─ main.ts           window, display-media handler, IPC wiring
│  ├─ preload.ts        the only bridge exposed to the UI (contextIsolation on)
│  ├─ file-bridge.ts    all filesystem access: pick, read, write, atomic rename
│  ├─ input-helper.ts   owns the native input process
│  ├─ settings.ts       settings + recent sessions (JSON in userData)
│  ├─ local-server.ts   starts/adopts the bundled rendezvous server
│  └─ autopilot.ts      scripted-run hooks, inert unless PEERLINK_AUTOPILOT=1
├─ src/renderer/        UI (React) + session logic
│  ├─ lib/peer-connection.ts   RTCPeerConnection, control + file data channels, stats
│  ├─ lib/signaling-client.ts  WebSocket client for the rendezvous server
│  ├─ lib/host-session.ts      hosting: capture, control gating, transfers
│  ├─ lib/viewer-session.ts    viewing: render, input capture, transfers
│  ├─ lib/input-router.ts      remote input -> native helper
│  ├─ lib/file-bridge.ts       transfer engine <-> Electron IPC adapters
│  └─ ui/                      App, HostView, ViewerSurface, SettingsView, …
├─ src/shared/          code used by both sides, no Electron imports
│  ├─ protocol.ts       wire message types, quality settings
│  ├─ input-protocol.ts input commands, key-forwarding rules, panic combo
│  ├─ i18n/             en.ts (source of truth), ro.ts, language registry, format()
│  └─ transfer/         framing.ts (chunk format) + manager.ts (transfer engine)
├─ server/signal.js     rendezvous server (bundled into the app by `npm run build:server`)
├─ native/PeerLink.Input/  C# input injection helper
└─ scripts/             e2e-smoke.js, e2e-handover.js, ui-check.js
```

The split is deliberate: `src/shared` has no Electron or DOM imports, so the transfer
engine and protocol are unit-testable in plain Node.

## Single-launch startup

"Start the server, then start the app" is a bad user interface, so the app owns both halves:

```
app.whenReady()
  └─ ensureLocalServer(8787)
       ├─ probe http://127.0.0.1:8787/health    ─┐
       ├─ probe http://<each LAN address>:8787   │ any hit -> adopt it, spawn nothing
       │                                         ─┘           (url = the LAN form)
       └─ no hit -> spawn(process.execPath, [resources/server/signal.js],
                          { ELECTRON_RUN_AS_NODE: '1', detached: true, windowsHide: true })
                    -> poll /health until healthy (15 s budget)
  └─ createWindow()
```

Details that matter:

* **`ELECTRON_RUN_AS_NODE=1`** makes Electron's own binary run as plain Node, so the server
  needs no extra runtime and the user needs no Node install. `detached: true` +
  `stdio: 'ignore'` + `windowsHide: true` gives a background process with no console flash
  that survives the window being closed.
* **The server is bundled, not referenced.** esbuild inlines `server/signal.js` into
  `resources/server/signal.js`, because a packaged app has no `node_modules` to resolve `ws`
  from — the un-bundled file silently died in the packaged build until this was fixed.
* **Probing the LAN address, not just loopback**, is what stops two machines from each
  starting a private server and being unable to see each other: the second machine finds the
  first one's server through the LAN address and adopts it.
* **The health probe gates the window.** Otherwise the app would open and the renderer's
  first WebSocket attempt would race the server's startup.
* **The server is never stopped on quit.** `stopOwnedServer()` exists but is deliberately not
  wired to `before-quit`: the viewer on the other machine may still be connected, and a
  server that vanishes with a window is worse than one idle process. The next launch probes,
  finds it, and reuses it rather than starting a duplicate.

## Session lifecycle

```
host                         server                        viewer
 │  host{passwordHash} ────────▶ │                              │
 │  ◀───────────── host-ok{code} │                              │
 │                               │ ◀────── join{code,hash} ───── │
 │                               │ ── viewer-joined ──▶ │        │
 │  createOffer (video+audio+    │                     │        │
 │  ctl+file data channels)      │                     │        │
 │  ─────────── signal{offer} ──▶│ ─────────── offer ──────────▶│
 │  ◀───────── signal{answer} ───│ ◀───────── answer ───────────│
 │  ◀════════ trickle ICE both ways (relayed) ═════════════════▶│
 │                                                              │
 │  ◀════════ DTLS/SRTP media + SCTP data channels ════════════▶│
```

1. The **host** registers a SHA-256 hash of its password; the server answers with a session
   code drawn from `23456789` (no `0`/`1`, so it survives being read aloud).
2. The **viewer** sends the same style of hash with its join request; the server compares
   them with `crypto.timingSafeEqual`.
3. **The host creates both data channels and then offers.** This is load-bearing: a data
   channel only appears in the SDP of the peer that creates it, so a viewer that offers
   first would produce a session with no application section and no working channels.
   (This bug is exactly what `npm run test:e2e` caught during development.)
4. Media and both data channels then ride one DTLS/SCTP association, bundled.

## Localisation (English / Română)

```
installer (NSIS)                 app
  language picker                  settings.json
  $LANGUAGE = 1033 | 1048   ──▶    language: "en" | "ro"
  HKCU\Software\PeerLink    ──▶      │
    Language = en | ro               ├─ React tree  → LanguageProvider → useT()
                                     └─ session code → translate() (out-of-tree)
```

* **`src/shared/i18n/en.ts` is the source of truth.** `Translations` is derived from it, so
  `ro.ts` is typed as `Translations` and a missing or misspelled key is a *compile* error, not
  a blank label at runtime. `tests/i18n.test.ts` then covers what types cannot: empty strings,
  `{placeholder}` drift between languages, and English words left inside Romanian sentences.
* **Two translators, one dictionary.** Components use `useT()` (React context, re-renders on
  change). The session classes raise toasts from async callbacks and cannot call hooks, so
  they use the module-level `translate()` that `LanguageProvider` keeps in sync.
* **The installer's answer is read from the registry** (`HKCU\Software\PeerLink\Language`)
  once, on first run, and written into `settings.json`. The registry is read with `reg.exe`
  rather than a native module: one process spawn on first run is cheaper than a dependency.
  A portable build has no registry value, so it falls back to the Windows display language.
* **Changing the language needs no reload**: Settings saves the value and dispatches a
  `peerlink:language` event that `Root` listens for, which swaps the provider's language.
* The installer needs two fixes that are easy to miss, both documented in
  `scripts/patch-nsis-romanian.js`: NSIS 3.0.4.1's `Romanian.nsh` is missing five
  `MULTIUSER` strings that every other language file defines, and electron-builder compiles
  with `/WX`, so each missing string is a hard build failure. `npm run package` patches the
  cached language file (idempotently, and only for what is genuinely absent).

## Peer connection lifecycle

One `RTCPeerConnection` per viewer slot. On a takeover the host closes the old connection and
builds a new one, which makes two settings non-obvious:

* **`iceCandidatePoolSize: 0`.** A pool pre-gathers a candidate at construction, which only
  pays off when you build one connection and keep it. We churn connections: the previous one
  is closed microseconds after the new one is created, so the pooled candidate refers to a
  socket being torn down. The observed failure was a peer connection that gathered *nothing*,
  never left `new`, and left the new viewer stuck on "negotiating" — intermittently, roughly
  one run in three. Turning the pool off makes each connection gather fresh candidates after
  its predecessor is gone.
* **Signals are stamped with the slot their connection was built for**, not with the live
  epoch, so the server can drop the previous connection's late ICE (see below).

`peer-connection.ts` and both session classes emit a compact trace through the autopilot log
(`PEERLINK_AUTOPILOT=1` only, so it costs one no-op call in normal use). It is kept
deliberately: it records pc ids, state transitions, candidate counts and slot decisions, which
is what turned "the handover sometimes fails" into the two concrete bugs above.

## The two-device invariant
A session contains **exactly one host and one viewer**. It is enforced at three layers, which
is what makes it a guarantee rather than a UI convention:

1. **Server, structurally.** A room holds one `host` socket and one `viewer` socket. The join
   handler has no branch that adds a second viewer; a new viewer takes the slot instead.

   ```js
   if (room.viewer && room.viewer !== ws) { /* evict: notify, then close */ }
   room.seq += 1;            // this viewer's slot number, only ever moves forward
   room.viewer = ws;
   ```

   The evicted socket is told `replaced` and then **closed**, so it cannot keep talking to a
   host that is already negotiating with its successor.

2. **Server, per message.** Every signal is stamped with the sender's slot. A socket whose
   slot is no longer the room's current slot gets `stale-viewer` and its payload is dropped
   before it reaches the host. `leave-room` from a replaced viewer is ignored too, so its
   late goodbye cannot tear down the session its successor is using.

3. **Host, defensively.** The host tracks the highest slot it has seen (`epoch`). A signal
   below it is discarded without touching the peer connection. On `viewer-joined` the host
   tears the old `RTCPeerConnection` down *before* building the new one, clears the transfer
   list, and resets control grants — so a stale ICE candidate from the previous viewer can
   never land in the new negotiation.

Slot numbers identify a viewer *session*, not a count, so they only increase: host → 1,
replacement → 2, and after a viewer leaves the next one gets 3. That is what lets the host
distinguish "the viewer I am talking to" from "the viewer I just replaced".

The resulting behaviour, verified by `npm run test:handover` with three real app instances:

| Event | Result |
| --- | --- |
| Viewer B joins while A is transferring | B gets the slot, A is told `replaced` and disconnected |
| A's in-flight transfer | Abandoned, marked failed, no finished-looking file on disk |
| A's late SDP/ICE | Refused by the server (`stale-viewer`), ignored by the host |
| B's own transfer on the inherited session | Completes, checksum matches |
| A fourth device | Takes the slot from B; the session never exceeds two devices |

## Wire protocol

* **`ctl` channel — JSON text.** `ctl` is created with the offer and is used for the
  session description, control requests, clipboard, notices and all *file transfer
  bookkeeping* (`file-offer`, `file-accept`, `file-progress`, `file-done`, `file-cancel`).
* **`file` channel — framed binary.** 64 KiB payloads, self-describing header:

```
 0      2      3     4        4+N      12+N     16+N
 ├──────┼──────┼─────┼────────┼─────────┼────────┼─────────┤
 │ magic│ ver  │idLen│ id     │ offset  │ length │ payload │
 │ F1 1E│ 0x01 │ 1B  │ UTF-8  │ uint64  │ uint32 │         │
 └──────┴──────┴─────┴────────┴─────────┴────────┴─────────┘
```

Two properties matter:

* **The offset lives in the frame**, not in the order of arrival. Chunks from concurrent
  transfers interleave freely, duplicates are dropped, and a resume can start anywhere.
* **A gap is detected, not ignored.** If a chunk arrives with an offset ahead of what has
  been written, the receiver stops and reports the real byte count instead of producing a
  silently corrupt file.

`handleChunk` is serialised through an internal promise chain: a data channel delivers in
order, but handling a frame is `async` (it hits the disk), and two overlapping handlers can
otherwise interleave their awaits and be applied out of order.

### Why 64 KiB chunks

Chromium caps SCTP message size (typically 256 KiB). A frame above that limit does not get
truncated — the channel dies with `Failure to send data`, taking the session's file transfer
with it. 64 KiB is the portable ceiling; throughput comes from pipelining, not from making
individual frames huge.

### Flow control

The sender keeps a bounded window:

```
while (nextOffset < size) {
  if (bufferedAmount > MAX_IN_FLIGHT) await drain(20ms);
  send(encodeChunk(id, nextOffset, await source.read(nextOffset, 64KiB)));
}
```

`MAX_IN_FLIGHT_BYTES` is 8 MiB, `bufferedAmountLowThreshold` is 1 MiB, and the receiver
acknowledges at most every 0.5 % of progress. That keeps a 1 TB transfer inside a few
megabytes of RAM while saturating a fast link. `tests/transfer.test.ts` asserts the peak
buffered amount stays near the configured budget.

## Security model

| Concern | How it is handled |
| --- | --- |
| Session discovery | Six-digit code, ~260 k combinations, regenerated every session. |
| Authentication | Host and viewer both send `SHA-256("peerlink:v1:" + password)`; the server compares with `timingSafeEqual` and never sees the plaintext. |
| Brute force | Eight join attempts per IP per minute, then the socket is refused. |
| Wire encryption | WebRTC DTLS — media over SRTP, data over SCTP over DTLS. Both ends verify certificates during the handshake. |
| Content | The server relays SDP and ICE only. Screen, audio, keystrokes and file bytes are never sent to it. |
| Renderer isolation | `contextIsolation: true`, `nodeIntegration: false`, a strict CSP, and one hand-written preload API. |
| Filesystem | Only the main process touches disk, through a fixed set of IPC handlers. Received names are sanitised and cannot escape the download directory. |
| Remote input | Off by default, requires host opt-in *and* per-session approval, revocable instantly, and injected by a helper that only exists while granted. |
| Attack surface | Three dependencies in the app (`ws` ships in the server); no analytics, no auto-update, no external CDN. |

The one thing the server *can* do is lie about identities, because there is no
out-of-band fingerprint check in the UI yet. On a LAN you control the server, which removes
even that.

## Networking notes

* Default ICE servers: Google's public STUN. Enough for a LAN or a typical home router on
  one side.
* Both peers behind symmetric NATs need a TURN relay; set
  `PEERLINK_TURN_URLS`/`PEERLINK_TURN_USER`/`PEERLINK_TURN_PASS` on the server and it hands
  the credentials to clients automatically.
* The host caps outbound video at 12 Mbit/s (30/60 fps) or 6 Mbit/s (15 fps) so a shared 4K
  screen cannot saturate an uplink.

## Testing strategy

| Layer | Tool | What it proves |
| --- | --- | --- |
| Framing | `vitest` | Round-trips, >4 GiB offsets, corrupt frames rejected, gap detection, duplicates |
| Transfer engine | `vitest` | Byte-exact delivery, gapless offsets, resume, backpressure ceiling, zero-byte files, rejection handling |
| Session limit | `vitest` (`tests/server-limit.test.ts`) | Real WebSockets against the real server: eviction, stale-signal refusal, late `leave-room` ignored, slot reuse |
| Translations | `vitest` (`tests/i18n.test.ts`) | Every English key present in Romanian, identical placeholders, no English left in Romanian strings |
| Types | `tsc --noEmit` | Strict mode across main, preload, renderer and shared — including translation completeness |
| Render | `scripts/ui-check.js` | The app launches and all three views paint, in **both** languages (PNG decoded and measured) |
| End to end | `scripts/e2e-smoke.js` | Two real instances, real signalling, real WebRTC, real files — verified by SHA-256 |
| Handover | `scripts/e2e-handover.js` | Three real instances: takeover under load, evicted transfer abandoned, successor transfer intact |

The end-to-end tests are what make the rest trustworthy: they caught bugs that unit tests
could not (missing data channels in the SDP, `getUserMedia` desktop capture crashing Chromium
on Electron 32, an oversized chunk frame, a `room.seq` double-increment that made slot
comparisons reject the wrong viewer, and a race where a replaced viewer's stale SDP reached
the host).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| "Server offline" | The signalling URL is wrong or the server is not running. `curl http://server:8787/health`. |
| "This session is now connected to another viewer" | Someone else used the same code and password and took the only viewer slot. Expected with two-device sessions — check who has the credentials, stop sharing, and change the password. |
| Viewer connects, screen stays black | Windows privacy settings block screen capture, or a UAC/secure-desktop prompt is up. |
| "Direct connection failed" | NAT traversal failed. Use a LAN, or add TURN (see `docs/DEPLOYMENT.md`). |
| Remote control does nothing | The host's **Allow remote control** is off, or the request was not approved. Check **Settings → Test remote control** for the helper's state. |
| Choppy video | Drop frame rate to 15 fps or sharpness to 75% in the Share tab. |
| Transfers stall on a huge file | Check free disk space; a failed transfer keeps its `.part` file and resumes from there on retry. |
