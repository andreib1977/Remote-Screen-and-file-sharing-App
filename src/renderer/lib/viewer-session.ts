/**
 * Viewer session: connect to a code, render the remote screen, drive it, move files.
 */

import type { CtlMessage, FileMeta, HostToViewer, QualitySettings, SessionInfo, ViewerToHost } from '../../shared/protocol';
import { shouldForwardKey, isPanicCombo, type InputCommand, type MouseButton } from '../../shared/input-protocol';
import type { SignalingClient, SignalingEvent, IceServerConfig } from './signaling-client';
import { PeerConnection, PeerStats } from './peer-connection';
import { TransferManager, TransferRecord, newTransferId } from '../../shared/transfer/manager';
import { BlobFileSource, PathFileSource, ElectronFileSink } from './file-bridge';
import { toDesktopCoords } from './capture';
import { api, hashPassword } from './hooks';
import { translate as tr } from './i18n';

/** Scripted-run diagnostics; a no-op unless PEERLINK_AUTOPILOT=1. */
function trace(message: string): void {
  void api()
    .autopilot?.log(`viewer: ${message}`)
    .catch(() => undefined);
}

export type ViewerPhase = 'idle' | 'joining' | 'negotiating' | 'live' | 'ended' | 'error';

export interface ViewerState {
  phase: ViewerPhase;
  code: string;
  session: SessionInfo | null;
  stats: PeerStats | null;
  controlGranted: boolean;
  controlRequested: boolean;
  remoteClipboard: string | null;
  error: string | null;
  endReason: string | null;
  hostConnected: boolean;
}

export interface ViewerEvents {
  state: (state: ViewerState) => void;
  transfers: (list: TransferRecord[]) => void;
  toast: (level: 'info' | 'warn' | 'error' | 'success', text: string, detail?: string) => void;
  stream: (stream: MediaStream | null) => void;
}

const initialState: ViewerState = {
  phase: 'idle',
  code: '',
  session: null,
  stats: null,
  controlGranted: false,
  controlRequested: false,
  remoteClipboard: null,
  error: null,
  endReason: null,
  hostConnected: false
};

export class ViewerSession {
  private state: ViewerState = { ...initialState };
  private peer: PeerConnection | null = null;
  private transfers: TransferManager | null = null;
  private transferList = new Map<string, TransferRecord>();
  private iceServers: IceServerConfig[] = [];
  private localStream: MediaStream | null = null;
  private pendingOffers = new Map<string, (answer: { accepted: boolean; resumeAt: number; reason?: string }) => void>();
  private wantsControl = false;
  private connectedAt = 0;
  private autoAccept = true;
  private viewerName: string;
  /**
   * The viewer slot this client holds. The server hands out an increasing number and
   * rejects signals stamped with an older one, so a replaced viewer cannot feed stale
   * SDP/ICE into a host that is already talking to its successor.
   */
  private seq = 0;

  constructor(
    private readonly signaling: SignalingClient,
    private readonly events: ViewerEvents,
    viewerName: string
  ) {
    this.viewerName = viewerName;
  }

  getState(): ViewerState {
    return this.state;
  }

  private patch(patch: Partial<ViewerState>): void {
    this.state = { ...this.state, ...patch };
    this.events.state(this.state);
  }

  private emitTransfers(): void {
    this.events.transfers([...this.transferList.values()]);
  }

  setAutoAccept(value: boolean): void {
    this.autoAccept = value;
  }

  /** Ask the server to introduce us to the host behind `code`. */
  async connect(code: string, password: string, options: { wantsControl: boolean; autoAccept: boolean }): Promise<void> {
    this.wantsControl = options.wantsControl;
    this.autoAccept = options.autoAccept;
    this.patch({ ...initialState, phase: 'joining', code });
    this.signaling.send({
      t: 'join',
      code,
      passwordHash: await hashPassword(password),
      viewerName: this.viewerName,
      protocol: 1
    });
  }

  onSignalingEvent(event: SignalingEvent): void {
    switch (event.t) {
      case 'hello':
        this.iceServers = event.iceServers || [];
        break;
      case 'join-ok':
        this.iceServers = event.iceServers || [];
        this.seq = event.seq ?? 0;
        trace(`join-ok: holding slot ${this.seq}`);
        this.patch({ phase: 'negotiating', hostConnected: true, session: null, error: null });
        this.connectedAt = Date.now();
        break;
      case 'join-failed':
        this.fail(event.reason === 'bad-password' ? tr('connect.errorBadPassword') : tr('connect.errorJoin'));
        break;
      case 'no-such-session':
        this.fail(tr('connect.errorNoSession'));
        break;
      case 'rate-limited':
        this.fail(tr('connect.errorRateLimited'));
        break;
      case 'host-gone':
        this.end(tr('connect.errorHostGone'));
        break;
      case 'replaced':
        // The server allows exactly one viewer, so this session now belongs to someone
        // else. Drop everything immediately rather than competing for the host.
        this.end(tr('connect.errorReplaced'));
        break;
      case 'signal':
        // Ignore anything the server forwarded from a previous viewer slot.
        if (event.seq !== undefined && this.seq !== 0 && event.seq !== this.seq) {
          trace(`dropped signal for slot ${event.seq} (holding ${this.seq})`);
          break;
        }
        void this.onSignal(event.payload);
        break;
      case 'error':
        if (event.code !== 'no-peer' && event.code !== 'stale-viewer') this.patch({ error: event.message });
        break;
      default:
        break;
    }
  }

  private fail(message: string): void {
    this.patch({ phase: 'error', error: message });
    this.events.toast('error', tr('connect.errorConnectFailed'), message);
  }

  private end(reason: string): void {
    this.teardownPeer();
    this.patch({ phase: 'ended', endReason: reason, hostConnected: false, stats: null, controlGranted: false });
  }

  private async onSignal(payload: unknown): Promise<void> {
    const data = payload as { kind?: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null };
    try {
      if (data.kind === 'offer' && data.sdp) {
        trace(`received offer (holding slot ${this.seq})`);
        const peer = this.ensurePeer();
        await peer.applyRemoteDescription(data.sdp);
        const answer = await peer.createAnswer();
        trace('sending answer');
        this.signal({ kind: 'answer', sdp: answer, from: 'viewer' });
      } else if (data.kind === 'answer' && data.sdp && this.peer) {
        await this.peer.applyRemoteDescription(data.sdp);
      } else if (data.kind === 'ice') {
        if (this.peer) await this.peer.addIceCandidate(data.candidate ?? null);
      }
    } catch (err) {
      this.events.toast('error', tr('connect.errorNegotiation'), err instanceof Error ? err.message : String(err));
    }
  }

  /** Every outgoing signal carries the viewer slot so the host can drop stale ones. */
  private signal(payload: Record<string, unknown>): void {
    this.signaling.send({ t: 'signal', payload, seq: this.seq });
  }

  private ensurePeer(): PeerConnection {
    if (this.peer) return this.peer;
    const peer = new PeerConnection(
      'viewer',
      {
        state: (connectionState) => {
          if (connectionState === 'connected') {
            this.patch({ phase: 'live' });
          } else if (connectionState === 'disconnected') {
            this.events.toast('warn', tr('viewer.connectionInterrupted'), tr('viewer.connectionInterruptedDetail'));
          } else if (connectionState === 'failed') {
            this.end(tr('viewer.connectionFailed'));
          }
        },
        ctlOpen: () => {
          // The channel, not the media connection, is what the hello and the control
          // request travel on - so they are sent from here.
          this.patch({ hostConnected: true });
          this.sendCtl({
            t: 'hello',
            viewerName: this.viewerName,
            appVersion: '1.0.0',
            platform: navigator.platform || 'unknown',
            wantsControl: this.wantsControl,
            wantAudio: true
          });
          if (this.wantsControl) this.sendCtl({ t: 'request-control' });
        },
        ctlClose: () => undefined,
        ctlMessage: (msg) => this.onCtlMessage(msg as HostToViewer),
        fileOpen: () => this.setupTransfer(peer),
        fileClose: () => undefined,
        fileBinary: (data) => void this.transfers?.handleChunk(data),
        remoteStream: (stream) => {
          this.localStream = stream;
          this.events.stream(stream);
        },
        iceCandidate: (candidate) => this.signal({ kind: 'ice', candidate, from: 'viewer' }),
        stats: (stats) => this.patch({ stats })
      },
      this.iceServers
    );
    peer.startStats(1000);
    this.peer = peer;
    return peer;
  }

  private setupTransfer(peer: PeerConnection): void {
    if (this.transfers) return;
    this.transfers = new TransferManager({
      role: 'viewer',
      channel: {
        get bufferedAmount() {
          return peer.fileBufferedAmount;
        },
        get readyState() {
          return peer.fileReadyState;
        },
        send: (data) => void peer.sendBinary(data as ArrayBuffer),
        onDrain: (cb) => peer.onDrain(cb)
      },
      sendTarget: {
        offer: (meta) => this.offerToHost(meta),
        notice: (msg) => this.sendCtl(msg as CtlMessage)
      },
      receiveTarget: {
        shouldAutoAccept: () => this.autoAccept,
        createSink: (meta) => ElectronFileSink.create(meta, { askUser: !this.autoAccept }),
        accept: (id, resumeAt) => this.sendCtl({ t: 'file-accept', id, resumeAt }),
        reject: (id, reason) => this.sendCtl({ t: 'file-reject', id, reason }),
        notice: (msg) => this.sendCtl(msg as CtlMessage)
      }
    });

    const manager = this.transfers;
    const sync = (rec: TransferRecord) => {
      this.transferList.set(rec.id, { ...rec });
      this.emitTransfers();
    };
    manager.on('offer', sync);
    manager.on('accept', sync);
    manager.on('progress', sync);
    manager.on('changed', sync);
    manager.on('reject', (rec) => {
      sync(rec);
      this.events.toast('warn', tr('viewer.fileDeclined', { name: rec.meta.name }), rec.error);
    });
    manager.on('done', (rec) => {
      sync(rec);
      if (rec.direction === 'receive') this.events.toast('success', tr('viewer.fileReceived', { name: rec.meta.name }), rec.savedPath);
      else this.events.toast('success', tr('viewer.fileSent', { name: rec.meta.name }));
    });
    manager.on('failed', (rec) => {
      sync(rec);
      this.events.toast('error', tr('viewer.fileFailed', { name: rec.meta.name }), rec.error);
    });
    manager.on('cancelled', sync);
  }

  private offerToHost(meta: FileMeta): Promise<{ accepted: boolean; resumeAt: number; reason?: string }> {
    return new Promise((resolve) => {
      this.pendingOffers.set(meta.id, resolve);
      if (!this.sendCtl({ t: 'file-offer', file: meta })) {
        this.pendingOffers.delete(meta.id);
        resolve({ accepted: false, resumeAt: 0, reason: 'Not connected yet.' });
        return;
      }
      setTimeout(() => {
        if (this.pendingOffers.delete(meta.id)) resolve({ accepted: false, resumeAt: 0, reason: 'The host did not answer.' });
      }, 120_000);
    });
  }

  private sendCtl(msg: ViewerToHost | CtlMessage): boolean {
    return this.peer?.sendCtl(msg as CtlMessage) ?? false;
  }

  private onCtlMessage(msg: HostToViewer): void {
    switch (msg.t) {
      case 'session':
        this.patch({ session: msg.info });
        break;
      case 'control-state':
        this.patch({ controlGranted: msg.granted, controlRequested: msg.granted ? false : this.state.controlRequested });
        if (msg.granted) this.events.toast('success', tr('share.controlGrantedToast'), tr('share.controlGrantedToastDetail'));
        else if (msg.reason) this.events.toast('warn', tr('share.declinedControl'), msg.reason);
        break;
      case 'clipboard':
        this.patch({ remoteClipboard: msg.text });
        break;
      case 'notice':
        this.events.toast(msg.level, msg.text);
        break;
      case 'quality':
        // host confirmed the new quality
        break;
      case 'file-offer':
        void this.transfers?.handleOffer(msg.file, 'host');
        break;
      case 'file-accept':
        this.pendingOffers.get(msg.id)?.({ accepted: true, resumeAt: msg.resumeAt ?? 0 });
        this.pendingOffers.delete(msg.id);
        break;
      case 'file-reject':
        this.pendingOffers.get(msg.id)?.({ accepted: false, resumeAt: 0, reason: msg.reason });
        this.pendingOffers.delete(msg.id);
        break;
      case 'file-progress':
        this.transfers?.onProgress(msg.id, msg.received);
        break;
      case 'file-done':
        void this.transfers?.handlePeerDone(msg);
        break;
      case 'file-cancel':
        void this.transfers?.handlePeerCancel(msg.id);
        break;
      case 'file-resume-request':
        this.transfers?.onProgress(msg.id, msg.have ?? 0);
        break;
      case 'chat':
        this.events.toast('info', tr('viewer.messageFromHost'), msg.text);
        break;
      case 'ping':
        this.sendCtl({ t: 'pong', seq: msg.seq });
        break;
      case 'pong':
        break;
    }
  }

  // ------------------------------------------------------------------- control

  requestControl(): void {
    this.wantsControl = true;
    this.patch({ controlRequested: true });
    this.sendCtl({ t: 'request-control' });
  }

  releaseControl(): void {
    this.wantsControl = false;
    this.patch({ controlRequested: false, controlGranted: false });
    this.sendCtl({ t: 'release-control' });
  }

  // --------------------------------------------------------------------- input

  sendInput(command: InputCommand): void {
    if (!this.state.controlGranted) return;
    this.sendCtl({ t: 'input', cmd: command });
  }

  private pointerDown = false;
  private lastMoveSent = 0;
  private pendingMove: { x: number; y: number } | null = null;
  private moveTimer: number | null = null;

  /** Attach mouse/keyboard/wheel handling to the video surface. */
  bindInputSurface(video: HTMLVideoElement): () => void {
    const positionFor = (ev: { clientX: number; clientY: number }) => toDesktopCoords(video, ev.clientX, ev.clientY);

    const sendMove = (x: number, y: number) => {
      this.pendingMove = { x, y };
      const now = performance.now();
      const elapsed = now - this.lastMoveSent;
      // 8 ms ≈ 120 Hz: smooth for a human, cheap for the host's IPC pipe.
      if (elapsed >= 8) {
        this.lastMoveSent = now;
        const move = this.pendingMove;
        this.pendingMove = null;
        if (move) this.sendInput({ k: 'move', x: move.x, y: move.y });
        return;
      }
      if (this.moveTimer !== null) return;
      this.moveTimer = window.setTimeout(() => {
        this.moveTimer = null;
        this.lastMoveSent = performance.now();
        const move = this.pendingMove;
        this.pendingMove = null;
        if (move) this.sendInput({ k: 'move', x: move.x, y: move.y });
      }, Math.max(1, 8 - elapsed));
    };

    const onPointerMove = (ev: PointerEvent) => {
      const pos = positionFor(ev);
      if (!pos) return;
      sendMove(pos.x, pos.y);
    };

    const onPointerDown = (ev: PointerEvent) => {
      if (!this.state.controlGranted) return;
      const pos = positionFor(ev);
      if (!pos) return;
      video.focus();
      this.pointerDown = true;
      try {
        video.setPointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      if (ev.button === 0 && ev.pointerType === 'touch') {
        sendMove(pos.x, pos.y);
      }
      this.sendInput({ k: 'button', b: buttonName(ev.button), down: true, clicks: Math.min(3, Math.max(1, ev.detail)) });
      ev.preventDefault();
    };

    const onPointerUp = (ev: PointerEvent) => {
      if (!this.pointerDown && !this.state.controlGranted) return;
      this.pointerDown = false;
      try {
        video.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      this.sendInput({ k: 'button', b: buttonName(ev.button), down: false, clicks: 1 });
      ev.preventDefault();
    };

    const onWheel = (ev: WheelEvent) => {
      if (!this.state.controlGranted) return;
      const notchesY = Math.max(-20, Math.min(20, Math.round(-ev.deltaY / 100)));
      const notchesX = Math.max(-20, Math.min(20, Math.round(ev.deltaX / 100)));
      if (notchesX || notchesY) this.sendInput({ k: 'wheel', dx: notchesX, dy: notchesY });
      ev.preventDefault();
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      if (isPanicCombo(ev)) {
        this.releaseControl();
        this.events.toast('info', tr('viewer.controlReleased'), tr('viewer.controlReleasedDetail'));
        ev.preventDefault();
        return;
      }
      if (!this.state.controlGranted) return;
      if (ev.repeat) return;
      const printable = ev.key.length === 1;
      if (!printable && !shouldForwardKey(ev)) return;
      this.sendInput({ k: 'key', code: ev.code, down: true });
      ev.preventDefault();
    };

    const onKeyUp = (ev: KeyboardEvent) => {
      if (!this.state.controlGranted) return;
      const printable = ev.key.length === 1;
      if (!printable && !shouldForwardKey(ev)) return;
      this.sendInput({ k: 'key', code: ev.code, down: false });
      ev.preventDefault();
    };

    const onBeforeInput = (ev: Event) => {
      // IME / emoji / dead keys arrive here as text rather than key codes.
      const text = (ev as InputEvent).data;
      if (!text || !this.state.controlGranted) return;
      if (text.length > 1 || text.charCodeAt(0) > 0x7e || text.charCodeAt(0) < 0x20) {
        this.sendInput({ k: 'text', s: text });
      }
    };

    const onPaste = (ev: ClipboardEvent) => {
      const text = ev.clipboardData?.getData('text/plain');
      if (!text || !this.state.controlGranted) return;
      this.sendInput({ k: 'text', s: text });
      ev.preventDefault();
    };

    const onContextMenu = (ev: Event) => ev.preventDefault();

    video.addEventListener('pointermove', onPointerMove);
    video.addEventListener('pointerdown', onPointerDown);
    video.addEventListener('pointerup', onPointerUp);
    video.addEventListener('pointercancel', onPointerUp);
    video.addEventListener('wheel', onWheel, { passive: false });
    video.addEventListener('keydown', onKeyDown);
    video.addEventListener('keyup', onKeyUp);
    video.addEventListener('beforeinput', onBeforeInput);
    video.addEventListener('paste', onPaste as EventListener);
    video.addEventListener('contextmenu', onContextMenu);

    return () => {
      video.removeEventListener('pointermove', onPointerMove);
      video.removeEventListener('pointerdown', onPointerDown);
      video.removeEventListener('pointerup', onPointerUp);
      video.removeEventListener('pointercancel', onPointerUp);
      video.removeEventListener('wheel', onWheel);
      video.removeEventListener('keydown', onKeyDown);
      video.removeEventListener('keyup', onKeyUp);
      video.removeEventListener('beforeinput', onBeforeInput);
      video.removeEventListener('paste', onPaste as EventListener);
      video.removeEventListener('contextmenu', onContextMenu);
      if (this.moveTimer !== null) {
        clearTimeout(this.moveTimer);
        this.moveTimer = null;
      }
    };
  }

  // --------------------------------------------------------------------- files

  async sendBrowserFiles(files: FileList | File[], relativeRoot?: string): Promise<void> {
    if (!this.transfers) {
      this.events.toast('warn', tr('viewer.notConnectedYet'));
      return;
    }
    for (const file of Array.from(files)) {
      const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      const meta: FileMeta = {
        id: newTransferId(),
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        mtime: file.lastModified,
        relativePath: relativeRoot && relative ? `${relativeRoot}/${relative}` : relative && relative.includes('/') ? relative : undefined
      };
      const source = new BlobFileSource(file, meta);
      void this.transfers.send(source).catch((err) => {
        this.events.toast('error', tr('viewer.fileFailed', { name: file.name }), err instanceof Error ? err.message : String(err));
      });
    }
  }

  async sendPaths(paths: string[]): Promise<void> {
    if (!this.transfers) {
      this.events.toast('warn', tr('viewer.notConnectedYet'));
      return;
    }
    for (const target of paths) {
      try {
        const items = await api().statPath(target);
        for (const item of items) {
          const meta: FileMeta = {
            id: newTransferId(),
            name: item.name,
            size: item.size,
            mime: 'application/octet-stream',
            mtime: item.mtime,
            relativePath: items.length > 1 || item.relative !== item.name ? item.relative : undefined
          };
          // Streamed straight off disk by the main process - no full-file buffering.
          void this.transfers.send(new PathFileSource(item.path, meta)).catch((err) => {
            this.events.toast('error', tr('viewer.fileFailed', { name: item.name }), err instanceof Error ? err.message : String(err));
          });
        }
      } catch (err) {
        this.events.toast('error', tr('share.pathError'), err instanceof Error ? err.message : String(err));
      }
    }
  }

  async setQuality(patch: Partial<QualitySettings>): Promise<void> {
    this.sendCtl({ t: 'set-quality', quality: patch });
  }

  /** Abort an outgoing transfer from the UI. */
  async cancelTransfer(id: string): Promise<void> {
    await this.transfers?.cancelSend(id, true);
  }

  sendClipboardText(text: string): void {
    this.sendInput({ k: 'clipboard', s: text });
  }

  /** Push local clipboard changes to the host (used by the "Sync clipboard" toggle). */
  sendClipboardMessage(text: string): void {
    this.sendCtl({ t: 'clipboard', text, from: 'viewer' });
  }

  /** True once both data channels are usable, i.e. transfers can start. */
  readyForTransfers(): boolean {
    return Boolean(this.peer?.ctlReady() && this.peer?.fileReadyState === 'open' && this.transfers);
  }

  get sessionSeconds(): number {
    return this.connectedAt ? Math.floor((Date.now() - this.connectedAt) / 1000) : 0;
  }

  private teardownPeer(): void {
    void this.transfers?.dispose('session ended');
    this.transfers = null;
    this.peer?.close();
    this.peer = null;
    this.localStream = null;
    this.events.stream(null);
    for (const resolve of this.pendingOffers.values()) resolve({ accepted: false, resumeAt: 0, reason: 'session ended' });
    this.pendingOffers.clear();
  }

  disconnect(): void {
    this.sendCtl({ t: 'release-control' });
    this.teardownPeer();
    this.signaling.send({ t: 'leave-room' });
    this.patch({ ...initialState, phase: 'idle' });
  }
}

function buttonName(button: number): MouseButton {
  switch (button) {
    case 1:
      return 'middle';
    case 2:
      return 'right';
    case 3:
      return 'back';
    case 4:
      return 'forward';
    default:
      return 'left';
  }
}
