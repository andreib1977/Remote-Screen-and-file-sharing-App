/**
 * Host side: turns remote input commands from the viewer into Win32 input on this machine.
 *
 * Two independent gates protect the host:
 *   1. the "Allow remote control" switch in the UI, and
 *   2. the viewer's explicit "Request control" which the host must grant.
 * Input is dropped unless both are on, and the helper process is only spawned once a
 * request is actually granted.
 */

import type { InputCommand } from '../../shared/input-protocol';
import type { PeerLinkApi, HelperStatus } from '../../main/preload';
import { translate as tr } from './i18n';

const api = (): PeerLinkApi => {
  const bridge = (window as unknown as { peerlink?: PeerLinkApi }).peerlink;
  if (!bridge) throw new Error('PeerLink desktop bridge unavailable');
  return bridge;
};

export interface InputRouterEvents {
  status: (status: HelperStatus) => void;
  warn: (message: string) => void;
  /** The host OS clipboard changed and should be pushed to the viewer. */
  clipboardFromHost: (text: string) => void;
}

export class InputRouter {
  private ready = false;
  private enabled = false;
  private lastClipboard: string | null = null;
  private clipboardTimer: ReturnType<typeof setInterval> | null = null;
  private inflight = 0;

  constructor(private readonly events: InputRouterEvents) {}

  /** `allowRemoteInput` comes from the host's settings. */
  async configure(allowRemoteInput: boolean): Promise<HelperStatus> {
    this.enabled = allowRemoteInput;
    if (!allowRemoteInput) {
      this.stopClipboardWatch();
      const status = await api().inputStop();
      this.ready = false;
      this.events.status(status);
      return status;
    }
    const status = await api().inputStatus();
    this.ready = status.state === 'ready' && status.alive !== false;
    this.events.status(status);
    if (!this.ready && status.state === 'failed' && status.error) {
      this.events.warn(status.error);
    }
    return status;
  }

  /** Called when the host grants control to the viewer. */
  async grant(): Promise<boolean> {
    if (!this.enabled) {
      this.events.warn(tr('share.enableInputFirst'));
      return false;
    }
    const status = this.ready && (await api().inputStatus()).alive !== false ? await api().inputStatus() : await api().inputStart();
    this.ready = status.state === 'ready';
    this.events.status(status);
    if (!this.ready) {
      if (status.error) this.events.warn(status.error);
      return false;
    }
    this.startClipboardWatch();
    return true;
  }

  revoke(): void {
    this.stopClipboardWatch();
    // Input routing stops immediately; the helper stays warm so a re-grant is instant.
  }

  get isReady(): boolean {
    return this.ready;
  }

  handle(command: InputCommand): void {
    if (!this.enabled || !this.ready) return;
    // Coalesce high-frequency pointer moves: never let a burst of commands queue up
    // behind slow IPC.
    if (command.k === 'move' && this.inflight > 12) return;
    this.inflight++;
    void api()
      .inputCommand(toHelperCommand(command))
      .catch(() => undefined)
      .finally(() => {
        this.inflight--;
      });
  }

  /** Viewer pasted something: mirror it onto the host clipboard (without echoing back). */
  applyRemoteClipboard(text: string): void {
    if (!this.ready) return;
    this.lastClipboard = text;
    void api()
      .clipboardSetNative(text)
      .then(() => {
        void api().copyText(text);
      })
      .catch(() => undefined);
  }

  private startClipboardWatch(): void {
    if (this.clipboardTimer || !this.enabled) return;
    this.clipboardTimer = setInterval(async () => {
      if (!this.ready) return;
      const text = await api().clipboardGetNative();
      if (text === null) return;
      if (text === this.lastClipboard) return;
      this.lastClipboard = text;
      if (text.length === 0) return;
      this.events.clipboardFromHost(text);
    }, 1500);
  }

  private stopClipboardWatch(): void {
    if (this.clipboardTimer) {
      clearInterval(this.clipboardTimer);
      this.clipboardTimer = null;
    }
  }

  dispose(): void {
    this.stopClipboardWatch();
  }
}

/** Wire format understood by the native helper (see native/README.md). */
export function toHelperCommand(command: InputCommand): Record<string, unknown> {
  switch (command.k) {
    case 'move':
      return { t: 'move', x: command.x, y: command.y };
    case 'button':
      return { t: 'button', b: command.b, down: command.down, clicks: command.clicks ?? 1 };
    case 'wheel':
      return { t: 'wheel', dx: command.dx, dy: command.dy };
    case 'key':
      return { t: 'key', code: command.code, vk: command.vk, down: command.down };
    case 'text':
      return { t: 'text', s: command.s };
    case 'clipboard':
      return { t: 'clipboard-set', s: command.s };
    default:
      return { t: 'ping', seq: 0 };
  }
}
