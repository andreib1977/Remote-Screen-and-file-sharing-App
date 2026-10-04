/**
 * Host session: advertise this machine, capture the screen, accept one viewer,
 * serve remote control and exchange files in both directions.
 */

import type { MonitorInfo, QualitySettings, SessionInfo, CtlMessage, FileMeta, ViewerToHost } from '../../shared/protocol';
import type { SignalingClient, SignalingEvent, IceServerConfig } from './signaling-client';
import { PeerConnection, PeerStats } from './peer-connection';
import { TransferManager, TransferRecord, newTransferId } from '../../shared/transfer/manager';
import { PathFileSource, ElectronFileSink } from './file-bridge';
import { InputRouter } from './input-router';
import { startCapture, stopStream } from './capture';
import { formatCode } from './format';
import { api, hashPassword } from './hooks';
import { translate as tr } from './i18n';
import type { HelperStatus } from '../../main/preload';

/** Scripted-run diagnostics; a no-op unless PEERLINK_AUTOPILOT=1. */
function trace(message: string): void {
  void api()
    .autopilot?.log(`host: ${message}`)
    .catch(() => undefined);
}

export type HostPhase = 'idle' | 'registering' | 'ready' | 'viewer-connecting' | 'live' | 'error';

export interface HostViewerInfo {
  name: string;
  platform: string;
  wantsControl: boolean;
}

export interface HostState {
  phase: HostPhase;
  code: string;
  viewer: HostViewerInfo | null;
  controlGranted: boolean;
  controlRequested: boolean;
  stats: PeerStats | null;
  audioActive: boolean;
  error: string | null;
  helper: HelperStatus | null;
  localIp: string;
  /** hard peer limit for this session; 1 means host + one viewer */
  maxViewers: number;
  /** how many viewers connected and were replaced during this session */
  replacedViewers: number;
}

export interface HostEvents {
  state: (state: HostState) => void;
  transfers: (list: TransferRecord[]) => void;
  toast: (level: 'info' | 'warn' | 'error' | 'success', text: string, detail?: string) => void;
  /** clipboard text arriving from the viewer (so the UI can mirror it locally) */
  remoteClipboard: (text: string) => void;
}

export interface HostConfig {
  allowRemoteInput: boolean;
  autoAcceptFiles: boolean;
  quality: QualitySettings;
  monitors: MonitorInfo[];
  password: string;
  displayName: string;
  audio: boolean;
}

export const initialState: HostState = {
  phase: 'idle',
  code: '',
  viewer: null,
  controlGranted: false,
  controlRequested: false,
  stats: null,
  audioActive: false,
  error: null,
  helper: null,
  localIp: '',
  maxViewers: 1,
  replacedViewers: 0
};

export class HostSession {
  private state: HostState = { ...initialState };
  private peer: PeerConnection | null = null;
  private transfers: TransferManager | null = null;
  private transferList = new Map<string, TransferRecord>();
  private captureStream: MediaStream | null = null;
  private router: InputRouter;
  private iceServers: IceServerConfig[] = [];
  private passwordHash = '';
  private sessionInfo: SessionInfo | null = null;
  private config: HostConfig;
  /** set while the viewer is (re)negotiating so the offer is only sent once */
  private offering = false;
  /** Bumped for every viewer that takes the (single) viewer slot. */
  private epoch = 0;
  /** The slot the current peer connection was created for (see `ensurePeer`). */
  private peerEpoch = 0;
  /** Pending viewer slot to announce once a fresh peer connection is actually up. */
  private pendingViewer: { name: string } | null = null;

  constructor(
    private readonly signaling: SignalingClient,
    config: HostConfig,
    private readonly events: HostEvents
  ) {
    this.config = config;
    this.router = new InputRouter({
      status: (helper) => this.patch({ helper: { ...helper, state: helper.state } as HelperStatus }),
      warn: (message) => this.events.toast('warn', message),
      clipboardFromHost: (text) => this.sendCtl({ t: 'clipboard', text, from: 'host' })
    });
  }

  getState(): HostState {
    return this.state;
  }

  private patch(patch: Partial<HostState>): void {
    this.state = { ...this.state, ...patch };
    this.events.state(this.state);
  }

  private emitTransfers(): void {
    this.events.transfers([...this.transferList.values()]);
  }

  // ------------------------------------------------------------------ lifecycle

  async start(config: Partial<HostConfig>): Promise<void> {
    this.config = { ...this.config, ...config };
    this.patch({ phase: 'registering', error: null });

    const trace = (message: string) => {
      void api()
        .autopilot?.log(`host: ${message}`)
        .catch(() => undefined);
    };

    try {
      trace('discovering displays');
      const monitors = this.config.monitors.length ? this.config.monitors : await this.discoverMonitors();
      const desktop = await api().listDisplays().then((d) => d.desktop);
      const helper = await api().inputStatus();
      trace(`displays ok, ${monitors.length} monitor(s), desktop ${desktop.width}x${desktop.height}`);

      this.patch({ helper });
      this.iceServers = [];

      const sessionInfo: SessionInfo = {
        hostName: this.config.displayName,
        appVersion: '',
        platform: `${navigator.platform || 'windows'}`,
        monitors,
        desktop,
        canControl: true,
        inputHelperReady: helper.state === 'ready',
        allowRemoteInput: this.config.allowRemoteInput,
        quality: this.config.quality
      };
      this.sessionInfo = sessionInfo;

      trace('starting screen capture');
      const capture = await startCapture({
        sourceId: monitors.find((m) => m.primary)?.id,
        fps: this.config.quality.fps,
        scale: this.config.quality.scale,
        audio: this.config.quality.audio
      });
      trace(`capture ok ${capture.settings.width}x${capture.settings.height} audio=${capture.audioActive}`);
      this.captureStream = capture.stream;
      this.patch({ audioActive: capture.audioActive });

      await this.router.configure(this.config.allowRemoteInput);

      this.passwordHash = await hashPassword(this.config.password);
      trace('registering with the signalling server');
      this.signaling.send({
        t: 'host',
        protocol: 1,
        passwordHash: this.passwordHash,
        hostName: this.config.displayName
      });
      // The server answers with host-ok, which carries the session code.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      trace(`start failed: ${message}`);
      this.patch({ phase: 'error', error: friendlyCaptureError(message) });
      this.events.toast('error', tr('share.startFailed'), friendlyCaptureError(message));
    }
  }

  private async discoverMonitors(): Promise<MonitorInfo[]> {
    const { displays } = await api().listDisplays();
    return displays.map((d) => ({
      id: d.id,
      label: d.label,
      width: d.width,
      height: d.height,
      primary: d.primary
    }));
  }

  /** Switch which screen is being shared without restarting the session. */
  async switchMonitor(sourceId: string): Promise<void> {
    if (!this.captureStream) return;
    await this.reacquireCapture(sourceId);
  }

  /** Re-acquire the capture with the current quality settings (used for audio changes). */
  private async reacquireCapture(sourceId?: string): Promise<void> {
    if (!this.captureStream) return;
    const target = sourceId ?? this.captureStream.getVideoTracks()[0]?.getSettings().deviceId ?? undefined;
    const fresh = await startCapture({
      sourceId: target,
      fps: this.config.quality.fps,
      scale: this.config.quality.scale,
      audio: this.config.quality.audio
    });
    const old = this.captureStream;
    this.captureStream = fresh.stream;
    const newTracks = fresh.stream.getTracks();
    if (this.peer) this.peer.addStream(new MediaStream(newTracks));
    stopStream(new MediaStream(old.getTracks()));
    this.patch({ audioActive: fresh.audioActive });
    if (this.sessionInfo) {
      this.sessionInfo = { ...this.sessionInfo, quality: this.config.quality };
      this.sessionInfo = { ...this.sessionInfo, desktop: (await api().listDisplays()).desktop };
      this.sendCtl({ t: 'session', info: this.sessionInfo });
    }
  }

  private async ensurePeer(): Promise<PeerConnection> {
    if (this.peer) return this.peer;
    /**
     * The viewer slot this connection belongs to.
     *
     * Captured per connection, not read from `this.epoch` at send time. During a takeover the
     * epoch has already advanced to the newcomer while the *previous* connection is still
     * emitting ICE candidates; reading the live epoch would stamp those stale candidates with
     * the new slot, and the new viewer would accept them into a negotiation they do not
     * belong to. Stamped with the slot they were created for, the server drops them instead.
     */
    const peerEpoch = this.epoch;
    const peer = new PeerConnection(
      'host',
      {
        state: (connectionState, detail) => this.onPeerState(connectionState, detail),
        ctlOpen: () => {
          if (this.sessionInfo) this.sendCtl({ t: 'session', info: this.sessionInfo });
          this.sendCtl({ t: 'control-state', granted: this.state.controlGranted });
          // The viewer slot is only announced once this peer connection is the live one.
          this.pendingViewer = null;
        },
        ctlClose: () => undefined,
        ctlMessage: (msg) => this.onCtlMessage(msg as ViewerToHost),
        fileOpen: () => this.setupTransfer(peer),
        fileClose: () => undefined,
        fileBinary: (data) => void this.transfers?.handleChunk(data),
        remoteStream: () => undefined,
        iceCandidate: (candidate) =>
          this.signaling.send({ t: 'signal', payload: { kind: 'ice', candidate, from: 'host' }, seq: peerEpoch }),
        stats: (stats) => this.patch({ stats })
      },
      this.iceServers
    );
    this.peerEpoch = peerEpoch;
    trace(`ensurePeer: created pc for slot ${peerEpoch} (this.epoch=${this.epoch})`);
    // Assign before creating the channels: their `open` events fire during construction
    // and the handlers below read `this.peer`.
    this.peer = peer;
    if (this.captureStream) peer.addStream(this.captureStream);
    // Both data channels must exist before the offer is created, otherwise the SDP has
    // no application section and neither side can ever open a channel.
    peer.createChannels();
    await peer.limitVideoBitrate(this.config.quality.fps >= 30 ? 12_000 : 6_000);
    peer.startStats(1000);
    return peer;
  }

  private setupTransfer(peer: PeerConnection): void {
    if (this.transfers) return;
    this.transfers = new TransferManager({
      role: 'host',
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
        offer: (meta) => this.offerToViewer(meta),
        notice: (msg) => this.sendCtl(msg as CtlMessage)
      },
      receiveTarget: {
        shouldAutoAccept: () => this.config.autoAcceptFiles,
        createSink: (meta) => ElectronFileSink.create(meta, { askUser: false }),
        accept: (id, resumeAt) => this.sendCtl({ t: 'file-accept', id, resumeAt }),
        reject: (id, reason) => this.sendCtl({ t: 'file-reject', id, reason }),
        notice: (msg) => this.sendCtl(msg as CtlMessage)
      }
    });
    this.wireTransferEvents();
  }

  private wireTransferEvents(): void {
    if (!this.transfers) return;
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
      if (rec.direction === 'receive') {
        this.events.toast('success', tr('viewer.fileReceived', { name: rec.meta.name }), rec.savedPath);
      } else {
        this.events.toast('success', tr('viewer.fileSent', { name: rec.meta.name }), undefined);
      }
    });
    manager.on('failed', (rec) => {
      sync(rec);
      this.events.toast('error', tr('viewer.fileFailed', { name: rec.meta.name }), rec.error);
    });
    manager.on('cancelled', (rec) => {
      sync(rec);
    });
  }

  private async offerToViewer(meta: FileMeta): Promise<{ accepted: boolean; resumeAt: number; reason?: string }> {
    return new Promise((resolve) => {
      this.pendingOffers.set(meta.id, resolve);
      const ok = this.sendCtl({ t: 'file-offer', file: meta });
      if (!ok) {
        this.pendingOffers.delete(meta.id);
        resolve({ accepted: false, resumeAt: 0, reason: 'control channel is not open' });
        return;
      }
      setTimeout(() => {
        if (this.pendingOffers.delete(meta.id)) resolve({ accepted: false, resumeAt: 0, reason: 'no answer from the viewer' });
      }, 120_000);
    });
  }

  private pendingOffers = new Map<string, (answer: { accepted: boolean; resumeAt: number; reason?: string }) => void>();

  /** Host-initiated file push: paths picked through the OS dialog. */
  async sendPaths(paths: string[]): Promise<void> {
    if (!this.transfers) {
      this.events.toast('warn', tr('share.noViewer'));
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
          const source = new PathFileSource(item.path, meta);
          void this.transfers.send(source).catch((err) => {
            this.events.toast('error', tr('viewer.fileFailed', { name: item.name }), err instanceof Error ? err.message : String(err));
          });
        }
      } catch (err) {
        this.events.toast('error', tr('share.pathError'), err instanceof Error ? err.message : String(err));
      }
    }
  }

  // ------------------------------------------------------------------- messages

  private sendCtl(msg: CtlMessage): boolean {
    return this.peer?.sendCtl(msg) ?? false;
  }

  private onPeerState(connectionState: RTCPeerConnectionState, _detail?: string): void {
    if (connectionState === 'connected') {
      this.patch({ phase: 'live' });
      if (this.config.allowRemoteInput) void this.router.configure(true);
    } else if (connectionState === 'connecting' || connectionState === 'new') {
      this.patch({ phase: 'viewer-connecting' });
    } else if (connectionState === 'disconnected' || connectionState === 'failed' || connectionState === 'closed') {
      const hadViewer = this.state.viewer !== null;
      this.teardownPeer();
      this.patch({
        phase: this.state.code ? 'ready' : 'idle',
        viewer: null,
        controlGranted: false,
        controlRequested: false,
        stats: null
      });
      if (hadViewer) this.events.toast('warn', tr('share.viewerDisconnected'), tr('share.viewerDisconnectedDetail'));
    }
  }

  private teardownPeer(): void {
    void this.transfers?.dispose('viewer disconnected');
    this.transfers = null;
    this.peer?.close();
    this.peer = null;
    this.router.revoke();
  }

  private onCtlMessage(msg: ViewerToHost): void {
    switch (msg.t) {
      case 'hello':
        this.patch({
          viewer: {
            name: msg.viewerName || this.pendingViewer?.name || 'viewer',
            platform: msg.platform,
            wantsControl: msg.wantsControl
          }
        });
        this.events.toast(
          'info',
          `${msg.viewerName || 'A viewer'} connected`,
          this.state.maxViewers === 1 ? 'This session is now full: one host, one viewer.' : undefined
        );
        break;

      case 'request-control':
        this.patch({ controlRequested: true });
        this.events.toast('info', tr('share.requestControlToast'), tr('share.requestControlToastDetail'));
        break;

      case 'release-control':
        this.setControlGranted(false);
        this.events.toast('info', tr('share.controlRevokedToast'));
        break;

      case 'input':
        this.router.handle(msg.cmd);
        if (msg.cmd.k === 'clipboard') this.events.remoteClipboard(msg.cmd.s);
        break;

      case 'clipboard':
        this.router.applyRemoteClipboard(msg.text);
        this.events.remoteClipboard(msg.text);
        break;

      case 'set-quality':
        this.config = { ...this.config, quality: { ...this.config.quality, ...msg.quality } };
        if (this.captureStream) {
          const videoTrack = this.captureStream.getVideoTracks()[0];
          if (videoTrack && msg.quality.fps) {
            void videoTrack.applyConstraints({ frameRate: msg.quality.fps } as MediaTrackConstraints).catch(() => undefined);
          }
        }
        this.sendCtl({ t: 'quality', quality: this.config.quality });
        break;

      // ---- file transfer replies ----
      case 'file-accept': {
        const resolve = this.pendingOffers.get(msg.id);
        if (resolve) {
          this.pendingOffers.delete(msg.id);
          resolve({ accepted: true, resumeAt: msg.resumeAt ?? 0 });
        }
        break;
      }
      case 'file-reject': {
        const resolve = this.pendingOffers.get(msg.id);
        if (resolve) {
          this.pendingOffers.delete(msg.id);
          resolve({ accepted: false, resumeAt: 0, reason: msg.reason });
        }
        break;
      }
      case 'file-offer':
        void this.transfers?.handleOffer(msg.file, 'viewer');
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
        this.transfers?.onProgress(msg.id, msg.have);
        break;

      case 'ping':
        this.sendCtl({ t: 'pong', seq: msg.seq });
        break;
      case 'pong':
        break;
    }
  }

  private setControlGranted(granted: boolean): void {
    this.patch({ controlGranted: granted, controlRequested: granted ? false : this.state.controlRequested });
    this.sendCtl({ t: 'control-state', granted });
    if (granted) {
      void this.router.grant().then((ok) => {
        if (!ok) {
          this.patch({ controlGranted: false });
          this.sendCtl({ t: 'control-state', granted: false, reason: tr('share.helperFailedToast') });
        }
      });
    } else {
      this.router.revoke();
    }
  }

  async grantControl(): Promise<void> {
    this.setControlGranted(true);
  }

  denyControl(): void {
    this.patch({ controlRequested: false });
    this.sendCtl({ t: 'control-state', granted: false, reason: tr('share.declinedControl') });
  }

  async setAllowRemoteInput(allow: boolean): Promise<void> {
    this.config = { ...this.config, allowRemoteInput: allow };
    await this.router.configure(allow);
    if (!allow && this.state.controlGranted) this.setControlGranted(false);
    if (this.sessionInfo) this.sessionInfo = { ...this.sessionInfo, allowRemoteInput: allow };
  }

  async setQuality(patch: Partial<QualitySettings>): Promise<QualitySettings> {
    const previous = this.config.quality;
    this.config = { ...this.config, quality: { ...previous, ...patch } };
    if (this.captureStream) {
      const track = this.captureStream.getVideoTracks()[0];
      if (track && patch.fps) {
        void track.applyConstraints({ frameRate: patch.fps } as MediaTrackConstraints).catch(() => undefined);
      }
    }
    if (this.sessionInfo) this.sessionInfo = { ...this.sessionInfo, quality: this.config.quality };
    this.sendCtl({ t: 'quality', quality: this.config.quality });

    // Turning audio on or off needs a fresh capture: tracks cannot be added to an
    // already-negotiated stream.
    if (patch.audio !== undefined && patch.audio !== previous.audio) {
      try {
        await this.reacquireCapture();
        this.events.toast('info', patch.audio ? tr('share.audioOnToast') : tr('share.audioOffToast'));
      } catch (err) {
        this.events.toast('warn', tr('share.audioFailed'), err instanceof Error ? err.message : String(err));
      }
    }
    return this.config.quality;
  }

  async setPassword(password: string): Promise<void> {
    this.config = { ...this.config, password };
    this.passwordHash = await hashPassword(password);
    this.signaling.send({ t: 'host-update', passwordHash: this.passwordHash });
  }

  /** Abort an outgoing transfer from the UI. */
  async cancelTransfer(id: string): Promise<void> {
    await this.transfers?.cancelSend(id, true);
  }

  /** Host pushes its clipboard to the viewer. */
  async sendClipboard(text: string): Promise<void> {
    this.sendCtl({ t: 'clipboard', text, from: 'host' });
  }

  async sendChat(text: string): Promise<void> {
    this.sendCtl({ t: 'chat', text, at: Date.now() });
  }

  // -------------------------------------------------------------- signalling

  onSignalingEvent(event: SignalingEvent): void {
    switch (event.t) {
      case 'host-ok':
        this.iceServers = event.iceServers || [];
        this.patch({
          phase: 'ready',
          code: formatCode(event.code),
          error: null,
          maxViewers: event.maxViewers ?? 1
        });
        break;
      case 'viewer-joined': {
        // One viewer at a time. If someone else already holds the slot the server has
        // disconnected them and told us to renegotiate, so tear the old peer connection
        // down before touching it - otherwise a late ICE packet from the previous viewer
        // could land in the new negotiation.
        const seq = event.seq ?? this.epoch + 1;
        const replacing = this.state.viewer !== null || this.peer !== null;
        if (replacing) {
          const name = this.state.viewer?.name || tr('share.previousViewer');
          this.events.toast('warn', tr('share.viewerReplaced'), tr('share.viewerReplacedDetail', { name }));
        }
        this.epoch = seq;
        this.pendingViewer = { name: String(event.viewerName || tr('share.viewerNameFallback')) };
        trace(`viewer-joined: slot ${seq}${replacing ? ' (replacing previous viewer)' : ''}`);
        this.teardownPeer();
        this.transferList.clear();
        this.emitTransfers();
        this.patch({
          phase: 'viewer-connecting',
          viewer: { name: String(event.viewerName || 'viewer'), platform: '', wantsControl: false },
          controlGranted: false,
          controlRequested: false,
          stats: null,
          replacedViewers: replacing ? this.state.replacedViewers + 1 : this.state.replacedViewers
        });
        void this.ensurePeer()
          .then((peer) => this.createOffer(peer))
          .catch((err) => this.events.toast('error', tr('share.startFailedSession'), err instanceof Error ? err.message : String(err)));
        break;
      }
      case 'join-failed':
        this.events.toast('warn', tr('share.wrongPasswordAttempt'));
        break;
      case 'viewer-gone':
        // Ignore the goodbye from a viewer we already replaced.
        if (event.seq !== undefined && event.seq !== this.epoch) break;
        this.teardownPeer();
        this.transferList.clear();
        this.emitTransfers();
        this.patch({
          phase: this.state.code ? 'ready' : 'idle',
          viewer: null,
          controlGranted: false,
          controlRequested: false,
          stats: null
        });
        break;
      case 'signal':
        // Slot numbers only move forward. Adopt a newer one (the server may have bumped
        // it for a viewer we have not been told about yet) and drop anything older, which
        // is a replaced viewer still finishing its handshake.
        if (event.seq !== undefined) {
          if (event.seq < this.epoch) {
            trace(`dropped signal from superseded slot ${event.seq} (epoch ${this.epoch})`);
            break;
          }
          this.epoch = event.seq;
        }
        void this.onSignal(event.payload);
        break;
      case 'error':
        if (['too-many-rooms', 'bad-password'].includes(event.code)) {
          this.patch({ phase: 'error', error: event.message });
        }
        break;
      default:
        break;
    }
  }

  private async onSignal(payload: unknown): Promise<void> {
    const data = payload as { kind?: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null };
    const peer = this.peer ?? (await this.ensurePeer());
    try {
      if (data.kind === 'answer' && data.sdp) {
        trace(`applying answer (slot ${this.peerEpoch})`);
        await peer.applyRemoteDescription(data.sdp);
      } else if (data.kind === 'offer' && data.sdp) {
        // Viewer-initiated renegotiation.
        await peer.applyRemoteDescription(data.sdp);
        const answer = await peer.createAnswer();
        this.signaling.send({ t: 'signal', payload: { kind: 'answer', sdp: answer, from: 'host' }, seq: this.peerEpoch });
      } else if (data.kind === 'ice') {
        await peer.addIceCandidate(data.candidate ?? null);
      }
    } catch (err) {
      this.events.toast('error', tr('connect.errorNegotiation'), err instanceof Error ? err.message : String(err));
    }
  }

  private async createOffer(peer: PeerConnection): Promise<void> {
    if (this.offering) return;
    this.offering = true;
    try {
      const offer = await peer.createOffer();
      await peer.limitVideoBitrate(this.config.quality.fps >= 30 ? 12_000 : 6_000);
      trace(`sending offer for slot ${this.peerEpoch}`);
      this.signaling.send({ t: 'signal', payload: { kind: 'offer', sdp: offer, from: 'host' }, seq: this.peerEpoch });
    } catch (err) {
      this.events.toast('error', tr('share.startFailedSession'), err instanceof Error ? err.message : String(err));
    } finally {
      this.offering = false;
    }
  }

  stop(): void {
    this.teardownPeer();
    stopStream(this.captureStream);
    this.captureStream = null;
    this.router.dispose();
    void api().inputStop().catch(() => undefined);
    this.passwordHash = '';
    this.epoch = 0;
    this.pendingViewer = null;
    this.transferList.clear();
    this.patch({ ...initialState, helper: this.state.helper });
  }
}

function friendlyCaptureError(message: string): string {
  if (/permission|denied|notallowed/i.test(message)) {
    return tr('share.startFailedCapture');
  }
  if (/could not start|failed to start/i.test(message)) return tr('share.startFailedWindows');
  return message;
}
