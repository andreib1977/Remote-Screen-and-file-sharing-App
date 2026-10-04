/**
 * Chunk framing for peer-to-peer file transfer.
 *
 * Two channels are used per session:
 *   - "ctl"  : always-open JSON control channel (handshakes, chat, clipboard, input)
 *   - "file" : created on demand, carries framed binary chunks
 *
 * Each binary chunk is self-describing so chunks from concurrent transfers can
 * interleave on one channel without extra round trips:
 *
 *   offset  size  field
 *   ------  ----  --------------------------------------------------
 *        0     2  magic 0xF1 0x1E
 *        2     1  protocol version (0x01)
 *        3     1  transfer id length, 1..255
 *        4     N  transfer id, UTF-8
 *     4+N     8  byte offset into the target file (uint64, big endian)
 *    12+N     4  payload length (uint32, big endian)
 *    16+N     *  payload
 */

export const FRAME_MAGIC_0 = 0xf1;
export const FRAME_MAGIC_1 = 0x1e;
export const FRAME_VERSION = 1;
export const FRAME_HEADER_FIXED = 16; // magic(2) + version(1) + idLen(1) + offset(8) + length(4)

export type Bytes = Uint8Array | ArrayBuffer;

function toUint8(bytes: Bytes): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

function writeU64(view: DataView, offset: number, value: number): void {
  const high = Math.floor(value / 0x1_0000_0000);
  const low = value >>> 0;
  view.setUint32(offset, high, false);
  view.setUint32(offset + 4, low, false);
}

function readU64(view: DataView, offset: number): number {
  const high = view.getUint32(offset, false);
  const low = view.getUint32(offset + 4, false);
  return high * 0x1_0000_0000 + low;
}

export function encodeChunk(transferId: string, offset: number, payload: Bytes): Uint8Array {
  const idBytes = new TextEncoder().encode(transferId);
  if (idBytes.length === 0 || idBytes.length > 255) throw new Error(`bad transfer id length: ${idBytes.length}`);
  const body = toUint8(payload);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`bad chunk offset: ${offset}`);

  const frame = new Uint8Array(FRAME_HEADER_FIXED + idBytes.length + body.byteLength);
  const view = new DataView(frame.buffer);
  frame[0] = FRAME_MAGIC_0;
  frame[1] = FRAME_MAGIC_1;
  frame[2] = FRAME_VERSION;
  frame[3] = idBytes.length;
  frame.set(idBytes, 4);
  writeU64(view, 4 + idBytes.length, offset);
  view.setUint32(12 + idBytes.length, body.byteLength, false);
  frame.set(body, FRAME_HEADER_FIXED + idBytes.length);
  return frame;
}

export interface DecodedChunk {
  transferId: string;
  offset: number;
  payload: Uint8Array;
}

export function isChunkFrame(bytes: Bytes): boolean {
  const view = toUint8(bytes);
  return view.byteLength >= FRAME_HEADER_FIXED && view[0] === FRAME_MAGIC_0 && view[1] === FRAME_MAGIC_1;
}

export function decodeChunk(bytes: Bytes): DecodedChunk {
  const view = toUint8(bytes);
  if (view.byteLength < FRAME_HEADER_FIXED) throw new Error('frame too short');
  if (view[0] !== FRAME_MAGIC_0 || view[1] !== FRAME_MAGIC_1) throw new Error('bad frame magic');
  if (view[2] !== FRAME_VERSION) throw new Error(`unsupported frame version ${view[2]}`);
  const idLen = view[3];
  if (idLen === 0) throw new Error('empty transfer id');
  if (view.byteLength < FRAME_HEADER_FIXED + idLen) throw new Error('truncated frame header');

  const data = new DataView(view.buffer, view.byteOffset, view.byteLength);
  const transferId = new TextDecoder().decode(view.subarray(4, 4 + idLen));
  const offset = readU64(data, 4 + idLen);
  const length = data.getUint32(12 + idLen, false);
  const payloadStart = FRAME_HEADER_FIXED + idLen;
  if (view.byteLength < payloadStart + length) throw new Error('truncated frame payload');
  return { transferId, offset, payload: view.subarray(payloadStart, payloadStart + length) };
}

/** Splits a byte length into chunk sizes, defaulting to 256 KiB. */
export function planChunks(totalBytes: number, chunkSize: number): number[] {
  if (chunkSize <= 0) throw new Error('chunkSize must be positive');
  if (totalBytes < 0 || !Number.isFinite(totalBytes)) throw new Error('totalBytes must be >= 0');
  const plan: number[] = [];
  let remaining = Math.floor(totalBytes);
  while (remaining > 0) {
    const size = Math.min(chunkSize, remaining);
    plan.push(size);
    remaining -= size;
  }
  return plan;
}
