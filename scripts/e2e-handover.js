#!/usr/bin/env node
/**
 * End-to-end test for the two-device rule.
 *
 * Scenario, with three real app instances:
 *   1. host starts sharing
 *   2. viewer A connects and begins sending a large file
 *   3. viewer B connects with the same code while A is mid-transfer
 *   4. B must take the session over, A must be evicted, and B must be able to send a file
 *      of its own that arrives intact
 *
 * The point is the "no third device" guarantee under load: an evicted viewer must not be
 * able to corrupt the session its successor is using.
 *
 *   node scripts/e2e-handover.js [--size 400]
 */

'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const sizeMb = Number(readArg('--size', '400'));

function readArg(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const log = (...parts) => process.stdout.write(`[handover] ${parts.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

async function waitForStatus(file, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const status = readJson(file);
    if (status) {
      last = status;
      if (predicate(status)) return status;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}; last: ${JSON.stringify(last)}`);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function generateFile(file, size) {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(file);
    const chunk = crypto.randomBytes(1024 * 1024);
    let written = 0;
    const write = () => {
      while (written < size) {
        written += chunk.byteLength;
        if (!stream.write(chunk)) {
          stream.once('drain', write);
          return;
        }
      }
      stream.end(resolve);
    };
    stream.on('error', reject);
    write();
  });
}

function electronEnv(workDir, base, extra) {
  return {
    ...process.env,
    PEERLINK_AUTOPILOT: '1',
    PEERLINK_HOME: path.join(workDir, `home-${base}`),
    PEERLINK_SERVER_URL: extra.serverUrl,
    // The test runs its own server on an ephemeral port; do not also bind 8787.
    PEERLINK_NO_LOCAL_SERVER: '1',
    PEERLINK_PASSWORD: extra.password,
    PEERLINK_STATUS_FILE: path.join(workDir, `${base}-status.json`),
    ...extra.env
  };
}

async function main() {
  const workDir = path.join(os.tmpdir(), `peerlink-handover-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  // Hard stop so a hung run cannot leave orphaned Electron processes behind.
  const watchdog = setTimeout(() => {
    process.stderr.write('[handover] FAIL watchdog: run exceeded 6 minutes\n');
    process.exit(1);
  }, 360000);
  watchdog.unref();

  const blobA = path.join(workDir, 'from-viewer-a.bin');
  const blobB = path.join(workDir, 'from-viewer-b.bin');
  log(`generating two ${sizeMb} MB files...`);
  await generateFile(blobA, sizeMb * 1024 * 1024);
  await generateFile(blobB, sizeMb * 1024 * 1024);

  const signalPort = await freePort();
  const serverUrl = `ws://127.0.0.1:${signalPort}`;
  const password = '135790';
  const downloadDir = path.join(workDir, 'received');

  const signal = spawn(process.execPath, [path.join(ROOT, 'server', 'signal.js'), '--port', String(signalPort), '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const children = [signal];
  const electron = require('electron');

  try {
    // ---- host ----
    const hostStatus = path.join(workDir, 'host-status.json');
    const host = spawn(electron, [ROOT], {
      cwd: ROOT,
      env: electronEnv(workDir, 'host', {
        serverUrl,
        password,
        env: {
          PEERLINK_ROLE: 'host',
          PEERLINK_CLIENT_ID: 'host',
          PEERLINK_DOWNLOAD_DIR: downloadDir,
          PEERLINK_FPS: '15'
        }
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(host);

    const registered = await waitForStatus(hostStatus, (s) => s.hostCode || s.hostError, 40000, 'host to register');
    if (registered.hostError) throw new Error(`host failed: ${registered.hostError}`);
    const code = registered.hostCode.replace(/\s/g, '');
    log(`host session code: ${code}`);

    // ---- viewer A: connects and starts a long transfer ----
    const statusA = path.join(workDir, 'viewerA-status.json');
    const viewerA = spawn(electron, [ROOT], {
      cwd: ROOT,
      env: electronEnv(workDir, 'viewerA', {
        serverUrl,
        password,
        env: {
          PEERLINK_ROLE: 'viewer',
          PEERLINK_CLIENT_ID: 'viewerA',
          PEERLINK_CODE: code,
          PEERLINK_SEND_FILE: blobA
        }
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(viewerA);

    await waitForStatus(statusA, (s) => s.viewerPhase === 'live', 45000, 'viewer A to connect');
    log('viewer A connected');

    // Wait until A's transfer is genuinely in flight, then bring in B mid-transfer.
    await waitForStatus(
      statusA,
      (s) => (s.transfers || []).some((t) => t.direction === 'send' && t.status === 'active' && t.progress > 5 * 1024 * 1024),
      60000,
      'viewer A transfer to be under way'
    );
    const inFlight = readJson(statusA).transfers.find((t) => t.direction === 'send');
    log(`viewer A is ${Math.round((inFlight.progress / inFlight.size) * 100)}% through its transfer - connecting viewer B now`);

    const statusB = path.join(workDir, 'viewerB-status.json');
    const viewerB = spawn(electron, [ROOT], {
      cwd: ROOT,
      env: electronEnv(workDir, 'viewerB', {
        serverUrl,
        password,
        env: {
          PEERLINK_ROLE: 'viewer',
          PEERLINK_CLIENT_ID: 'viewerB',
          PEERLINK_CODE: code,
          PEERLINK_SEND_FILE: blobB
        }
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(viewerB);

    // ---- B must take over ----
    await waitForStatus(statusB, (s) => s.viewerPhase === 'live', 45000, 'viewer B to take over');
    log('viewer B is live - checking that A was evicted');

    // ---- A must be evicted, with an explanation, and its transfer abandoned ----
    const ended = await waitForStatus(statusA, (s) => s.viewerPhase === 'ended' || s.viewerPhase === 'error', 20000, 'viewer A to be evicted');
    log(`viewer A evicted: "${ended.viewerError || 'session ended'}"`);
    const abandoned = (ended.transfers || []).find((t) => t.direction === 'send');
    if (abandoned && abandoned.status === 'done' && abandoned.progress >= abandoned.size) {
      throw new Error('viewer A was allowed to finish its transfer after being replaced');
    }
    log(`viewer A transfer status after eviction: ${abandoned ? abandoned.status : '(cleared)'}`);

    // ---- B must complete its own transfer on the inherited session ----
    log(`waiting for viewer B's ${sizeMb} MB transfer to arrive...`);
    const finalHost = await waitForStatus(
      hostStatus,
      (s) =>
        (s.transfers || []).some((t) => t.direction === 'receive' && t.name === 'from-viewer-b.bin' && t.status === 'done') &&
        Number(s.replacedViewers) >= 1 &&
        s.hostViewer === 'viewerB',
      Math.max(240000, sizeMb * 4000),
      "viewer B's transfer to complete on the host"
    );
    log(`host now holds: viewer=${finalHost.hostViewer}, replacedViewers=${finalHost.replacedViewers}, maxViewers=${finalHost.maxViewers}`);

    // The abandoned transfer from A must be gone from the host's list, not left "active".
    const strayA = (finalHost.transfers || []).find((t) => t.name === 'from-viewer-a.bin');
    if (strayA && (strayA.status === 'active' || strayA.status === 'done')) {
      throw new Error(`host still tracks viewer A's transfer as ${strayA.status}`);
    }
    log(`OK  host cleared viewer A's transfer (${strayA ? strayA.status : 'removed'})`);

    await sleep(800);
    const receivedB = path.join(downloadDir, 'from-viewer-b.bin');
    if (!fs.existsSync(receivedB)) throw new Error(`viewer B's file never arrived in ${downloadDir}`);
    if (fs.statSync(receivedB).size !== fs.statSync(blobB).size) throw new Error('viewer B file size mismatch');
    const hashB = sha256(blobB);
    if (sha256(receivedB) !== hashB) throw new Error('viewer B checksum mismatch');
    log(`OK  viewer B's file arrived intact (${hashB.slice(0, 16)}...)`);

    // ---- A's half-written file must not be presented as complete ----
    const leaked = fs.existsSync(path.join(downloadDir, 'from-viewer-a.bin'));
    if (leaked) throw new Error("viewer A's abandoned transfer produced a finished-looking file");
    log("OK  viewer A's abandoned transfer left no completed file behind");
    // ---- fourth device is also refused; the session stays at two ----
    const statusC = path.join(workDir, 'viewerC-status.json');
    const viewerC = spawn(electron, [ROOT], {
      cwd: ROOT,
      env: electronEnv(workDir, 'viewerC', {
        serverUrl,
        password,
        env: {
          PEERLINK_ROLE: 'viewer',
          PEERLINK_CLIENT_ID: 'viewerC',
          PEERLINK_CODE: code,
          PEERLINK_SEND_FILE: blobA
        }
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(viewerC);
    await waitForStatus(statusC, (s) => s.viewerPhase === 'live', 45000, 'viewer C to take over');
    const bEvicted = await waitForStatus(statusB, (s) => s.viewerPhase === 'ended' || s.viewerPhase === 'error', 20000, 'viewer B to be evicted by C');
    log(`viewer B evicted by C: "${bEvicted.viewerEndReason || bEvicted.viewerError || 'session ended'}"`);

    const lastHost = await waitForStatus(
      hostStatus,
      (s) => Number(s.replacedViewers) >= 2 && s.hostViewer === 'viewerC',
      Math.max(120000, sizeMb * 2000),
      'host to hand the session to viewer C'
    );
    log(`host recorded ${lastHost.replacedViewers} replacement(s); only ${lastHost.hostViewer} holds the slot`);

    log(`throughput B: ${sizeMb} MB delivered`);
    log('result: PASS');
    process.exitCode = 0;
  } catch (err) {
    process.exitCode = 1;
    process.stderr.write(`[handover] FAIL ${err instanceof Error ? err.stack : String(err)}\n`);
  } finally {
    for (const child of children) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    await sleep(400);
  }
}

main().catch((err) => {
  process.stderr.write(`[handover] fatal ${err.stack}\n`);
  process.exit(1);
});
