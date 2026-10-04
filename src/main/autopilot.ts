/**
 * Headless harness support for the end-to-end smoke test (npm run test:e2e).
 *
 * Enabled only when PEERLINK_AUTOPILOT is set, so it is inert in normal use. It lets a
 * scripted run start sharing or connect to a code without a human clicking anything, and
 * writes a JSON status file so the driver script can assert what actually happened.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export interface AutoPilotConfig {
  enabled: boolean;
  role: 'host' | 'viewer';
  clientId: string;
  serverUrl?: string;
  password?: string;
  code?: string;
  sendFile?: string;
  /** poll this file for the peer's session code (host writes it, viewer reads it) */
  codeFile?: string;
  statusFile?: string;
  logFile?: string;
  wantsControl?: boolean;
  quality?: { fps?: number; scale?: number };
}

export function readAutoPilot(): AutoPilotConfig | null {
  if (!process.env.PEERLINK_AUTOPILOT) return null;
  return {
    enabled: true,
    role: (process.env.PEERLINK_ROLE as 'host' | 'viewer') || 'host',
    clientId: process.env.PEERLINK_CLIENT_ID || 'client',
    serverUrl: process.env.PEERLINK_SERVER_URL,
    password: process.env.PEERLINK_PASSWORD,
    code: process.env.PEERLINK_CODE,
    sendFile: process.env.PEERLINK_SEND_FILE,
    codeFile: process.env.PEERLINK_CODE_FILE,
    statusFile: process.env.PEERLINK_STATUS_FILE,
    logFile: process.env.PEERLINK_LOG_FILE,
    wantsControl: process.env.PEERLINK_WANT_CONTROL === '1',
    quality: {
      fps: process.env.PEERLINK_FPS ? Number(process.env.PEERLINK_FPS) : undefined,
      scale: process.env.PEERLINK_SCALE ? Number(process.env.PEERLINK_SCALE) : undefined
    }
  };
}

/** Appends a line to the harness log, if one is configured. */
export function autoPilotLog(message: string): void {
  const config = readAutoPilot();
  if (!config) return;
  const target = config.logFile || (config.statusFile ? `${config.statusFile}.log` : path.join(app.getPath('temp'), 'peerlink.log'));
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    /* never fatal */
  }
}

export function registerAutoPilotIpc(): void {
  ipcMain.handle('autopilot:config', () => readAutoPilot());

  ipcMain.handle('autopilot:log', (_event, message: string) => {
    const config = readAutoPilot();
    const target = config?.logFile || (config?.statusFile ? `${config.statusFile}.log` : path.join(app.getPath('temp'), 'peerlink.log'));
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
    } catch {
      /* logging must never break the app */
    }
    return true;
  });

  ipcMain.handle('autopilot:status', (_event, payload: unknown) => {
    const config = readAutoPilot();
    const target = config?.statusFile || path.join(app.getPath('temp'), `peerlink-${config?.clientId ?? 'client'}.json`);
    const previous = (() => {
      try {
        return JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    })();
    const merged = { ...previous, ...(payload as Record<string, unknown>), updatedAt: Date.now() };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(merged, null, 2), 'utf8');
    return true;
  });

  /** Read the host's session code without the viewer needing any UI. */
  ipcMain.handle('autopilot:readFile', (_event, file: string) => {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch {
      return null;
    }
  });

  ipcMain.handle('autopilot:writeFile', (_event, file: string, contents: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, 'utf8');
    return true;
  });

  /** Deterministic exit for scripted runs. */
  ipcMain.handle('autopilot:quit', () => {
    setTimeout(() => app.quit(), 50);
    return true;
  });

  /**
   * Screenshot the app window to a PNG. Used by the harness to prove the UI actually
   * painted (a blank window or a crashed renderer would show up as a flat image).
   */
  ipcMain.handle('autopilot:screenshot', async (_event, file: string) => {
    const windows = BrowserWindow.getAllWindows();
    const target = windows[0];
    if (!target) return { ok: false, error: 'no window' };
    const image = await target.webContents.capturePage();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, image.toPNG());
    const size = image.getSize();
    return { ok: true, file, width: size.width, height: size.height };
  });
}
