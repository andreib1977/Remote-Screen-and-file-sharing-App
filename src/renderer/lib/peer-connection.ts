/**
 * WebRTC wrapper: one RTCPeerConnection per session, two data channels
 * (`ctl` for JSON, `file` for binary chunks) plus the screen media track.
 */

import type { CtlMessage } from '../../shared/protocol';
import type { IceServerConfig } from './signaling-client';

export type PeerRole = 'host' | 'viewer';

export interface PeerEvents {
  state: (state: RTCPeerConnectionState, detail?: string) => void;
  ctlOpen: () => void;
  ctlClose: () => void;
  ctlMessage: (msg: CtlMessage) => void;
  fileOpen: () => void;
  fileClose: () => void;
  fileBinary: (data: ArrayBuffer) => void;
  remoteStream: (stream: MediaStream) => void;
  iceCandidate: (candidate: RTCIceCandidateInit | null) => void;
  stats: (stats: PeerStats) => void;
}

export interface PeerStats {
  /** kbit/s of received video */
  bitrateKbps: number;
  fps: number;
  width: number;
  height: number;
  packetsLost: number;
  rttMs: number;
  /** bytes waiting to be written to the data channel */
  bufferedAmount: number;
}

const DEFAULT_ICE: IceServerConfig[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * Diagnostics for scripted runs (`PEERLINK_AUTOPILOT=1`), which append to a per-instance log
 * file. Inert in normal use: `api().autopilot` is undefined, so this costs one no-op call.
 *
 * Kept deliberately: the takeover race this exposed is intermittent and effectively
 * undiagnosable without it.
 */
function trace(role: string, message: string): void {
  void import('./hooks')
    .then(({ api }) => api().autopilot?.log(`${role}: ${message}`))
    .catch(() => undefined);
}

/** Trickle nothing: batching candidates over the signalling socket is simpler and fast enough. */
export class PeerConnection {
  readonly pc: RTCPeerConnection;
  private ctl: RTCDataChannel | null = null;
  private file: RTCDataChannel | null = null;
  private drainCallbacks = new Set<() => void>();
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private lastStats = { bytes: 0, at: 0 };
  private lastFrames = { frames: 0, at: 0 };
  /** Combined inbound tracks on the viewer side. */
  private remoteStream: MediaStream | null = null;
  private iceSent = 0;
  private iceReceived = 0;

  /** Monotonic id so interleaved logs from successive connections stay readable. */
  private static instances = 0;
  private readonly instance = ++PeerConnection.instances;

  constructor(
    public readonly role: PeerRole,
    private readonly events: PeerEvents,
    iceServers: IceServerConfig[] = DEFAULT_ICE
  ) {
    this.pc = new RTCPeerConnection({
      iceServers: iceServers.length ? iceServers : DEFAULT_ICE,
      /**
       * No pre-gathering.
       *
       * A pool gathers a candidate as soon as the connection is constructed, which is a
       * latency win only when you build one connection and keep it. We churn them: a viewer
       * takeover closes the previous connection microseconds after the new one is created,
       * and the pooled candidate then refers to a socket that is being torn down. The result
       * was a peer connection that gathered nothing, never left `new`, and left the new
       * viewer stuck on "negotiating" with no data channels - intermittently, which is the
       * worst kind of failure to debug.
       */
      iceCandidatePoolSize: 0,
      bundlePolicy: 'max-bundle'
    });
    trace(this.role, `pc#${this.instance} created`);

    this.pc.onconnectionstatechange = () => {
      trace(this.role, `pc#${this.instance} state=${this.pc.connectionState} ice=${this.pc.iceConnectionState}`);
      this.events.state(this.pc.connectionState);
      if (this.pc.connectionState === 'failed') {
        try {
          this.pc.restartIce();
        } catch {
          /* older builds */
        }
      }
    };
    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === 'failed') {
        try {
          this.pc.restartIce();
        } catch {
          /* ignore */
        }
      }
    };
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.iceSent++;
        if (this.iceSent <= 3) trace(this.role, `pc#${this.instance} ice sent #${this.iceSent}`);
        this.events.iceCandidate(ev.candidate.toJSON());
      } else {
        trace(this.role, `pc#${this.instance} ice gathering done (${this.iceSent} candidate(s))`);
      }
    };
    this.pc.onicecandidateerror = (ev) => {
      const error = ev as RTCPeerConnectionIceErrorEvent;
      trace(this.role, `pc#${this.instance} ice candidate error: ${error.errorCode} ${error.errorText} (${error.url ?? ''})`);
    };

    // Viewer side: collect the host's screen (and audio) into one renderable stream.
    const inbound = new MediaStream();
    this.remoteStream = inbound;
    this.pc.ontrack = (ev) => {
      for (const stream of ev.streams) {
        for (const track of stream.getTracks()) {
          if (!inbound.getTracks().some((t) => t.id === track.id)) inbound.addTrack(track);
        }
      }
      if (!inbound.getTracks().some((t) => t.id === ev.track.id)) {
        inbound.addTrack(ev.track);
      }
      this.events.remoteStream(inbound);
    };

    if (role === 'viewer') {
      // The viewer answers, so it cannot create channels: the offer it must answer is
      // built before it exists. The host creates `ctl` and `file` in its offer, and they
      // arrive here through `ondatachannel`.
      this.pc.ondatachannel = (ev) => this.attachChannel(ev.channel);
    }
  }

  /**
   * Host side: create both data channels. Must be called before `createOffer()`, because
   * a data channel only appears in the SDP of the side that creates it.
   */
  createChannels(): void {
    if (this.ctl && this.file) return;
    this.ctl = this.createChannel('ctl', { ordered: true });
    this.file = this.createChannel('file', { ordered: true });
  }

  private createChannel(label: string, options: RTCDataChannelInit): RTCDataChannel {
    const channel = this.pc.createDataChannel(label, options);
    this.attachChannel(channel);
    return channel;
  }

  private attachChannel(channel: RTCDataChannel): void {
    trace(this.role, `pc#${this.instance} channel ${channel.label} attached (${channel.readyState})`);
    if (channel.label === 'ctl') {
      this.ctl = channel;
      channel.onopen = () => {
        trace(this.role, `pc#${this.instance} ctl OPEN`);
        this.events.ctlOpen();
      };
      channel.onclose = () => {
        trace(this.role, `pc#${this.instance} ctl closed`);
        this.events.ctlClose();
      };
      channel.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        try {
          this.events.ctlMessage(JSON.parse(ev.data) as CtlMessage);
        } catch {
          /* ignore malformed control frames */
        }
      };
    } else if (channel.label === 'file') {
      this.file = channel;
      // Frames are 64 KiB; let a handful sit in the transport buffer before we wait.
      try {
        channel.bufferedAmountLowThreshold = 1 * 1024 * 1024;
      } catch {
        /* ignore */
      }
      channel.binaryType = 'arraybuffer';
      channel.onopen = () => {
        trace(this.role, `pc#${this.instance} file OPEN`);
        this.events.fileOpen();
      };
      channel.onclose = () => {
        trace(this.role, `pc#${this.instance} file closed`);
        this.events.fileClose();
      };
      channel.onbufferedamountlow = () => {
        for (const cb of this.drainCallbacks) cb();
      };
      channel.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) this.events.fileBinary(ev.data);
        else if (ev.data instanceof Blob) void ev.data.arrayBuffer().then((buf) => this.events.fileBinary(buf));
      };
    }
  }

  get ctlChannel(): RTCDataChannel | null {
    return this.ctl;
  }

  get fileChannel(): RTCDataChannel | null {
    return this.file;
  }

  ctlReady(): boolean {
    return !!this.ctl && this.ctl.readyState === 'open';
  }

  sendCtl(msg: CtlMessage): boolean {
    if (!this.ctl || this.ctl.readyState !== 'open') return false;
    try {
      this.ctl.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  sendBinary(data: ArrayBuffer | Uint8Array): boolean {
    if (!this.file || this.file.readyState !== 'open') return false;
    try {
      if (data instanceof Uint8Array) {
        // Send an exact ArrayBuffer slice rather than a view onto a larger buffer.
        this.file.send(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      } else {
        this.file.send(data);
      }
      return true;
    } catch {
      return false;
    }
  }

  onDrain(cb: () => void): () => void {
    this.drainCallbacks.add(cb);
    return () => this.drainCallbacks.delete(cb);
  }

  get fileBufferedAmount(): number {
    return this.file?.bufferedAmount ?? 0;
  }

  get fileReadyState(): string {
    return this.file?.readyState ?? 'closed';
  }

  /** Host side: attach the captured desktop (and optional loopback audio). */
  addStream(stream: MediaStream): void {
    for (const track of stream.getTracks()) {
      const existing = this.pc.getSenders().find((s) => s.track?.kind === track.kind);
      if (existing) {
        void existing.replaceTrack(track);
      } else {
        this.pc.addTrack(track, stream);
      }
    }
  }

  /** Viewer side: ask for a keyframe-sized bitrate and request the media. */
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  /** Diagnostic: a compact summary of media/data sections in an SDP. */
  static describeSdp(sdp: string | undefined): string {
    if (!sdp) return '(no sdp)';
    const media = (sdp.match(/^m=[^\r\n]*/gm) ?? []).map((line) => line.trim());
    const channels = this.channelSummary(sdp);
    return `${media.length} m-line(s) [${media.join(' | ')}] ${channels}`;
  }

  private static channelSummary(sdp: string): string {
    const applications = (sdp.match(/m=application[^\r\n]*/g) ?? []).length;
    const sctp = /^a=sctp-port:/m.test(sdp) ? 'sctp-port' : 'no-sctp-port';
    return `application=${applications} ${sctp}`;
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  async applyRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(description));
    this.remoteSet = true;
    const pending = this.pendingCandidates.splice(0);
    for (const candidate of pending) {
      await this.pc.addIceCandidate(candidate).catch(() => undefined);
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    if (!candidate) return;
    if (!this.remoteSet) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.pc.addIceCandidate(candidate).catch(() => undefined);
  }

  /** Cap the outgoing video bitrate so a shared 4K screen does not saturate a small uplink. */
  async limitVideoBitrate(maxKbps: number): Promise<void> {
    const sender = this.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = maxKbps * 1000;
    params.encodings[0].maxFramerate = 60;
    await sender.setParameters(params).catch(() => undefined);
  }

  startStats(intervalMs = 1000): void {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => void this.collectStats(), intervalMs);
  }

  private async collectStats(): Promise<void> {
    try {
      const report = await this.pc.getStats();
      let bytes = 0;
      let frames = 0;
      let width = 0;
      let height = 0;
      let packetLoss = 0;
      let rtt = 0;

      report.forEach((entry) => {
        const stat = entry as Record<string, unknown> & { type: string };
        if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
          bytes += Number(stat.bytesReceived || 0);
          frames += Number(stat.framesDecoded || 0);
          width = Number(stat.frameWidth || width);
          height = Number(stat.frameHeight || height);
          packetLoss += Number(stat.packetsLost || 0);
        } else if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && Number(stat.nominated || 0) >= 0) {
          const current = Number(stat.currentRoundTripTime);
          if (!Number.isNaN(current) && current > 0) rtt = current * 1000;
        } else if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
          // host side: report what we are actually pushing
          bytes += Number(stat.bytesSent || 0);
          frames += Number(stat.framesEncoded || 0);
          width = Number(stat.frameWidth || width);
          height = Number(stat.frameHeight || height);
        }
      });

      const now = Date.now();
      const bitrateKbps = this.lastStats.at ? (Math.max(0, bytes - this.lastStats.bytes) * 8) / (now - this.lastStats.at) : 0;
      const fps = this.lastFrames.at ? (Math.max(0, frames - this.lastFrames.frames) * 1000) / (now - this.lastFrames.at) : 0;
      this.lastStats = { bytes, at: now };
      this.lastFrames = { frames, at: now };

      this.events.stats({
        bitrateKbps: Math.round(bitrateKbps),
        fps: Math.round(fps),
        width,
        height,
        packetsLost: packetLoss,
        rttMs: Math.round(rtt),
        bufferedAmount: this.fileBufferedAmount
      });
    } catch {
      /* stats are best-effort */
    }
  }

  close(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    for (const channel of [this.ctl, this.file]) {
      if (!channel) continue;
      channel.onopen = null;
      channel.onclose = null;
      channel.onmessage = null;
      channel.onbufferedamountlow = null;
      try {
        channel.close();
      } catch {
        /* ignore */
      }
    }
    this.pc.onconnectionstatechange = null;
    this.pc.onicecandidate = null;
    this.pc.ondatachannel = null;
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
  }
}
