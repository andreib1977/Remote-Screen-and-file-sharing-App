/**
 * Disk side of file transfer.
 *
 * All filesystem access lives in the main process; the renderer only ever sees opaque
 * session ids. Chunks arrive as ArrayBuffers, are written with explicit offsets, and land
 * in a `.part` file next to the final target so that:
 *   - a finished name never appears before the bytes are all there
 *   - renaming is atomic (same volume)
 *   - an interrupted transfer can be resumed from the partial file
 */

import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadSettings } from './settings';

export interface UploadSession {
  id: string;
  filePath: string;
  size: number;
  readStream: fs.FileHandle | null;
}

export interface DownloadSession {
  id: string;
  targetPath: string;
  tempPath: string;
  size: number;
  received: number;
  handle: fs.FileHandle | null;
  pending: Promise<void>;
  cancelled: boolean;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const uploads = new Map<string, UploadSession>();
const downloads = new Map<string, DownloadSession>();

/** Strip anything that could escape the destination directory or break Windows. */
export function sanitizeName(name: string): string {
  let clean = String(name || 'file')
    .replace(/[\\/]+/g, '_')
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!clean) clean = 'file';
  if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`;
  if (clean.length > 180) {
    const ext = path.extname(clean).slice(0, 16);
    clean = clean.slice(0, 180 - ext.length) + ext;
  }
  return clean;
}

/** Sanitize a "folder/sub/file.txt" style relative path, segment by segment. */
export function sanitizeRelative(relativePath: string): string | null {
  const parts = String(relativePath || '')
    .split(/[\\/]+/)
    .filter((p) => p && p !== '.' && p !== '..')
    .map(sanitizeName);
  if (parts.length === 0) return null;
  return parts.join(path.sep);
}

async function uniquePath(dir: string, name: string): Promise<string> {
  const base = path.join(dir, name);
  try {
    await fs.access(base);
  } catch {
    return base;
  }
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 999; i++) {
    const candidate = path.join(dir, `${stem} (${i})${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

function newId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Deletes leftovers from transfers that were interrupted in a previous run. */
export async function sweepStalePartials(): Promise<number> {
  const settings = await loadSettings();
  let removed = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'PeerLink.parts') {
          const olds = await fs.readdir(full).catch(() => [] as string[]);
          for (const old of olds) {
            await fs.rm(path.join(full, old), { force: true }).catch(() => undefined);
            removed++;
          }
        } else {
          await walk(full, depth + 1);
        }
      }
    }
  }
  await walk(settings.downloadDir, 0);
  return removed;
}

export function registerFileIpc(getWindow: () => BrowserWindow | null): void {
  const partsRoot = () => path.join(app.getPath('userData'), 'parts');

  // ---------------------------------------------------------------- uploads
  ipcMain.handle('file:pick', async (_e, opts: { folders?: boolean } = {}) => {
    const win = getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: 'Choose files to send',
          properties: opts.folders ? ['openFile', 'openDirectory', 'multiSelections'] : ['openFile', 'multiSelections']
        })
      : await dialog.showOpenDialog({
          title: 'Choose files to send',
          properties: opts.folders ? ['openFile', 'openDirectory', 'multiSelections'] : ['openFile', 'multiSelections']
        });
    if (result.canceled) return [];
    return result.filePaths;
  });

  ipcMain.handle('file:pickPath', async (_e, opts: { directory?: boolean; title?: string } = {}) => {
    const win = getWindow();
    const properties: Array<'openFile' | 'openDirectory'> = opts.directory ? ['openDirectory'] : ['openFile'];
    const options = { title: opts.title || 'Choose a location', properties };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('file:stat', async (_e, target: string, root?: string) => {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      const items: { path: string; relative: string; name: string; size: number; mtime: number }[] = [];
      const rootDir = root || target;
      async function walk(dir: string): Promise<void> {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
          } else if (entry.isFile()) {
            const s = await fs.stat(full);
            items.push({
              path: full,
              relative: path.relative(path.dirname(rootDir), full),
              name: entry.name,
              size: s.size,
              mtime: s.mtimeMs
            });
          }
        }
      }
      await walk(target);
      return items;
    }
    return [
      {
        path: target,
        relative: path.basename(target),
        name: path.basename(target),
        size: stat.size,
        mtime: stat.mtimeMs
      }
    ];
  });

  ipcMain.handle('file:uploadOpen', async (_e, filePath: string) => {
    const stat = await fs.stat(filePath);
    const handle = await fs.open(filePath, 'r');
    const id = newId();
    uploads.set(id, { id, filePath, size: stat.size, readStream: handle });
    return { id, size: stat.size, name: path.basename(filePath) };
  });

  ipcMain.handle('file:uploadRead', async (_e, id: string, offset: number, length: number) => {
    const session = uploads.get(id);
    if (!session || !session.readStream) throw new Error('upload session is gone');
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await session.readStream.read(buffer, 0, length, offset);
    // Return an exact-length view so the renderer never ships padding.
    const exact = buffer.subarray(0, bytesRead);
    return exact.buffer.slice(exact.byteOffset, exact.byteOffset + exact.byteLength);
  });

  ipcMain.handle('file:uploadClose', async (_e, id: string) => {
    const session = uploads.get(id);
    uploads.delete(id);
    if (session?.readStream) await session.readStream.close().catch(() => undefined);
    return true;
  });

  // -------------------------------------------------------------- downloads
  ipcMain.handle('file:offerSave', async (_e, opts: { name: string; size: number; relativePath?: string; id: string; askUser?: boolean }) => {
    const settings = await loadSettings();
    const safeRelative = opts.relativePath ? sanitizeRelative(opts.relativePath) : null;
    const dir = safeRelative ? path.join(settings.downloadDir, path.dirname(safeRelative)) : settings.downloadDir;
    await ensureDir(dir);

    const suggested = sanitizeName(safeRelative ? path.basename(safeRelative) : opts.name);
    let targetPath = await uniquePath(dir, suggested);

    if (opts.askUser) {
      const win = getWindow();
      const result = win
        ? await dialog.showSaveDialog(win, { title: 'Save received file', defaultPath: targetPath })
        : await dialog.showSaveDialog({ title: 'Save received file', defaultPath: targetPath });
      if (result.canceled || !result.filePath) throw new Error('cancelled');
      targetPath = result.filePath;
    }

    const tempDir = path.join(partsRoot(), opts.id);
    // The staging directory must exist before the handle is opened; a missing one used
    // to reject perfectly good transfers.
    await ensureDir(tempDir);
    const tempPath = path.join(tempDir, 'payload.part');

    const handle = await fs.open(tempPath, 'a+');
    const existing = await handle.stat();
    // Resume support: if a partial file for this transfer id survived a crash or a
    // dropped connection, keep it and tell the sender where to continue from.
    const resumedBytes = existing.size > 0 && existing.size < opts.size ? existing.size : 0;
    if (resumedBytes === 0 && existing.size > 0) {
      await handle.truncate(0).catch(() => undefined);
    }

    const session: DownloadSession = {
      id: opts.id,
      targetPath,
      tempPath,
      size: opts.size,
      received: resumedBytes,
      handle,
      pending: Promise.resolve(),
      cancelled: false
    };
    downloads.set(opts.id, session);
    return { targetPath, tempPath, resumedBytes };
  });

  ipcMain.handle('file:downloadWrite', async (_e, id: string, offset: number, data: ArrayBuffer | Uint8Array) => {
    const session = downloads.get(id);
    if (!session || !session.handle || session.cancelled) throw new Error('download session is gone');
    const buffer = Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data));
    await session.handle.write(buffer, 0, buffer.byteLength, offset);
    session.received = Math.max(session.received, offset + buffer.byteLength);
    return session.received;
  });

  ipcMain.handle('file:downloadProgress', async (_e, id: string) => {
    const session = downloads.get(id);
    return session ? session.received : 0;
  });

  ipcMain.handle('file:downloadFinish', async (_e, id: string) => {
    const session = downloads.get(id);
    if (!session) throw new Error('download session is gone');
    downloads.delete(id);
    try {
      if (session.handle) {
        await session.handle.sync().catch(() => undefined);
        await session.handle.close();
      }
      await fs.rm(session.targetPath, { force: true }).catch(() => undefined);
      await fs.rename(session.tempPath, session.targetPath);
      return { savedPath: session.targetPath };
    } finally {
      await fs.rm(path.dirname(session.tempPath), { recursive: true, force: true }).catch(() => undefined);
    }
  });

  ipcMain.handle('file:downloadAbort', async (_e, id: string, keepPartial: boolean) => {
    const session = downloads.get(id);
    if (!session) return false;
    session.cancelled = true;
    downloads.delete(id);
    await session.handle?.close().catch(() => undefined);
    if (!keepPartial) {
      await fs.rm(path.dirname(session.tempPath), { recursive: true, force: true }).catch(() => undefined);
    }
    return true;
  });

  // ----------------------------------------------------------------- shell
  ipcMain.handle('shell:reveal', async (_e, target: string) => {
    if (!target) return false;
    shell.showItemInFolder(target);
    return true;
  });

  ipcMain.handle('shell:openPath', async (_e, target: string) => {
    if (!target) return false;
    const err = await shell.openPath(target);
    return err === '';
  });

  ipcMain.handle('clipboard:write', async (_e, text: string) => {
    const { clipboard } = await import('electron');
    clipboard.writeText(String(text ?? ''));
    return true;
  });

  ipcMain.handle('clipboard:read', async () => {
    const { clipboard } = await import('electron');
    return clipboard.readText();
  });
}

export function closeAllSessions(): void {
  for (const session of uploads.values()) {
    void session.readStream?.close().catch(() => undefined);
  }
  uploads.clear();
  for (const session of downloads.values()) {
    void session.handle?.close().catch(() => undefined);
  }
  downloads.clear();
}
