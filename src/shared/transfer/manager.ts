/**
 * File transfer over a WebRTC data channel, in both directions.
 *
 * Correctness rules that matter for "any size":
 *   - we never buffer a whole file in memory: the source is read chunk by chunk on demand
 *   - we respect `bufferedAmount` so a 50 GB file cannot blow up the renderer heap
 *   - chunks carry their own offset, so an interrupted transfer can resume from `have`
 *   - the receiver verifies offsets, so a dropped/reordered chunk is detected, not silently corrupt
 */

import { DecodedChunk, decodeChunk, encodeChunk } from './framing';
import { CHUNK_SIZE, MAX_CONCURRENT_FILES, MAX_IN_FLIGHT_BYTES } from '../protocol';
import type { FileMeta } from '../protocol';

/** Random, unique per transfer. */
export function newTransferId(): string {
  const bytes = new Uint8Array(8);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A channel that can carry framed binary chunks. */
export interface BinaryChannel {
  readonly bufferedAmount: number;
  readonly readyState: string;
  send(data: ArrayBuffer | ArrayBufferView | string): void;
  /** Called by the manager to know when bufferedAmount drained. */
  onDrain(cb: () => void): () => void;
}

/** Reads a local file/Blob chunk by chunk. */
export interface FileSource {
  readonly meta: FileMeta;
  /** Read exactly `length` bytes at `offset`; may return fewer only at EOF. */
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Writes a received file to disk. */
export interface FileSink {
  write(offset: number, data: Uint8Array): Promise<void>;
  close(): Promise<{ savedPath?: string }>;
  abort(reason: string): Promise<void>;
  /** Bytes already present (used for resume). */
  sizeOnDisk(): Promise<number>;
}

export type TransferDirection = 'send' | 'receive';
export type TransferStatus = 'offered' | 'active' | 'paused' | 'done' | 'failed' | 'cancelled' | 'rejected';

export interface TransferRecord {
  id: string;
  direction: TransferDirection;
  meta: FileMeta;
  status: TransferStatus;
  /** bytes confirmed on the far side (send) or written locally (receive) */
  progress: number;
  bytesPerSecond: number;
  startedAt: number;
  finishedAt?: number;
  savedPath?: string;
  error?: string;
  /** sink/source are internal, kept off the UI payload */
}

export interface TransferEvents {
  offer: (rec: TransferRecord) => void;
  accept: (rec: TransferRecord) => void;
  reject: (rec: TransferRecord) => void;
  progress: (rec: TransferRecord) => void;
  done: (rec: TransferRecord) => void;
  failed: (rec: TransferRecord) => void;
  cancelled: (rec: TransferRecord) => void;
  changed: (rec: TransferRecord) => void;
}

export interface SendTarget {
  /** Ask the remote side to accept; resolves with the offset to start from. */
  offer(meta: FileMeta, from: 'host' | 'viewer'): Promise<{ accepted: boolean; resumeAt: number; reason?: string }>;
  /** Inform the remote side of progress/done/cancel. */
  notice(msg: { t: 'file-progress' | 'file-done' | 'file-cancel' | 'file-resume-request'; id: string; received?: number; ok?: boolean; savedPath?: string; error?: string; by?: 'host' | 'viewer'; have?: number }): void;
}

export interface ReceiveTarget {
  accept(id: string, resumeAt: number): void;
  reject(id: string, reason: string): void;
  notice(msg: { t: 'file-progress' | 'file-done' | 'file-cancel'; id: string; received?: number; ok?: boolean; savedPath?: string; error?: string; by?: 'host' | 'viewer' }): void;
  /** Ask the local user whether to accept; may be false for auto-accept. */
  shouldAutoAccept(meta: FileMeta, from: 'host' | 'viewer'): boolean;
  createSink(meta: FileMeta, from: 'host' | 'viewer'): Promise<FileSink>;
}

type Listener<K extends keyof TransferEvents> = TransferEvents[K];

interface SenderState {
  kind: 'send';
  rec: TransferRecord;
  source: FileSource;
  /** offset -> acknowledged */
  sentUpTo: number;
  ackedUpTo: number;
  nextOffset: number;
  inFlight: number;
  pumping: boolean;
  cancelled: boolean;
}

interface ReceiverState {
  kind: 'receive';
  rec: TransferRecord;
  sink: FileSink;
  expectedOffset: number;
  lastReported: number;
  paused: boolean;
}

export class TransferManager {
  private senders = new Map<string, SenderState>();
  private receivers = new Map<string, ReceiverState>();
  /** Serialises inbound frame handling so offsets are applied strictly in order. */
  private chunkQueue: Promise<void> = Promise.resolve();
  private listeners: { [K in keyof TransferEvents]: Set<Listener<K>> } = {
    offer: new Set(),
    accept: new Set(),
    reject: new Set(),
    progress: new Set(),
    done: new Set(),
    failed: new Set(),
    cancelled: new Set(),
    changed: new Set()
  };

  constructor(
    private readonly opts: {
      channel: BinaryChannel;
      role: 'host' | 'viewer';
      sendTarget: SendTarget;
      receiveTarget: ReceiveTarget;
      maxConcurrent?: number;
      chunkSize?: number;
      maxInFlightBytes?: number;
      now?: () => number;
      /** percentage change required before emitting a progress event */
      progressStepPercent?: number;
    }
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  get chunkSize(): number {
    return this.opts.chunkSize ?? CHUNK_SIZE;
  }

  get maxInFlight(): number {
    return this.opts.maxInFlightBytes ?? MAX_IN_FLIGHT_BYTES;
  }

  on<K extends keyof TransferEvents>(event: K, cb: Listener<K>): () => void {
    this.listeners[event].add(cb as never);
    return () => this.listeners[event].delete(cb as never);
  }

  private emit<K extends keyof TransferEvents>(event: K, rec: TransferRecord): void {
    for (const cb of this.listeners[event]) {
      try {
        (cb as (r: TransferRecord) => void)(rec);
      } catch {
        /* a broken listener must not stall the transfer */
      }
    }
  }

  list(): TransferRecord[] {
    return [...this.senders.values(), ...this.receivers.values()].map((s) => s.rec);
  }

  activeSendCount(): number {
    return [...this.senders.values()].filter((s) => s.rec.status === 'active').length;
  }

  // ------------------------------------------------------------------ sending

  /**
   * Offer a file to the peer. Returns the record; the actual bytes start flowing
   * once the peer accepts (or immediately, for auto-accept).
   */
  async send(source: FileSource): Promise<TransferRecord> {
    const meta = source.meta;
    const rec: TransferRecord = {
      id: meta.id || newTransferId(),
      direction: 'send',
      meta: { ...meta, id: meta.id || '' },
      status: 'offered',
      progress: 0,
      bytesPerSecond: 0,
      startedAt: this.now()
    };
    rec.meta.id = rec.id;

    const state: SenderState = {
      kind: 'send',
      rec,
      source,
      sentUpTo: 0,
      ackedUpTo: 0,
      nextOffset: 0,
      inFlight: 0,
      pumping: false,
      cancelled: false
    };
    this.senders.set(rec.id, state);
    this.emit('offer', rec);
    this.emit('changed', rec);

    const offerMeta: FileMeta = { ...rec.meta };
    const answer = await this.opts.sendTarget.offer(offerMeta, this.opts.role);
    if (!answer.accepted) {
      rec.status = 'rejected';
      rec.error = answer.reason || 'Declined';
      rec.finishedAt = this.now();
      await source.close().catch(() => undefined);
      this.emit('reject', rec);
      this.emit('changed', rec);
      return rec;
    }

    state.nextOffset = Math.max(0, Math.min(answer.resumeAt || 0, rec.meta.size));
    state.sentUpTo = state.nextOffset;
    state.ackedUpTo = state.nextOffset;
    rec.progress = state.nextOffset;
    rec.status = 'active';
    this.emit('accept', rec);
    void this.pump(state);
    return rec;
  }

  private async pump(state: SenderState): Promise<void> {
    if (state.pumping) return;
    state.pumping = true;
    const { rec, source } = state;
    const startedAt = this.now();
    let lastSampleAt = startedAt;
    let lastSampleBytes = rec.progress;

    try {
      while (!state.cancelled && state.nextOffset < rec.meta.size) {
        if (this.opts.channel.readyState !== 'open') {
          await this.waitForDrain(250);
          continue;
        }
        if (this.opts.channel.bufferedAmount > this.maxInFlight) {
          await this.waitForDrain(20);
          continue;
        }

        const length = Math.min(this.chunkSize, rec.meta.size - state.nextOffset);
        const payload = await source.read(state.nextOffset, length);
        if (state.cancelled) break;
        if (payload.byteLength === 0) throw new Error('source returned no data before EOF');

        const frame = encodeChunk(rec.id, state.nextOffset, payload);
        this.opts.channel.send(frame);
        state.nextOffset += payload.byteLength;
        state.sentUpTo = state.nextOffset;
        state.inFlight = this.opts.channel.bufferedAmount;

        const t = this.now();
        if (t - lastSampleAt >= 500) {
          const delta = state.sentUpTo - lastSampleBytes;
          rec.bytesPerSecond = (delta * 1000) / (t - lastSampleAt);
          lastSampleAt = t;
          lastSampleBytes = state.sentUpTo;
        }
      }

      if (state.cancelled) return;
      // Wait for the receiver to confirm the tail of the file before declaring success.
      const deadline = this.now() + 120_000;
      while (state.ackedUpTo < rec.meta.size && this.now() < deadline && !state.cancelled) {
        await this.waitForDrain(50);
      }
      if (state.cancelled) return;
      if (state.ackedUpTo < rec.meta.size) {
        throw new Error(`peer did not acknowledge the last ${rec.meta.size - state.ackedUpTo} bytes`);
      }

      rec.status = 'done';
      rec.progress = rec.meta.size;
      rec.finishedAt = this.now();
      this.opts.sendTarget.notice({ t: 'file-done', id: rec.id, ok: true });
      this.emit('done', rec);
      this.emit('changed', rec);
    } catch (err) {
      if (state.cancelled) return;
      rec.status = 'failed';
      rec.error = err instanceof Error ? err.message : String(err);
      rec.finishedAt = this.now();
      this.opts.sendTarget.notice({ t: 'file-done', id: rec.id, ok: false, error: rec.error });
      this.emit('failed', rec);
      this.emit('changed', rec);
    } finally {
      state.pumping = false;
      await source.close().catch(() => undefined);
    }
  }

  private waitForDrain(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        off();
        clearTimeout(timer);
        resolve();
      };
      const off = this.opts.channel.onDrain(done);
      const timer = setTimeout(done, ms);
    });
  }

  /** Receiver confirms bytes written; used to advance the ack window. */
  onProgress(id: string, received: number): void {
    const state = this.senders.get(id);
    if (!state) return;
    state.ackedUpTo = Math.max(state.ackedUpTo, Math.min(received, state.rec.meta.size));
    const pct = state.rec.meta.size === 0 ? 100 : (state.ackedUpTo / state.rec.meta.size) * 100;
    const lastPct = (state.rec.progress / Math.max(1, state.rec.meta.size)) * 100;
    state.rec.progress = state.ackedUpTo;
    const step = this.opts.progressStepPercent ?? 0.5;
    if (step <= 0 || pct - lastPct >= step || state.ackedUpTo === state.rec.meta.size) {
      this.emit('progress', state.rec);
      this.emit('changed', state.rec);
    }
  }

  /** Local cancel of an outgoing transfer. */
  async cancelSend(id: string, notifyPeer = true): Promise<void> {
    const state = this.senders.get(id);
    if (!state) return;
    state.cancelled = true;
    state.rec.status = 'cancelled';
    state.rec.finishedAt = this.now();
    if (notifyPeer) this.opts.sendTarget.notice({ t: 'file-cancel', id, by: this.opts.role });
    this.emit('cancelled', state.rec);
    this.emit('changed', state.rec);
    await state.source.close().catch(() => undefined);
  }

  // ---------------------------------------------------------------- receiving

  /** Remote peer offered a file. */
  async handleOffer(meta: FileMeta, from: 'host' | 'viewer'): Promise<void> {
    const rec: TransferRecord = {
      id: meta.id,
      direction: 'receive',
      meta,
      status: 'offered',
      progress: 0,
      bytesPerSecond: 0,
      startedAt: this.now()
    };
    this.emit('offer', rec);
    this.emit('changed', rec);

    if (this.receivers.has(meta.id)) {
      this.opts.receiveTarget.reject(meta.id, 'Duplicate transfer id.');
      return this.finishReject(rec, 'Duplicate transfer id.');
    }
    if (this.receivers.size + this.senders.size >= (this.opts.maxConcurrent ?? MAX_CONCURRENT_FILES) * 4) {
      this.opts.receiveTarget.reject(meta.id, 'Too many transfers in flight.');
      return this.finishReject(rec, 'Too many transfers in flight.');
    }

    try {
      const sink = await this.opts.receiveTarget.createSink(meta, from);
      const have = await sink.sizeOnDisk();
      const resumeAt = have > 0 && have < meta.size ? have : 0;
      const state: ReceiverState = {
        kind: 'receive',
        rec,
        sink,
        expectedOffset: resumeAt,
        lastReported: resumeAt,
        paused: false
      };
      this.receivers.set(meta.id, state);
      rec.progress = resumeAt;
      rec.status = 'active';
      this.opts.receiveTarget.accept(meta.id, resumeAt);
      this.emit('accept', rec);
      this.emit('changed', rec);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.opts.receiveTarget.reject(meta.id, reason);
      await this.finishReject(rec, reason);
    }
  }

  private async finishReject(rec: TransferRecord, reason: string): Promise<void> {
    rec.status = 'rejected';
    rec.error = reason;
    rec.finishedAt = this.now();
    this.emit('reject', rec);
    this.emit('changed', rec);
  }

  /**
   * A binary frame arrived on the `file` channel.
   *
   * Frames are serialised through `chunkQueue`: a data channel delivers in order, but
   * handling a frame is async (it writes to disk), so without this two frames can
   * interleave their awaits and be applied out of order.
   */
  handleChunk(bytes: ArrayBuffer | Uint8Array): Promise<void> {
    this.chunkQueue = this.chunkQueue.then(
      () => this.processChunk(bytes),
      () => this.processChunk(bytes)
    );
    return this.chunkQueue;
  }

  private async processChunk(bytes: ArrayBuffer | Uint8Array): Promise<void> {
    let decoded: DecodedChunk;
    try {
      decoded = decodeChunk(bytes);
    } catch {
      return; // corrupt frame: drop it, the ack window simply never advances
    }
    const state = this.receivers.get(decoded.transferId);
    if (!state) return; // cancelled or never accepted

    if (decoded.offset < state.expectedOffset) return; // already have it (resume overlap)
    if (decoded.offset > state.expectedOffset) {
      // A gap means we lost a chunk; stop and tell the sender exactly what we have.
      await this.failReceive(state, `chunk gap: expected ${state.expectedOffset}, got ${decoded.offset}`);
      this.opts.receiveTarget.notice({ t: 'file-cancel', id: state.rec.id, by: this.opts.role });
      return;
    }

    try {
      await state.sink.write(decoded.offset, decoded.payload);
    } catch (err) {
      await this.failReceive(state, err instanceof Error ? err.message : String(err));
      return;
    }

    state.expectedOffset += decoded.payload.byteLength;
    state.rec.progress = state.expectedOffset;
    const size = Math.max(1, state.rec.meta.size);
    const pct = (state.expectedOffset / size) * 100;
    const lastPct = (state.lastReported / size) * 100;
    const step = this.opts.progressStepPercent ?? 0.5;
    if (step <= 0 || pct - lastPct >= step || state.expectedOffset >= state.rec.meta.size) {
      state.lastReported = state.expectedOffset;
      this.opts.receiveTarget.notice({ t: 'file-progress', id: state.rec.id, received: state.expectedOffset });
      this.emit('progress', state.rec);
      this.emit('changed', state.rec);
    }

    if (state.expectedOffset >= state.rec.meta.size) {
      await this.completeReceive(state);
    }
  }

  private async completeReceive(state: ReceiverState): Promise<void> {
    this.receivers.delete(state.rec.id);
    try {
      const { savedPath } = await state.sink.close();
      state.rec.status = 'done';
      state.rec.savedPath = savedPath;
      state.rec.progress = state.rec.meta.size;
      state.rec.finishedAt = this.now();
      this.opts.receiveTarget.notice({ t: 'file-done', id: state.rec.id, ok: true, savedPath, received: state.rec.meta.size });
      this.emit('done', state.rec);
    } catch (err) {
      state.rec.status = 'failed';
      state.rec.error = err instanceof Error ? err.message : String(err);
      state.rec.finishedAt = this.now();
      this.opts.receiveTarget.notice({ t: 'file-done', id: state.rec.id, ok: false, error: state.rec.error });
      this.emit('failed', state.rec);
    }
    this.emit('changed', state.rec);
  }

  private async failReceive(state: ReceiverState, error: string): Promise<void> {
    this.receivers.delete(state.rec.id);
    state.rec.status = 'failed';
    state.rec.error = error;
    state.rec.finishedAt = this.now();
    await state.sink.abort(error).catch(() => undefined);
    this.opts.receiveTarget.notice({ t: 'file-done', id: state.rec.id, ok: false, error });
    this.emit('failed', state.rec);
    this.emit('changed', state.rec);
  }

  /** The far side reported its own outcome (or cancelled). */
  async handlePeerDone(msg: { id: string; ok?: boolean; error?: string; savedPath?: string; received?: number }): Promise<void> {
    const sendState = this.senders.get(msg.id);
    if (sendState) {
      if (msg.ok === false && sendState.rec.status !== 'done') {
        sendState.rec.status = 'failed';
        sendState.rec.error = msg.error || 'peer failed to save the file';
        sendState.rec.finishedAt = this.now();
        this.emit('failed', sendState.rec);
        this.emit('changed', sendState.rec);
      } else if (msg.ok === true) {
        sendState.rec.savedPath = msg.savedPath;
      }
      return;
    }
    const recvState = this.receivers.get(msg.id);
    if (recvState && msg.ok === true) {
      // The sender finished; make sure our sink is flushed even if the last chunk
      // notification was coalesced away.
      if (recvState.expectedOffset >= recvState.rec.meta.size) await this.completeReceive(recvState);
    }
  }

  async handlePeerCancel(id: string): Promise<void> {
    const recvState = this.receivers.get(id);
    if (recvState) {
      this.receivers.delete(id);
      recvState.rec.status = 'cancelled';
      recvState.rec.finishedAt = this.now();
      await recvState.sink.abort('cancelled by peer').catch(() => undefined);
      this.emit('cancelled', recvState.rec);
      this.emit('changed', recvState.rec);
    }
    const sendState = this.senders.get(id);
    if (sendState) {
      sendState.cancelled = true;
      sendState.rec.status = 'cancelled';
      sendState.rec.finishedAt = this.now();
      await sendState.source.close().catch(() => undefined);
      this.emit('cancelled', sendState.rec);
      this.emit('changed', sendState.rec);
    }
  }

  /** Drop everything, e.g. when the peer connection closes. */
  async dispose(reason = 'connection closed'): Promise<void> {
    for (const state of [...this.senders.values()]) {
      state.cancelled = true;
      if (state.rec.status === 'active' || state.rec.status === 'offered') {
        state.rec.status = 'failed';
        state.rec.error = reason;
        state.rec.finishedAt = this.now();
        this.emit('failed', state.rec);
        this.emit('changed', state.rec);
      }
      await state.source.close().catch(() => undefined);
    }
    for (const state of [...this.receivers.values()]) {
      if (state.rec.status === 'active') {
        state.rec.status = 'failed';
        state.rec.error = reason;
        state.rec.finishedAt = this.now();
        this.emit('failed', state.rec);
        this.emit('changed', state.rec);
      }
      await state.sink.abort(reason).catch(() => undefined);
    }
    this.senders.clear();
    this.receivers.clear();
  }
}

/** A FileSource backed by a Blob/File (renderer side). */
export class BlobFileSource implements FileSource {
  constructor(private readonly blob: Blob, public readonly meta: FileMeta) {}

  async read(offset: number, length: number): Promise<Uint8Array> {
    const slice = this.blob.slice(offset, Math.min(offset + length, this.blob.size));
    return new Uint8Array(await slice.arrayBuffer());
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}

/** In-memory sink, handy for tests and for "copy to host clipboard" style flows. */
export class MemorySink implements FileSink {
  readonly chunks: Uint8Array[] = [];
  public aborted: string | null = null;
  private written = 0;

  async write(_offset: number, data: Uint8Array): Promise<void> {
    this.chunks.push(data.slice());
    this.written += data.byteLength;
  }

  async sizeOnDisk(): Promise<number> {
    return this.written;
  }

  async close(): Promise<{ savedPath?: string }> {
    return {};
  }

  async abort(reason: string): Promise<void> {
    this.aborted = reason;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.written);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }
}
