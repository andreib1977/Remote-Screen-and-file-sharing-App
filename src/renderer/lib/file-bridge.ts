/**
 * Bridges the pure transfer engine to Electron's file APIs.
 *
 * The host reads picked files through the main process one chunk at a time; the viewer
 * writes incoming chunks straight into a `.part` file. Neither side ever holds more than
 * a few hundred kilobytes of a file in memory, which is what makes unlimited sizes work.
 */

import type { FileMeta } from '../../shared/protocol';
import type { FileSink, FileSource } from '../../shared/transfer/manager';
import type { PeerLinkApi } from '../../main/preload';

const api = (): PeerLinkApi => {
  const bridge = (window as unknown as { peerlink?: PeerLinkApi }).peerlink;
  if (!bridge) throw new Error('PeerLink desktop bridge unavailable (running outside Electron?)');
  return bridge;
};

/** Sends a file that exists on this machine, by path (host side, or viewer picks via dialog). */
export class PathFileSource implements FileSource {
  private uploadId: string | null = null;

  constructor(private readonly filePath: string, public readonly meta: FileMeta) {}

  private async ensureOpen(): Promise<string> {
    if (this.uploadId) return this.uploadId;
    const handle = await api().openUpload(this.filePath);
    this.uploadId = handle.id;
    return handle.id;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const id = await this.ensureOpen();
    const buffer = await api().readUpload(id, offset, length);
    return new Uint8Array(buffer);
  }

  async close(): Promise<void> {
    if (!this.uploadId) return;
    const id = this.uploadId;
    this.uploadId = null;
    await api().closeUpload(id).catch(() => undefined);
  }
}

/** Sends a File object the viewer dropped or picked. */
export class BlobFileSource implements FileSource {
  constructor(private readonly blob: File, public readonly meta: FileMeta) {}

  async read(offset: number, length: number): Promise<Uint8Array> {
    const slice = this.blob.slice(offset, Math.min(offset + length, this.blob.size));
    return new Uint8Array(await slice.arrayBuffer());
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}

export interface SaveRecord {
  id: string;
  targetPath: string;
  received: number;
  finished: boolean;
}

export class ElectronFileSink implements FileSink {
  private savedPath: string | null = null;
  private closed = false;
  private lastFlush = 0;

  private constructor(
    public readonly meta: FileMeta,
    private readonly resumedBytes: number,
    public readonly targetPath: string
  ) {}

  static async create(meta: FileMeta, opts: { askUser: boolean }): Promise<ElectronFileSink> {
    const handle = await api().offerSave({
      id: meta.id,
      name: meta.name,
      size: meta.size,
      relativePath: meta.relativePath,
      askUser: opts.askUser
    });
    return new ElectronFileSink(meta, handle.resumedBytes, handle.targetPath);
  }

  async write(offset: number, data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('sink already closed');
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    await api().writeDownload(this.meta.id, offset, buffer);
  }

  async sizeOnDisk(): Promise<number> {
    return this.resumedBytes;
  }

  async close(): Promise<{ savedPath?: string }> {
    if (this.closed) return { savedPath: this.savedPath ?? undefined };
    this.closed = true;
    const result = await api().finishDownload(this.meta.id);
    this.savedPath = result.savedPath;
    return { savedPath: this.savedPath };
  }

  async abort(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Keep the partial file: a retry of the same transfer id resumes from it.
    await api().abortDownload(this.meta.id, true).catch(() => undefined);
    void reason;
  }
}

/** Cheap "how much disk space do I need" guard before accepting a large transfer. */
export async function hasRoomFor(bytes: number): Promise<boolean> {
  try {
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      if (estimate.quota && estimate.usage !== undefined) {
        return estimate.quota - estimate.usage > bytes;
      }
    }
  } catch {
    /* not fatal: the write will simply fail later if the disk is full */
  }
  return true;
}
