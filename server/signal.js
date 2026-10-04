#!/usr/bin/env node
/**
 * PeerLink signaling + peer discovery server.
 *
 * Deliberately tiny and dependency-light (one package: `ws`). It does exactly three things:
 *
 *   1. Gives every host a short numeric session id (like 742 918) that viewers type in.
 *   2. Authenticates the viewer against the host's own password.
 *   3. Relays the WebRTC handshake (SDP + ICE candidates) between the two peers.
 *
 * It never sees your screen, your files, or your control events: those flow peer-to-peer over an
 * encrypted DTLS/SRTP connection. Because the password is only ever compared as a SHA-256 hash,
 * the relay also never learns the plaintext password.
 *
 * Usage:
 *   node server/signal.js [--port 8787] [--host 0.0.0.0] [--public-url ws://my.server:8787]
 *
 * Environment:
 *   PEERLINK_STUN_URLS   comma separated STUN URLs handed to clients
 *   PEERLINK_TURN_URLS   comma separated TURN URLs
 *   PEERLINK_TURN_USER / PEERLINK_TURN_PASS
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const PROTOCOL = 1;
const DEFAULT_PORT = 8787;
/**
 * Hard limit: one host + one viewer per session. A second viewer takes the slot over and
 * the previous one is disconnected outright - a session can never contain three devices.
 */
const MAX_VIEWERS_PER_ROOM = 1;
/** Ambiguous glyphs (0/O, 1/I) are excluded: codes get read aloud over the phone. */
const CODE_ALPHABET = '23456789';
const CODE_LENGTH = 6;
const MAX_ROOMS_PER_IP = 8;
const MAX_JOIN_ATTEMPTS = 8;
const JOIN_WINDOW_MS = 60_000;
const IDLE_TIMEOUT_MS = 45_000;

function parseArgs(argv) {
  const out = { port: Number(process.env.PORT || DEFAULT_PORT), host: process.env.HOST || '0.0.0.0', publicUrl: process.env.PEERLINK_PUBLIC_URL || '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--public-url') out.publicUrl = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function iceServersFromEnv() {
  const split = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const stun = split(process.env.PEERLINK_STUN_URLS);
  const turn = split(process.env.PEERLINK_TURN_URLS);
  const servers = [];
  for (const url of (stun.length ? stun : ['stun:stun.l.google.com:19302'])) servers.push({ urls: url });
  if (turn.length) {
    const credential = process.env.PEERLINK_TURN_PASS;
    const username = process.env.PEERLINK_TURN_USER;
    for (const url of turn) servers.push({ urls: url, username, credential });
  }
  return servers;
}

function randomCode(rooms) {
  for (let attempt = 0; attempt < 500; attempt++) {
    let code = '';
    const bytes = crypto.randomBytes(CODE_LENGTH);
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    const spaced = code.slice(0, 3) + ' ' + code.slice(3);
    if (!rooms.has(spaced)) return spaced;
  }
  throw new Error('session code space exhausted');
}

const normalizeCode = (code) => String(code || '').replace(/[^0-9]/g, '');
const spaced = (digits) => (digits.length === CODE_LENGTH ? digits.slice(0, 3) + ' ' + digits.slice(3) : digits);

function main(onReady) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: node server/signal.js [--port 8787] [--host 0.0.0.0] [--public-url ws://host:8787]\n');
    return;
  }

  /**
   * @type {Map<string, {code:string, passwordHash:string, host:any, viewer:any, ip:string,
   *   createdAt:number, hostName:string, seq:number}>}
   */
  const rooms = new Map();
  /** @type {Map<any, {role:'host'|'viewer', room?:string, seq:number, ip:string, attempts:number[], lastSeen:number}>} */
  const clients = new Map();

  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const body = JSON.stringify({
        ok: true,
        protocol: PROTOCOL,
        maxViewersPerRoom: MAX_VIEWERS_PER_ROOM,
        rooms: rooms.size,
        viewers: [...rooms.values()].filter((r) => r.viewer).length,
        uptime: Math.round(process.uptime())
      });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('PeerLink signaling server. WebSocket endpoint: /ws\n');
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 * 1024 });

  const send = (ws, msg) => {
    if (ws && ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        /* peer vanished mid-send; close handler cleans up */
      }
    }
  };

  const closeRoom = (room, reason) => {
    if (room.viewer) {
      send(room.viewer, { t: 'host-gone', reason });
      const meta = clients.get(room.viewer);
      if (meta) meta.room = undefined;
    }
    rooms.delete(room.code);
    log(`room ${room.code} closed (${reason})`);
  };

  function log(...parts) {
    const stamp = new Date().toISOString().slice(11, 19);
    process.stdout.write(`[${stamp}] ${parts.join(' ')}\n`);
  }

  function fail(ws, code, message) {
    send(ws, { t: 'error', code, message });
  }

  wss.on('connection', (ws, req) => {
    const ip = (req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : null) || req.socket.remoteAddress || 'unknown';
    clients.set(ws, { role: 'viewer', ip, attempts: [], lastSeen: Date.now(), seq: 0 });
    send(ws, { t: 'hello', protocol: PROTOCOL, iceServers: iceServersFromEnv(), serverTime: Date.now() });

    ws.on('pong', () => {
      const meta = clients.get(ws);
      if (meta) meta.lastSeen = Date.now();
    });

    ws.on('message', (raw) => {
      const meta = clients.get(ws);
      if (!meta) return;
      meta.lastSeen = Date.now();

      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return fail(ws, 'bad-json', 'Message was not valid JSON.');
      }
      if (!msg || typeof msg.t !== 'string') return fail(ws, 'bad-message', 'Missing message type.');

      switch (msg.t) {
        case 'host':
          return handleHost(ws, meta, msg);
        case 'host-update':
          return handleHostUpdate(ws, meta, msg);
        case 'join':
          return handleJoin(ws, meta, msg);
        case 'leave-room':
          return handleLeave(ws, meta);
        case 'signal':
          return handleSignal(ws, meta, msg);
        case 'ping':
          return send(ws, { t: 'pong', seq: msg.seq });
        case 'bye':
          return ws.close(1000, 'bye');
        default:
          return fail(ws, 'unknown-type', `Unknown message type: ${msg.t}`);
      }
    });

    ws.on('close', () => {
      const m = clients.get(ws);
      clients.delete(ws);
      if (!m) return;
      if (m.role === 'host' && m.room && rooms.has(m.room)) {
        closeRoom(rooms.get(m.room), 'host-disconnected');
      } else if (m.role === 'viewer' && m.room && rooms.has(m.room)) {
        const room = rooms.get(m.room);
        if (room.viewer === ws) {
          room.viewer = null;
          send(room.host, { t: 'viewer-gone', reason: 'viewer-disconnected' });
          log(`viewer left room ${room.code}`);
        }
      }
    });

    ws.on('error', () => ws.terminate());
  });

  function handleHost(ws, meta, msg) {
    if (meta.room && rooms.has(meta.room)) closeRoom(rooms.get(meta.room), 'host-restarted');

    const ip = meta.ip;
    const owned = [...rooms.values()].filter((r) => r.ip === ip).length;
    if (owned >= MAX_ROOMS_PER_IP) return fail(ws, 'too-many-rooms', 'Too many sessions registered from this address.');

    const passwordHash = String(msg.passwordHash || '');
    if (!/^[0-9a-f]{64}$/.test(passwordHash)) return fail(ws, 'bad-password', 'Host must supply a SHA-256 password hash.');

    const code = randomCode(rooms);
    const room = { code, passwordHash, host: ws, viewer: null, ip, createdAt: Date.now(), hostName: String(msg.hostName || '').slice(0, 64), seq: 0 };
    rooms.set(code, room);
    meta.role = 'host';
    meta.room = code;
    send(ws, { t: 'host-ok', code, protocol: PROTOCOL, maxViewers: MAX_VIEWERS_PER_ROOM, iceServers: iceServersFromEnv() });
    log(`host registered ${code} from ${ip} (1 host + ${MAX_VIEWERS_PER_ROOM} viewer per session)`);
  }

  function handleHostUpdate(ws, meta, msg) {
    const room = meta.room && rooms.get(meta.room);
    if (!room || room.host !== ws) return fail(ws, 'not-a-host', 'Not hosting a session.');
    if (msg.passwordHash && /^[0-9a-f]{64}$/.test(String(msg.passwordHash))) {
      room.passwordHash = String(msg.passwordHash);
      if (room.viewer) {
        // The password changed mid-session: existing viewer stays (already authenticated),
        // new viewers must use the new one.
      }
    }
    send(ws, { t: 'host-ok', code: room.code, protocol: PROTOCOL, iceServers: iceServersFromEnv() });
  }

  function handleJoin(ws, meta, msg) {
    const digits = normalizeCode(msg.code);
    if (digits.length !== CODE_LENGTH) return fail(ws, 'bad-code', 'Session codes are six digits.');

    const now = Date.now();
    meta.attempts = meta.attempts.filter((t) => now - t < JOIN_WINDOW_MS);
    if (meta.attempts.length >= MAX_JOIN_ATTEMPTS) {
      return send(ws, { t: 'rate-limited', message: 'Too many attempts. Wait a minute and try again.' });
    }

    const room = rooms.get(spaced(digits));
    if (!room) {
      meta.attempts.push(now);
      return send(ws, { t: 'no-such-session', message: 'No host is waiting with that session code.' });
    }

    const given = String(msg.passwordHash || '');
    const expected = room.passwordHash;
    const ok = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'));
    if (!ok) {
      meta.attempts.push(now);
      send(room.host, { t: 'join-failed', reason: 'bad-password' });
      return fail(ws, 'bad-password', 'Wrong password.');
    }

    if (room.viewer && room.viewer !== ws) {
      // Single-viewer invariant: the newcomer takes the slot and the previous viewer is
      // disconnected, not merely detached. Two things happen, deliberately:
      //   1. it is told why, so its UI can explain itself, then
      //   2. its socket is closed, so it cannot keep sending stale SDP/ICE into a host
      //      that is already negotiating with the new viewer.
      const previous = room.viewer;
      send(previous, { t: 'replaced', reason: 'another-viewer-connected' });
      const oldMeta = clients.get(previous);
      if (oldMeta) {
        // Keep the room pointer so a late message from this socket is recognised as
        // "stale viewer" rather than "not in a session". Its meta.seq still holds the old
        // slot, which is what makes handleSignal refuse anything it sends from now on.
        oldMeta.seq = 0;
      }
      setTimeout(() => {
        try {
          previous.close(4000, 'replaced by another viewer');
        } catch {
          previous.terminate?.();
        }
      }, 150);
      log(`room ${room.code}: viewer replaced (session stays at 2 devices)`);
    }
    room.seq += 1;
    room.viewer = ws;
    meta.role = 'viewer';
    meta.room = room.code;
    meta.seq = room.seq;
    send(ws, {
      t: 'join-ok',
      code: room.code,
      hostName: room.hostName,
      seq: room.seq,
      maxViewers: MAX_VIEWERS_PER_ROOM,
      iceServers: iceServersFromEnv()
    });
    send(room.host, { t: 'viewer-joined', viewerName: String(msg.viewerName || '').slice(0, 64), seq: room.seq });
    log(`viewer joined room ${room.code} from ${meta.ip} (slot ${room.seq})`);
  }

  function handleLeave(ws, meta) {
    const room = meta.room && rooms.get(meta.room);
    if (!room) return;
    // Only the viewer that still holds the slot may vacate it. A replaced viewer saying
    // goodbye must not touch the session its successor is using.
    if (room.viewer === ws) {
      room.viewer = null;
      room.seq += 1;
      send(room.host, { t: 'viewer-gone', reason: 'viewer-left', seq: room.seq });
    }
    meta.room = undefined;
  }

  function handleSignal(ws, meta, msg) {
    const room = meta.room && rooms.get(meta.room);
    if (!room) return fail(ws, 'not-in-room', 'Not attached to a session.');

    const fromHost = room.host === ws;
    const slot = typeof msg.seq === 'number' ? msg.seq : null;

    if (fromHost) {
      // The host stamps each signal with the viewer slot its peer connection was built for.
      // During a takeover the previous connection can still emit ICE; those arrive stamped
      // with the old slot and must not reach the viewer that now holds the new one.
      if (slot !== null && slot !== room.seq) {
        log(`room ${room.code}: dropped stale host signal (slot ${slot}, current ${room.seq})`);
        return;
      }
    } else if (meta.seq !== room.seq) {
      // A viewer that was replaced still has its socket for a moment.
      return fail(ws, 'stale-viewer', 'Another viewer holds this session.');
    }

    const target = fromHost ? room.viewer : room.host;
    if (!target) return fail(ws, 'no-peer', 'The other side is not connected.');
    send(target, { t: 'signal', payload: msg.payload, seq: fromHost ? room.seq : meta.seq });
  }

  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [ws, meta] of clients) {
      if (now - meta.lastSeen > IDLE_TIMEOUT_MS) {
        ws.terminate();
        continue;
      }
      if (ws.readyState === ws.OPEN) {
        try {
          ws.ping();
        } catch {
          /* ignore */
        }
      }
    }
  }, 15_000);
  reaper.unref?.();

  server.on('error', (err) => {
    log(`fatal: ${err.message}`);
    process.exitCode = 1;
  });

  server.listen(args.port, args.host, () => {
    const shown = args.publicUrl || `ws://${args.host === '0.0.0.0' ? 'localhost' : args.host}:${args.port}`;
    log(`PeerLink signaling + discovery on ${args.host}:${args.port}`);
    log(`  WebSocket endpoint : ${shown}/ws`);
    log(`  Health             : http://localhost:${args.port}/health`);
    log(`  Session limit      : 1 host + ${MAX_VIEWERS_PER_ROOM} viewer (a new viewer replaces the old one)`);
    log('  Point every PeerLink client at that WebSocket endpoint (Settings -> server URL).');
    onReady?.({ port: args.port, host: args.host, server, wss, rooms, clients, close: () => server.close() });
  });
}

if (require.main === module) main();

module.exports = {
  PROTOCOL,
  CODE_LENGTH,
  CODE_ALPHABET,
  MAX_VIEWERS_PER_ROOM,
  randomCode,
  normalizeCode,
  spaced,
  main
};
