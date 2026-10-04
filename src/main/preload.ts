/**
 * The single, explicit bridge between the sandboxed UI and Electron's privileged APIs.
 * Nothing else is exposed to the renderer.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { AppSettings, RecentEntry } from './settings';

export interface HelperStatus {
  state: 'stopped' | 'starting' | 'ready' | 'failed';
  screen?: { x: number; y: number; width: number; height: number };
  error?: string;
  path: string;
  alive?: boolean;
}

export interface DisplayEntry {
  id: string;
  label: string;
  width: number;
  height: number;
  primary: boolean;
  scaleFactor: number;
}

export interface LocalServerStatus {
  running: boolean;
  url: string;
  port: number;
  /** LAN addresses other machines can use, e.g. ws://192.168.1.20:8787 */
  lanUrls: string[];
  ownedByUs: boolean;
  error?: string;
}

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  electron: string;
  chrome: string;
  packaged: boolean;
  helper: HelperStatus;
  settings: AppSettings;
  displays: DisplayEntry[];
  desktop: { x: number; y: number; width: number; height: number };
  userData: string;
  localServer: LocalServerStatus;
}

export interface StagedFile {
  path: string;
  relative: string;
  name: string;
  size: number;
  mtime: number;
}

export interface UploadHandle {
  id: string;
  size: number;
  name: string;
}

export interface SaveHandle {
  targetPath: string;
  tempPath: string;
  resumedBytes: number;
}

const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke('settings:set', patch),
  getRecent: (): Promise<RecentEntry[]> => ipcRenderer.invoke('recent:get'),
  pushRecent: (entry: RecentEntry): Promise<RecentEntry[]> => ipcRenderer.invoke('recent:push', entry),

  listDisplays: (): Promise<{ displays: DisplayEntry[]; desktop: AppInfo['desktop'] }> => ipcRenderer.invoke('displays:list'),
  listCaptureSources: (): Promise<{ id: string; name: string; thumbnail: string }[]> => ipcRenderer.invoke('capture:sources'),
  prepareCapture: (opts: { sourceId?: string; audio?: boolean }): Promise<boolean> => ipcRenderer.invoke('capture:prepare', opts),

  /** Bundled rendezvous server ("start the server, then the app" collapsed into one launch). */
  serverStatus: (): Promise<LocalServerStatus> => ipcRenderer.invoke('server:status'),
  ensureServer: (port?: number): Promise<LocalServerStatus> => ipcRenderer.invoke('server:ensure', port),
  serverLanUrls: (): Promise<string[]> => ipcRenderer.invoke('server:lan-urls'),

  inputStatus: (): Promise<HelperStatus> => ipcRenderer.invoke('input:status'),
  inputStart: (): Promise<HelperStatus> => ipcRenderer.invoke('input:start'),
  inputStop: (): Promise<HelperStatus> => ipcRenderer.invoke('input:stop'),
  inputCommand: (command: Record<string, unknown>): Promise<boolean> => ipcRenderer.invoke('input:command', command),
  clipboardGetNative: (): Promise<string | null> => ipcRenderer.invoke('input:clipboard-get'),
  clipboardSetNative: (text: string): Promise<boolean> => ipcRenderer.invoke('input:clipboard-set', text),

  pickFiles: (opts?: { folders?: boolean }): Promise<string[]> => ipcRenderer.invoke('file:pick', opts ?? {}),
  pickPath: (opts?: { directory?: boolean; title?: string }): Promise<string | null> => ipcRenderer.invoke('file:pickPath', opts ?? {}),
  statPath: (target: string, root?: string): Promise<StagedFile[]> => ipcRenderer.invoke('file:stat', target, root),

  openUpload: (filePath: string): Promise<UploadHandle> => ipcRenderer.invoke('file:uploadOpen', filePath),
  readUpload: (id: string, offset: number, length: number): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('file:uploadRead', id, offset, length),
  closeUpload: (id: string): Promise<boolean> => ipcRenderer.invoke('file:uploadClose', id),

  offerSave: (opts: { id: string; name: string; size: number; relativePath?: string; askUser?: boolean }): Promise<SaveHandle> =>
    ipcRenderer.invoke('file:offerSave', opts),
  writeDownload: (id: string, offset: number, data: ArrayBuffer): Promise<number> =>
    ipcRenderer.invoke('file:downloadWrite', id, offset, data),
  downloadProgress: (id: string): Promise<number> => ipcRenderer.invoke('file:downloadProgress', id),
  finishDownload: (id: string): Promise<{ savedPath: string }> => ipcRenderer.invoke('file:downloadFinish', id),
  abortDownload: (id: string, keepPartial?: boolean): Promise<boolean> => ipcRenderer.invoke('file:downloadAbort', id, keepPartial ?? false),

  revealPath: (target: string): Promise<boolean> => ipcRenderer.invoke('shell:reveal', target),
  openPath: (target: string): Promise<boolean> => ipcRenderer.invoke('shell:openPath', target),
  copyText: (text: string): Promise<boolean> => ipcRenderer.invoke('clipboard:write', text),
  readText: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),

  /** Only functional when the app was launched with PEERLINK_AUTOPILOT=1. */
  autopilot: {
    config: (): Promise<Record<string, unknown> | null> => ipcRenderer.invoke('autopilot:config'),
    status: (payload: Record<string, unknown>): Promise<boolean> => ipcRenderer.invoke('autopilot:status', payload),
    log: (message: string): Promise<boolean> => ipcRenderer.invoke('autopilot:log', message),
    readFile: (file: string): Promise<string | null> => ipcRenderer.invoke('autopilot:readFile', file),
    writeFile: (file: string, contents: string): Promise<boolean> => ipcRenderer.invoke('autopilot:writeFile', file, contents),
    screenshot: (file: string): Promise<{ ok: boolean; file?: string; width?: number; height?: number; error?: string }> =>
      ipcRenderer.invoke('autopilot:screenshot', file),
    quit: (): Promise<boolean> => ipcRenderer.invoke('autopilot:quit')
  }
};

export type PeerLinkApi = typeof api;

contextBridge.exposeInMainWorld('peerlink', api);
