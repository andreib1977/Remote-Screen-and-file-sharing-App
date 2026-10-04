# Deploying PeerLink for real users

PeerLink is peer to peer; the only infrastructure you need is one small rendezvous server.

## 1. Run the signalling server

```powershell
node server/signal.js --port 8787 --host 0.0.0.0
```

| Flag / variable | Meaning |
| --- | --- |
| `--port`, `-p` | Listen port (default `8787`, or `$PORT`). |
| `--host` | Bind address (default `0.0.0.0`). |
| `--public-url` | Only used in the startup banner. |
| `PEERLINK_STUN_URLS` | Comma-separated STUN URLs handed to clients. Default `stun:stun.l.google.com:19302`. |
| `PEERLINK_TURN_URLS` | Comma-separated TURN URLs. Without these, peers behind strict NATs cannot connect. |
| `PEERLINK_TURN_USER` / `PEERLINK_TURN_PASS` | TURN credentials given to clients. |

Health check: `GET /health` returns `{ok, protocol, maxViewersPerRoom, rooms, viewers, uptime}`.

`maxViewersPerRoom` is always `1`: a session is one host plus one viewer, and a new viewer
replaces the previous one rather than joining it. The server closes the replaced socket, so a
session can never contain three devices. There is no configuration flag to raise this.

The server is stateless apart from the in-memory room table: restarting it drops active
sessions' ability to reconnect, but peers already connected keep working.

### Behind a reverse proxy

The WebSocket endpoint is `/ws`. Nginx:

```nginx
location /ws {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 120s;
}
```

Put it behind TLS and users connect with `wss://peerlink.example.com/ws`. PeerLink accepts
`http(s)://` URLs too and converts them.

## 2. Point clients at it

**Settings → Signalling server**, e.g. `wss://peerlink.example.com`.

These all resolve to the same endpoint:

```
peerlink.example.com          → ws://peerlink.example.com/ws
http://peerlink.example.com   → ws://peerlink.example.com/ws
https://peerlink.example.com  → wss://peerlink.example.com/ws
ws://1.2.3.4:8787/ws          → unchanged
```

For fleets, launch with `PEERLINK_SERVER_URL=wss://peerlink.example.com` and the value is
used as the default for that run.

## 3. Decide whether you need TURN

| Situation | Works with STUN only? |
| --- | --- |
| Same LAN | Yes |
| One side behind a home router, other side anywhere | Usually yes |
| Corporate networks on both sides | Often no |
| Mobile / CGNAT on both sides | Usually no |

If any of your users fall in the bottom rows, run a TURN server
([coturn](https://github.com/coturn/coturn) is the usual choice):

```bash
turnserver -a -f -n --no-cli --realm=peerlink.example.com \
  --user=peerlink:sharedsecret --lt-cred-mech \
  --listening-port=3478 --tls-listening-port=5349
```

Then start the signalling server with:

```powershell
$env:PEERLINK_TURN_URLS='turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp'
$env:PEERLINK_TURN_USER='peerlink'
$env:PEERLINK_TURN_PASS='sharedsecret'
node server/signal.js
```

Relayed sessions cost bandwidth, so prefer STUN and let TURN be the fallback it already is.

## 4. Package the desktop app

```powershell
npm run package        # release/PeerLink-<version>-setup.exe and -portable.exe
```

The artifact is fully self-sufficient. It bundles the renderer, the main process, the
signalling server and the remote-control helper, so the target machine needs **no .NET
runtime, no Node.js and no admin rights**.

The helper (`resources/input/PeerLink.Input.exe`, ~10 MB) is published self-contained and
trimmed. Trimming is only safe because it writes its JSON by hand instead of using the
reflection-based `System.Text.Json` serializer — the linker cannot see through anonymous-type
serialization and would strip the properties, silently turning every reply into `{}`. The
project sets `TreatWarningsAsErrors`, so a reintroduced reflection dependency fails the build
rather than shipping a broken helper.

## 5. Operational notes

* **Session limit**: one host + one viewer, enforced server-side. `GET /health` reports
  `maxViewersPerRoom: 1`. If your team needs several people watching one machine, run
  several hosts (one per machine) or share screen recordings — PeerLink will not multiplex
  viewers into one session.
* **Resource use**: the server holds one WebSocket per connected client and relays SDP/ICE
  only. A tiny VM handles hundreds of idle sessions.
* **Privacy**: file bytes, screen frames, audio and input never reach the server. Logs
  contain session codes and peer IPs, nothing about content.
* **Hardening**: keep the join-attempt limiter on (8/min/IP). If you expose the server
  publicly, put it behind TLS so passwords and SDP cannot be read in transit — the
  passwords are hashed, but the handshake still deserves transport security.
* **Firewall**: clients need outbound UDP for WebRTC. If UDP is blocked, TCP TURN
  (`?transport=tcp`) keeps things working at lower quality.

## 6. Unattended access

PeerLink intentionally has no "always allow this machine" mode. A host must start sharing
in the UI, because that is the only moment the user consents to being seen. If you need
unattended access for a lab or kiosk:

1. Set a fixed password in **Settings** (so the code is predictable to your team), and
2. Start PeerLink at logon with sharing enabled — add a shortcut to
   `shell:startup` and press *Start sharing*, or wrap the launch with
   `PEERLINK_AUTOPILOT=1 PEERLINK_ROLE=host …` (the automation hook the test suite uses).

Treat that as a deliberate, physical-access-required decision: anyone with the code and
password gets the machine.
