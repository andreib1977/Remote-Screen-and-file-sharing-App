import { describe, expect, it } from 'vitest';
import { decodeChunk, encodeChunk, isChunkFrame, planChunks } from '../src/shared/transfer/framing';
import {
  MemorySink,
  TransferManager,
  type BinaryChannel,
  type FileSink,
  type FileSource,
  type ReceiveTarget,
  type SendTarget
} from '../src/shared/transfer/manager';
import type { FileMeta } from '../src/shared/protocol';
import { shouldForwardKey, isPanicCombo } from '../src/shared/input-protocol';
import { sanitizeName, sanitizeRelative } from '../src/main/file-bridge';

describe('chunk framing', () => {
  it('round-trips id, offset and payload', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const frame = encodeChunk('abc123', 4096, payload);
    expect(isChunkFrame(frame)).toBe(true);
    const decoded = decodeChunk(frame);
    expect(decoded.transferId).toBe('abc123');
    expect(decoded.offset).toBe(4096);
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3, 4, 5]);
  });

  it('handles offsets beyond 4 GiB without precision loss', () => {
    const offset = 5 * 1024 ** 3 + 12345; // 5 GiB + 12345
    const decoded = decodeChunk(encodeChunk('big', offset, new Uint8Array([9])));
    expect(decoded.offset).toBe(offset);
  });

  it('handles the largest safe offsets', () => {
    const offset = Number.MAX_SAFE_INTEGER - 1;
    const decoded = decodeChunk(encodeChunk('max', offset, new Uint8Array([1])));
    expect(decoded.offset).toBe(offset);
  });

  it('rejects garbage rather than silently mis-parsing', () => {
    expect(() => decodeChunk(new Uint8Array([0, 0, 0, 0]))).toThrow();
    expect(() => decodeChunk(new Uint8Array([0xf1, 0x1e, 9, 1, 65, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow(/version/);
    expect(isChunkFrame(new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('covers every byte when planning chunks', () => {
    for (const total of [0, 1, 255, 256, 1024, 100_000, 262_144, 262_145]) {
      const plan = planChunks(total, 256);
      expect(plan.reduce((a, b) => a + b, 0)).toBe(total);
      expect(plan.every((size) => size > 0 && size <= 256)).toBe(true);
    }
  });
});

/**
 * In-memory channel that models real backpressure: every frame is delivered on a later
 * macrotask, so `bufferedAmount` is non-zero while the sender is pushing.
 */
class FakeChannel implements BinaryChannel {
  readyState = 'open';
  frames: Uint8Array[] = [];
  delivered: Uint8Array[] = [];
  private buffered = 0;
  private drain = new Set<() => void>();
  private queue: Uint8Array[] = [];
  private running = false;

  /** ms between a frame being queued and being delivered */
  latencyMs = 1;

  onDeliver: ((frame: Uint8Array) => void) | null = null;

  get bufferedAmount(): number {
    return this.buffered;
  }

  send(data: ArrayBuffer | ArrayBufferView | string): void {
    if (typeof data === 'string') return;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    this.frames.push(bytes);
    this.queue.push(bytes);
    this.buffered += bytes.byteLength;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Deliver the whole in-flight window in one go, then yield: this models a real
    // channel (bytes leave together) without making the suite wait per frame.
    while (this.queue.length) {
      const batch = this.queue.splice(0);
      const bytes = batch.reduce((total, frame) => total + frame.byteLength, 0);
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
      for (const frame of batch) {
        this.delivered.push(frame);
        this.onDeliver?.(frame);
      }
      this.buffered = Math.max(0, this.buffered - bytes);
      for (const cb of [...this.drain]) cb();
    }
    this.running = false;
  }

  onDrain(cb: () => void): () => void {
    this.drain.add(cb);
    return () => this.drain.delete(cb);
  }

  asBinaryChannel(): BinaryChannel {
    return {
      get bufferedAmount() {
        return 0;
      },
      get readyState() {
        return 'open';
      },
      send: () => undefined,
      onDrain: () => () => undefined
    };
  }
}

class BufferSource implements FileSource {
  private offsetReads: number[] = [];
  constructor(private readonly bytes: Uint8Array, public readonly meta: FileMeta) {}

  async read(offset: number, length: number): Promise<Uint8Array> {
    this.offsetReads.push(offset);
    return this.bytes.subarray(offset, Math.min(offset + length, this.bytes.length));
  }

  async close(): Promise<void> {}

  get reads(): number[] {
    return this.offsetReads;
  }
}

class TrackingSink extends MemorySink {
  offsets: number[] = [];
  aborts: string[] = [];

  async write(offset: number, data: Uint8Array): Promise<void> {
    this.offsets.push(offset);
    await super.write(offset, data);
  }

  async abort(reason: string): Promise<void> {
    this.aborts.push(reason);
    await super.abort(reason);
  }
}

class ResumeSink implements FileSink {
  constructor(private readonly inner: TrackingSink, private readonly have: number) {}
  async write(offset: number, data: Uint8Array): Promise<void> {
    return this.inner.write(offset, data);
  }
  async sizeOnDisk(): Promise<number> {
    return this.have;
  }
  async close(): Promise<{ savedPath?: string }> {
    return this.inner.close();
  }
  async abort(reason: string): Promise<void> {
    return this.inner.abort(reason);
  }
}

interface PairOptions {
  chunkSize?: number;
  maxInFlightBytes?: number;
  latencyMs?: number;
  resumeAt?: number;
  /** make the receiving side refuse the offer */
  rejectReason?: string;
}

/** Builds two managers wired through one FakeChannel, exactly like a live session. */
function makePair(options: PairOptions = {}) {
  const channel = new FakeChannel();
  channel.latencyMs = options.latencyMs ?? 1;
  const sink = new TrackingSink();
  const offers: FileMeta[] = [];

  // Late-bound so each side's notices can reach the other manager.
  const holder: { sender?: TransferManager; receiver?: TransferManager } = {};
  /** resolved when the peer answers an offer */
  let answer: ((value: { accepted: boolean; resumeAt: number; reason?: string }) => void) | null = null;
  /** when set, offers are answered with a rejection instead */
  const rejectWith = options.rejectReason ?? null;

  const sender = new TransferManager({
    role: 'host',
    channel: {
      get bufferedAmount() {
        return channel.bufferedAmount;
      },
      get readyState() {
        return channel.readyState;
      },
      send: (data) => channel.send(data),
      onDrain: (cb) => channel.onDrain(cb)
    },
    sendTarget: {
      // The offer crosses the wire and comes back as an accept/reject from the peer.
      offer: async (meta) => {
        offers.push(meta);
        const accepted = new Promise<{ accepted: boolean; resumeAt: number; reason?: string }>((resolve) => {
          answer = resolve;
        });
        await holder.receiver!.handleOffer(meta, 'host');
        // The peer answers synchronously in-process; if it refused, report that.
        return answer ? accepted : { accepted: false, resumeAt: 0, reason: 'harness: no answer' };
      },
      // host -> viewer
      notice: (msg) =>
        queueMicrotask(() => {
          const receiver = holder.receiver!;
          if (msg.t === 'file-progress') receiver.onProgress(msg.id, msg.received ?? 0);
          else if (msg.t === 'file-done') void receiver.handlePeerDone(msg);
          else if (msg.t === 'file-cancel') void receiver.handlePeerCancel(msg.id);
        })
    },
    receiveTarget: {
      shouldAutoAccept: () => true,
      createSink: async () => new ResumeSink(sink, options.resumeAt ?? 0),
      accept: () => undefined,
      reject: () => undefined,
      notice: () => undefined
    },
    chunkSize: options.chunkSize ?? 64,
    maxInFlightBytes: options.maxInFlightBytes ?? 4096,
    progressStepPercent: 0
  });
  holder.sender = sender;

  const receiver = new TransferManager({
    role: 'viewer',
    channel: {
      get bufferedAmount() {
        return 0;
      },
      get readyState() {
        return 'open';
      },
      send: () => undefined,
      onDrain: () => () => undefined
    },
    sendTarget: {
      offer: async () => ({ accepted: true, resumeAt: 0 }),
      notice: () => undefined
    },
    receiveTarget: {
      shouldAutoAccept: () => true,
      createSink: async () => {
        if (rejectWith) throw new Error(rejectWith);
        return new ResumeSink(sink, options.resumeAt ?? 0);
      },
      accept: (id, resumeAt) => answer?.({ accepted: true, resumeAt }),
      reject: (id, reason) => answer?.({ accepted: false, resumeAt: 0, reason }),
      // viewer -> host
      notice: (msg) =>
        queueMicrotask(() => {
          const sender = holder.sender!;
          if (msg.t === 'file-progress') sender.onProgress(msg.id, msg.received ?? 0);
          else if (msg.t === 'file-done') void sender.handlePeerDone(msg);
          else if (msg.t === 'file-cancel') void sender.handlePeerCancel(msg.id);
        })
    },
    chunkSize: options.chunkSize ?? 64,
    progressStepPercent: 0
  });
  holder.receiver = receiver;

  // Deliver frames produced by the sender into the receiver, in order.
  channel.onDeliver = (frame) => void receiver.handleChunk(frame);

  return { sender, receiver, channel, sink, offers };
}

function pseudoRandom(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = (x >>> 24) & 0xff;
  }
  return out;
}

function metaFor(size: number, id = 't1'): FileMeta {
  return { id, name: 'payload.bin', size, mime: 'application/octet-stream' };
}

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}

describe('file transfer engine', () => {
  it('moves a small file byte-for-byte', async () => {
    const { sender, sink } = makePair();
    const bytes = pseudoRandom(1000, 7);
    const record = await sender.send(new BufferSource(bytes, metaFor(bytes.length)));
    await waitFor(() => record.status === 'done');
    expect(Array.from(sink.bytes())).toEqual(Array.from(bytes));
  });

  it('moves a file whose size is not a multiple of the chunk size', async () => {
    const { sender, sink } = makePair({ chunkSize: 64 });
    const bytes = pseudoRandom(64 * 5 + 3, 11);
    const record = await sender.send(new BufferSource(bytes, metaFor(bytes.length)));
    await waitFor(() => record.status === 'done');
    expect(sink.bytes().byteLength).toBe(bytes.byteLength);
    expect(Array.from(sink.bytes())).toEqual(Array.from(bytes));
  });

  it('emits monotonically increasing, gapless offsets', async () => {
    const { sender, sink } = makePair({ chunkSize: 32 });
    const bytes = pseudoRandom(32 * 9, 3);
    const record = await sender.send(new BufferSource(bytes, metaFor(bytes.length)));
    await waitFor(() => record.status === 'done');
    expect(sink.offsets).toEqual(Array.from({ length: 9 }, (_, i) => i * 32));
  });

  it('never asks the source for more bytes than the file has', async () => {
    const { sender } = makePair({ chunkSize: 100 });
    const bytes = pseudoRandom(250, 5);
    const source = new BufferSource(bytes, metaFor(bytes.length));
    const record = await sender.send(source);
    await waitFor(() => record.status === 'done');
    expect(source.reads).toEqual([0, 100, 200]);
  });

  it('stays within the in-flight budget on a slow link (no unbounded buffering)', async () => {
    const { sender, channel } = makePair({ chunkSize: 64, maxInFlightBytes: 512, latencyMs: 2 });
    const bytes = pseudoRandom(64 * 400, 13);
    let peakBuffered = 0;
    const watcher = setInterval(() => {
      peakBuffered = Math.max(peakBuffered, channel.bufferedAmount);
    }, 1);
    const record = await sender.send(new BufferSource(bytes, metaFor(bytes.length)));
    await waitFor(() => record.status === 'done', 20000);
    clearInterval(watcher);
    // One frame may overshoot the budget; a whole file must not.
    expect(peakBuffered).toBeLessThanOrEqual(512 + 64);
  });

  it('handles a zero-byte file without hanging', async () => {
    const { sender, sink } = makePair();
    const record = await sender.send(new BufferSource(new Uint8Array(0), metaFor(0)));
    await waitFor(() => record.status === 'done', 3000);
    expect(sink.bytes().byteLength).toBe(0);
  });

  it('reports rejection when the peer declines the offer', async () => {
    const { sender, channel } = makePair({ rejectReason: 'user said no' });
    const record = await sender.send(new BufferSource(pseudoRandom(500), metaFor(500)));
    expect(record.status).toBe('rejected');
    expect(record.error).toBe('user said no');
    expect(channel.frames.length).toBe(0);
  });

  it('resumes from the offset the receiver already has', async () => {
    const { sender, sink, channel } = makePair({ chunkSize: 100, resumeAt: 300 });
    const bytes = pseudoRandom(500, 9);
    const source = new BufferSource(bytes, metaFor(bytes.length));
    const record = await sender.send(source);
    await waitFor(() => record.status === 'done');
    expect(record.progress).toBe(bytes.length);
    expect(source.reads[0]).toBe(300);
    expect(sink.offsets[0]).toBe(300);
    // Nothing before the resume point was retransmitted.
    expect(Math.min(...sink.offsets)).toBe(300);
    expect(Math.max(...channel.frames.map((f) => f.byteLength))).toBeLessThan(200);
  });

  it('fails loudly on a chunk gap instead of producing a corrupt file', async () => {
    const sink = new TrackingSink();
    const receiver = new TransferManager({
      role: 'viewer',
      channel: {
        get bufferedAmount() {
          return 0;
        },
        get readyState() {
          return 'open';
        },
        send: () => undefined,
        onDrain: () => () => undefined
      },
      sendTarget: { offer: async () => ({ accepted: true, resumeAt: 0 }), notice: () => undefined },
      receiveTarget: {
        shouldAutoAccept: () => true,
        createSink: async () => sink,
        accept: () => undefined,
        reject: () => undefined,
        notice: () => undefined
      },
      chunkSize: 100,
      progressStepPercent: 0
    });
    await receiver.handleOffer(metaFor(300, 'gap-1'), 'host');
    await receiver.handleChunk(encodeChunk('gap-1', 0, new Uint8Array(100)));
    const failed = new Promise<void>((resolve) => receiver.on('failed', () => resolve()));
    await receiver.handleChunk(encodeChunk('gap-1', 200, new Uint8Array(100))); // 100..200 missing
    await failed;
    expect(sink.aborts.length).toBe(1);
  });

  it('is resilient to duplicate chunks after a resume', async () => {
    const sink = new TrackingSink();
    const receiver = new TransferManager({
      role: 'viewer',
      channel: {
        get bufferedAmount() {
          return 0;
        },
        get readyState() {
          return 'open';
        },
        send: () => undefined,
        onDrain: () => () => undefined
      },
      sendTarget: { offer: async () => ({ accepted: true, resumeAt: 0 }), notice: () => undefined },
      receiveTarget: {
        shouldAutoAccept: () => true,
        createSink: async () => sink,
        accept: () => undefined,
        reject: () => undefined,
        notice: () => undefined
      },
      chunkSize: 100,
      progressStepPercent: 0
    });
    await receiver.handleOffer(metaFor(200, 'dup-1'), 'host');
    await receiver.handleChunk(encodeChunk('dup-1', 0, new Uint8Array(100).fill(1)));
    await receiver.handleChunk(encodeChunk('dup-1', 0, new Uint8Array(100).fill(1))); // duplicate
    await receiver.handleChunk(encodeChunk('dup-1', 100, new Uint8Array(100).fill(2)));
    expect(sink.bytes().byteLength).toBe(200);
    expect(sink.bytes()[0]).toBe(1);
    expect(sink.bytes()[199]).toBe(2);
  });

  it('ignores frames for transfers it never accepted', async () => {
    const sink = new TrackingSink();
    const receiver = new TransferManager({
      role: 'viewer',
      channel: {
        get bufferedAmount() {
          return 0;
        },
        get readyState() {
          return 'open';
        },
        send: () => undefined,
        onDrain: () => () => undefined
      },
      sendTarget: { offer: async () => ({ accepted: true, resumeAt: 0 }), notice: () => undefined },
      receiveTarget: {
        shouldAutoAccept: () => true,
        createSink: async () => sink,
        accept: () => undefined,
        reject: () => undefined,
        notice: () => undefined
      },
      chunkSize: 100
    });
    await receiver.handleChunk(encodeChunk('unknown', 0, new Uint8Array(50)));
    expect(sink.bytes().byteLength).toBe(0);
  });

  it('surfaces correlated two-way progress', async () => {
    const { sender } = makePair({ chunkSize: 128 });
    const bytes = pseudoRandom(128 * 20, 21);
    const record = await sender.send(new BufferSource(bytes, metaFor(bytes.length)));
    await waitFor(() => record.status === 'done');
    expect(record.progress).toBe(bytes.length);
    expect(record.bytesPerSecond).toBeGreaterThanOrEqual(0);
  });
});

describe('input forwarding rules', () => {
  it('forwards modifier and navigation keys', () => {
    expect(shouldForwardKey({ code: 'Tab', key: 'Tab', ctrlKey: false, altKey: false, metaKey: false })).toBe(true);
    expect(shouldForwardKey({ code: 'F5', key: 'F5', ctrlKey: false, altKey: false, metaKey: false })).toBe(true);
    expect(shouldForwardKey({ code: 'ControlLeft', key: 'Control', ctrlKey: true, altKey: false, metaKey: false })).toBe(true);
  });

  it('lets plain typing through as characters', () => {
    expect(shouldForwardKey({ code: 'KeyA', key: 'a', ctrlKey: false, altKey: false, metaKey: false })).toBe(false);
  });

  it('detects the panic combo', () => {
    expect(isPanicCombo({ code: 'KeyQ', ctrlKey: true, altKey: true, shiftKey: true })).toBe(true);
    expect(isPanicCombo({ code: 'KeyQ', ctrlKey: true, altKey: true, shiftKey: false })).toBe(false);
  });
});

describe('received file name sanitising', () => {
  it('strips path traversal and separators', () => {
    expect(sanitizeName('..\\..\\Windows\\System32\\evil.exe')).not.toContain('\\');
    expect(sanitizeName('../../etc/passwd')).not.toContain('/');
    expect(sanitizeName('..')).not.toBe('..');
  });

  it('neutralises reserved device names and control characters', () => {
    expect(sanitizeName('CON.txt')).not.toMatch(/^CON/i);
    expect(sanitizeName('report\u0000final.txt')).not.toContain('\u0000');
    expect(sanitizeName('')).toBe('file');
  });

  it('keeps folder structure but drops traversal segments', () => {
    const relative = sanitizeRelative('photos/../../secret/holiday.jpg');
    expect(relative).toBeTruthy();
    expect(relative).not.toContain('..');
    expect(sanitizeRelative('../..')).toBeNull();
  });
});
