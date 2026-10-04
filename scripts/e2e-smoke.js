#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * Launches two real PeerLink instances (one hosting, one viewing) through the autopilot
 * hook, connects them through a real signalling server, and transfers a file over WebRTC.
 * Then it verifies the bytes that landed on the receiving side, so a regression in the
 * peer connection, the framing or the disk path fails the test instead of passing quietly.
 *
 *   node scripts/e2e-smoke.js [--size 200] [--app <path to PeerLink.exe>] [--keep]
 *
 * `--app` points the test at an installed/packaged build instead of the source tree, which
 * is how the packaged artifact gets validated.
 * `--size` is in megabytes (default 200: large enough to exercise flow control).
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
const sizeMb = Number(readArg('--size', '200'));
const verbose = args.includes('--verbose');
/** When set, the test drives a packaged build instead of the source tree. */
const appOverride = readArg('--app', '');
const appBinary = appOverride ? path.resolve(appOverride) : require('electron');
const appArgs = appOverride ? [] : [ROOT, '--disable-renderer-backgrounding'];
/** A packaged build ships its own server; the test must not also bind the default port. */
const packaged = Boolean(appOverride);

function readArg(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function log(...parts) {
  process.stdout.write(`[e2e] ${parts.join(' ')}\n`);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function waitForStatus(file, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const status = readJson(file);
    if (status) {
      last = status;
      if (predicate(status)) return status;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${label}; last status: ${JSON.stringify(last)}`);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
  const runId = `peerlink-e2e-${Date.now()}`;
  const workDir = path.join(os.tmpdir(), runId);
  fs.mkdirSync(workDir, { recursive: true });

  const payloadPath = path.join(workDir, 'payload.bin');
  log(`generating ${sizeMb} MB test file...`);
  await generateFile(payloadPath, sizeMb * 1024 * 1024);

  const signalPort = await freePort();
  const signal = spawn(process.execPath, [path.join(ROOT, 'server', 'signal.js'), '--port', String(signalPort), '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe']
  });
  signal.stdout?.on('data', (d) => verbose && process.stdout.write(`[signal] ${d}`));
  signal.stderr?.on('data', (d) => process.stderr.write(`[signal] ${d}`));

  const children = [signal];
  try {
    await waitForHttp(`http://127.0.0.1:${signalPort}/health`, 10000);
    log(`signalling server up on ${signalPort}`);

    const electronBin = require('electron');
    const hostStatus = path.join(workDir, 'host-status.json');
    const viewerStatus = path.join(workDir, 'viewer-status.json');
    const codeFile = path.join(workDir, 'code.txt');
    const downloadDir = path.join(workDir, 'received');
    const password = '246813';

    const host = spawn(appBinary, appArgs, {
      cwd: ROOT,
      env: {
        ...process.env,
        PEERLINK_AUTOPILOT: '1',
        PEERLINK_ROLE: 'host',
        PEERLINK_CLIENT_ID: 'host',
        PEERLINK_HOME: path.join(workDir, 'home-host'),
        PEERLINK_DOWNLOAD_DIR: downloadDir,
        PEERLINK_SERVER_URL: `ws://127.0.0.1:${signalPort}`,
        // The test runs its own server on an ephemeral port; do not also bind 8787.
        PEERLINK_NO_LOCAL_SERVER: '1',
        PEERLINK_PASSWORD: password,
        PEERLINK_CODE_FILE: codeFile,
        PEERLINK_STATUS_FILE: hostStatus,
        PEERLINK_FPS: '15'
      },
      stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe']
    });
    children.push(host);

    log('waiting for the host to publish a session code...');
    const hostSettled = await waitForStatus(
      hostStatus,
      (status) => status.hostCode || status.hostError,
      40000,
      'host to register a session'
    );
    if (hostSettled.hostError) throw new Error(`host failed: ${hostSettled.hostError}`);
    const code = hostSettled.hostCode.replace(/\s/g, '');
    log(`host session code: ${code}`);

    const viewer = spawn(appBinary, appArgs, {
      cwd: ROOT,
      env: {
        ...process.env,
        PEERLINK_AUTOPILOT: '1',
        PEERLINK_ROLE: 'viewer',
        PEERLINK_CLIENT_ID: 'viewer',
        PEERLINK_HOME: path.join(workDir, 'home-viewer'),
        PEERLINK_SERVER_URL: `ws://127.0.0.1:${signalPort}`,
        PEERLINK_NO_LOCAL_SERVER: '1',
        PEERLINK_PASSWORD: password,
        PEERLINK_CODE: code,
        PEERLINK_SEND_FILE: payloadPath,
        PEERLINK_STATUS_FILE: viewerStatus,
        PEERLINK_WANT_CONTROL: '1'
      },
      stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe']
    });
    children.push(viewer);

    log('waiting for the peer connection to come up...');
    const live = await waitForStatus(viewerStatus, (status) => status.viewerPhase === 'live' || status.viewerError, 45000, 'viewer to connect');
    if (live.viewerError) throw new Error(`viewer failed: ${live.viewerError}`);
    log('peer connection established');

    const startedAt = Date.now();
    log(`waiting for the ${sizeMb} MB transfer to finish...`);
    // The host is the receiving side here, so watch its status for the inbound file.
    const done = await waitForStatus(
      hostStatus,
      (status) => {
        const transfers = status.transfers || [];
        return (
          transfers.some((t) => t.direction === 'receive' && t.status === 'done') ||
          transfers.some((t) => t.status === 'failed' || t.status === 'rejected')
        );
      },
      Math.max(180000, sizeMb * 4000),
      'transfer to complete'
    );

    const transfer = (done.transfers || []).find((t) => t.direction === 'receive');
    if (!transfer || transfer.status !== 'done') {
      throw new Error(`transfer did not finish: ${JSON.stringify(transfer)}`);
    }

    // Give the receiver a moment to flush and rename the file.
    await new Promise((r) => setTimeout(r, 700));
    const received = findReceivedFile(downloadDir);
    if (!received) throw new Error(`no file arrived in ${downloadDir}`);
    if (received.size !== fs.statSync(payloadPath).size) {
      throw new Error(`size mismatch: sent ${fs.statSync(payloadPath).size}, received ${received.size}`);
    }
    const sourceHash = sha256(payloadPath);
    const receivedHash = sha256(received.path);
    if (sourceHash !== receivedHash) {
      throw new Error(`checksum mismatch\n  sent     ${sourceHash}\n  received ${receivedHash}`);
    }

    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const throughput = sizeMb / elapsedSeconds;
    log(`OK  transferred ${sizeMb} MB, checksum ${receivedHash.slice(0, 16)}...`);
    log(`OK  saved to ${received.path} (${transfer.progress} bytes tracked)`);
    log(`throughput: ${throughput.toFixed(1)} MB/s over ${elapsedSeconds.toFixed(1)}s`);
    log('result: PASS');
    process.exitCode = 0;
  } catch (err) {
    process.exitCode = 1;
    process.stderr.write(`[e2e] FAIL ${err instanceof Error ? err.stack : String(err)}\n`);
  } finally {
    for (const child of children) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

function findReceivedFile(dir) {
  if (!fs.existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (!entry.name.endsWith('.part')) return { path: full, size: fs.statSync(full).size };
    }
  }
  return null;
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

main().catch((err) => {
  process.stderr.write(`[e2e] fatal ${err.stack}\n`);
  process.exit(1);
});
