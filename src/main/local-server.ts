/**
 * The bundled rendezvous server.
 *
 * PeerLink ships the server inside the app, so "start the server, then the app" becomes a
 * single launch. Two things make that work without shipping a second runtime:
 *
 *   - Electron's own binary runs as a plain Node process when `ELECTRON_RUN_AS_NODE=1`
 *     is set, so the server costs zero extra megabytes and no Node install.
 *   - the child is spawned detached with ignore-stdio and hidden, so it keeps running
 *     after the PeerLink window closes. Closing the viewer should not kill the server the
 *     other person is connected through.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

export const DEFAULT_SERVER_PORT = 8787;

export interface LocalServerStatus {
  running: boolean;
  url: string;
  port: number;
  /** LAN addresses other machines can use, e.g. ws://192.168.1.20:8787 */
  lanUrls: string[];
  /** true when we started it ourselves in this launch */
  ownedByUs: boolean;
  error?: string;
}

/**
 * The address the *local* client uses. Always loopback: it cannot go stale when the machine's
 * LAN address changes, and it does not depend on a network adapter being up. The shareable
 * LAN forms live in `lanUrls` and exist only to be shown to the other person.
 */
const loopbackUrl = (port: number) => `ws://127.0.0.1:${port}`;

/** Where signal.js lives, in dev and in a packaged app. */
export function serverScriptPath(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'server', 'signal.js')]
    : [path.join(app.getAppPath(), 'server', 'signal.js')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** IPv4 addresses other machines on the network can reach. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      // Skip virtual adapters that are never reachable from another machine.
      if (/virtual|vmware|vbox|hyper-v|loopback|wsl|docker/i.test(name)) continue;
      out.push(entry.address);
    }
  }
  return out;
}

/** Every address on this machine that could be running the server. */
function candidates(port: number): string[] {
  return ['127.0.0.1', ...lanAddresses()].map((host) => `http://${host}:${port}/health`);
}

/**
 * Is a PeerLink server answering on this port - on loopback *or* on any of this machine's
 * LAN addresses?
 *
 * Loopback is tried first. Probing the LAN addresses as well matters for a different reason:
 * a server bound to 0.0.0.0 may be reachable on the LAN while loopback is briefly
 * unavailable, and we would rather find it than start a second one.
 */
async function probe(port: number, timeoutMs = 1200): Promise<boolean> {
  for (const candidate of candidates(port)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(candidate, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) continue;
      const body = (await response.json()) as { ok?: boolean };
      if (body.ok === true) return true;
    } catch {
      /* try the next address */
    }
  }
  return false;
}

let ownedProcess: ReturnType<typeof spawn> | null = null;
/** Why the last start attempt failed, if it did. */
let lastError: string | undefined;

export async function serverStatus(port = DEFAULT_SERVER_PORT, ownedByUs = false): Promise<LocalServerStatus> {
  const running = await probe(port);
  return {
    running,
    // The client's own address is always loopback; `lanUrls` carries the shareable forms.
    url: loopbackUrl(port),
    port,
    lanUrls: lanAddresses().map((address) => `ws://${address}:${port}`),
    ownedByUs: ownedByUs || (running && ownedProcess !== null)
  };
}

/**
 * Makes sure a server is reachable on `port`.
 *
 * Order matters:
 *   1. if a server already answers anywhere on this machine - a previous launch, or a manual
 *      run - use it and start nothing;
 *   2. otherwise start the bundled one.
 *
 * Resolves with the final status; never throws.
 */
export async function ensureLocalServer(port = DEFAULT_SERVER_PORT, timeoutMs = 15000): Promise<LocalServerStatus> {
  lastError = undefined;
  if (await probe(port)) {
    const status = await serverStatus(port);
    return { ...status, ownedByUs: ownedProcess !== null };
  }

  const script = serverScriptPath();
  if (!script) {
    return {
      running: false,
      url: loopbackUrl(port),
      port,
      lanUrls: [],
      ownedByUs: false,
      error: 'The bundled signalling server is missing from this build.'
    };
  }

  try {
    const child = spawn(process.execPath, [script, '--port', String(port), '--host', '0.0.0.0'], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        // Makes the Electron binary behave as plain Node: no window, no GPU, no profile.
        ELECTRON_RUN_AS_NODE: '1'
      }
    });
    child.unref();
    ownedProcess = child;
    child.on('exit', (code) => {
      if (ownedProcess === child) ownedProcess = null;
      if (code) lastError = `The local server exited with code ${code}.`;
    });
    child.on('error', (err) => {
      lastError = `Could not start the local server: ${err.message}`;
    });
  } catch (err) {
    return {
      running: false,
      url: loopbackUrl(port),
      port,
      lanUrls: [],
      ownedByUs: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(port)) {
      return { ...(await serverStatus(port, true)), ownedByUs: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return {
    running: false,
    url: loopbackUrl(port),
    port,
    lanUrls: [],
    ownedByUs: true,
    error: lastError ?? `The local server did not answer on port ${port} within ${Math.round(timeoutMs / 1000)}s.`
  };
}

/**
 * Stops the server only if this launch started it and no session is using it.
 * Deliberately not wired to app quit: the viewer on the other machine may still be
 * connected, and a server that vanishes with a window is worse than one extra process.
 */
export function stopOwnedServer(): void {
  if (!ownedProcess) return;
  try {
    ownedProcess.kill();
  } catch {
    /* already gone */
  }
  ownedProcess = null;
}
