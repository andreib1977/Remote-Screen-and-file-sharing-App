/**
 * Owns the native input helper process (resources/input/PeerLink.Input.exe).
 *
 * One process per app instance, started lazily the first time the host actually
 * grants remote control - not at launch - so PeerLink does not spawn background
 * processes for users who only ever share files.
 */

import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export interface HelperScreen {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HelperStatus {
  state: 'stopped' | 'starting' | 'ready' | 'failed';
  screen?: HelperScreen;
  error?: string;
  path: string;
}

function helperPath(): string {
  const file = process.platform === 'win32' ? 'PeerLink.Input.exe' : 'PeerLink.Input';
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'input', file),
        path.join(process.resourcesPath, 'input', 'PeerLink.Input.exe'),
        path.join(process.resourcesPath, file)
      ]
    : [path.join(app.getAppPath(), 'resources', 'input', file)];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

export class InputHelper extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private startPromise: Promise<HelperStatus> | null = null;
  private status: HelperStatus = { state: 'stopped', path: helperPath() };
  private pendingPing: ((ok: boolean) => void) | null = null;
  private clipboardWaiters: ((text: string | null) => void)[] = [];
  private seq = 0;

  getStatus(): HelperStatus {
    return { ...this.status };
  }

  isReady(): boolean {
    return this.status.state === 'ready' && !!this.child && !this.child.killed;
  }

  async start(): Promise<HelperStatus> {
    if (this.isReady()) return this.getStatus();
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise<HelperStatus>((resolve) => {
      const exe = helperPath();
      this.status = { state: 'starting', path: exe };

      if (!fs.existsSync(exe)) {
        this.status = {
          state: 'failed',
          path: exe,
          error:
            'The remote-control helper is missing from this installation. Reinstalling PeerLink restores it; ' +
            'screen sharing and file transfer keep working without it.'
        };
        this.startPromise = null;
        return resolve(this.getStatus());
      }

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (err) {
        this.status = { state: 'failed', path: exe, error: err instanceof Error ? err.message : String(err) };
        this.startPromise = null;
        return resolve(this.getStatus());
      }

      const settle = (status: HelperStatus) => {
        this.status = status;
        this.startPromise = null;
        this.emit('status', this.getStatus());
        resolve(this.getStatus());
      };

      const timeout = setTimeout(() => {
        settle({
          state: 'failed',
          path: exe,
          error: 'The remote-control helper started but did not respond. Antivirus software may be blocking it.'
        });
      }, 5000);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        this.buffer += chunk;
        let index: number;
        while ((index = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, index).trim();
          this.buffer = this.buffer.slice(index + 1);
          if (!line) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (msg.type === 'ready') {
            clearTimeout(timeout);
            settle({ state: 'ready', path: exe, screen: msg.screen as HelperScreen });
          } else if (msg.type === 'pong' && this.pendingPing) {
            const resolvePing = this.pendingPing;
            this.pendingPing = null;
            resolvePing(true);
          } else if (msg.type === 'clipboard') {
            const waiters = this.clipboardWaiters;
            this.clipboardWaiters = [];
            for (const w of waiters) w((msg.s as string) ?? null);
          }
          this.emit('message', msg);
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (data: string) => {
        const text = data.trim();
        if (text) this.emit('stderr', text);
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        settle({ state: 'failed', path: exe, error: err.message });
      });

      child.on('exit', (code) => {
        clearTimeout(timeout);
        this.child = null;
        const wasReady = this.status.state === 'ready';
        this.status = {
          state: 'stopped',
          path: exe,
          error: code ? `The remote-control helper stopped unexpectedly (exit code ${code}).` : undefined
        };
        this.emit('status', this.getStatus());
        if (this.startPromise && !wasReady) settle(this.status);
      });

      this.child = child;
    });

    return this.startPromise;
  }

  /** Fire-and-forget JSON line to the helper. Never throws. */
  send(command: Record<string, unknown>): boolean {
    if (!this.child || this.child.killed || !this.child.stdin.writable) return false;
    try {
      this.child.stdin.write(JSON.stringify(command) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  ping(): Promise<boolean> {
    if (!this.isReady()) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingPing) this.pendingPing = null;
        resolve(false);
      }, 1500);
      this.pendingPing = (ok) => {
        clearTimeout(timer);
        resolve(ok);
      };
      if (!this.send({ t: 'ping', seq: ++this.seq })) {
        clearTimeout(timer);
        this.pendingPing = null;
        resolve(false);
      }
    });
  }

  getClipboard(): Promise<string | null> {
    if (!this.isReady()) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.clipboardWaiters = this.clipboardWaiters.filter((w) => w !== waiter);
        resolve(null);
      }, 1500);
      const waiter = (text: string | null) => {
        clearTimeout(timer);
        resolve(text);
      };
      this.clipboardWaiters.push(waiter);
      if (!this.send({ t: 'clipboard-get', seq: ++this.seq })) {
        clearTimeout(timer);
        this.clipboardWaiters = this.clipboardWaiters.filter((w) => w !== waiter);
        resolve(null);
      }
    });
  }

  stop(): void {
    if (!this.child) return;
    try {
      this.send({ t: 'quit' });
    } catch {
      /* ignore */
    }
    const child = this.child;
    setTimeout(() => {
      if (child && !child.killed) child.kill();
    }, 300).unref?.();
    this.child = null;
    this.status = { state: 'stopped', path: helperPath() };
  }
}
