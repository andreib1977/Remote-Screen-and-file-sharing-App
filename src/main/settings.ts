/**
 * Settings + "recent sessions" store. Plain JSON on disk, no surprises.
 */

import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_REGISTRY_KEY,
  LANGUAGE_REGISTRY_VALUE,
  languageFromLocale,
  type Language
} from '../shared/i18n';

export interface AppSettings {
  /** UI language. Empty on disk means "not chosen yet", which triggers detection once. */
  language: Language | '';
  /** WebSocket endpoint of the signaling server, e.g. ws://192.168.1.20:8787 */
  serverUrl: string;
  /**
   * Start the bundled rendezvous server with the app. On by default: it removes the
   * "which one do I start first?" problem entirely, and if something is already serving
   * the port the app simply uses it.
   */
  useLocalServer: boolean;
  localServerPort: number;
  displayName: string;
  /** where files received on this machine are written */
  downloadDir: string;
  /** accept incoming files without asking (host side always auto-accepts) */
  autoAcceptFiles: boolean;
  /** host: allow the viewer to drive mouse/keyboard */
  allowRemoteInput: boolean;
  /** persist the session password so reconnects are painless */
  password: string;
  quality: {
    fps: number;
    quality: number;
    scale: number;
    audio: boolean;
  };
}

export interface RecentEntry {
  code: string;
  name: string;
  at: number;
}

const DEFAULTS: AppSettings = {
  language: '',
  serverUrl: 'ws://127.0.0.1:8787',
  useLocalServer: true,
  localServerPort: 8787,
  displayName: '',
  downloadDir: '',
  autoAcceptFiles: true,
  allowRemoteInput: false,
  password: '',
  quality: { fps: 30, quality: 0.8, scale: 1, audio: false }
};

/**
 * The language chosen in the installer, read from HKCU. `reg.exe` rather than a native
 * module: one process spawn on first run is cheaper than a dependency.
 */
export function installerLanguage(): Language | null {
  if (process.platform !== 'win32') return null;
  try {
    const output = execFileSync('reg.exe', ['query', `HKCU\\${LANGUAGE_REGISTRY_KEY}`, '/v', LANGUAGE_REGISTRY_VALUE], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000
    });
    const match = /Language\s+REG_SZ\s+(\S+)/i.exec(output);
    return languageFromLocale(match?.[1] ?? null);
  } catch {
    // Key absent (portable build, or not installed) or reg.exe unavailable.
    return null;
  }
}

/**
 * What language a first run should use: the installer's choice, else the Windows UI
 * language, else English.
 */
export function detectLanguage(): Language {
  return installerLanguage() ?? languageFromLocale(app.getLocale()) ?? DEFAULT_LANGUAGE;
}

/** Settings exactly as they are on disk. Environment overrides are never merged in here. */
let cache: AppSettings | null = null;
let recentCache: RecentEntry[] | null = null;

/**
 * Test/automation overrides, applied to the *returned* value only.
 *
 * These used to be written straight into `cache` and then persisted, which meant a scripted
 * run could permanently point a real installation at a throwaway server. Keeping the
 * persisted settings and the effective settings separate is what makes an override safe.
 */
function applyEnvOverrides(settings: AppSettings): AppSettings {
  if (!process.env.PEERLINK_DOWNLOAD_DIR && !process.env.PEERLINK_SERVER_URL) return settings;
  return {
    ...settings,
    downloadDir: process.env.PEERLINK_DOWNLOAD_DIR || settings.downloadDir,
    serverUrl: process.env.PEERLINK_SERVER_URL || settings.serverUrl
  };
}

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function recentFile(): string {
  return path.join(app.getPath('userData'), 'recent.json');
}

export async function loadSettings(): Promise<AppSettings> {
  if (cache) return applyEnvOverrides(cache);
  try {
    const raw = await fs.readFile(settingsFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    cache = { ...DEFAULTS, ...parsed, quality: { ...DEFAULTS.quality, ...(parsed.quality || {}) } };
  } catch {
    cache = { ...DEFAULTS };
  }
  if (!cache.displayName) cache.displayName = defaultDisplayName();
  if (!cache.downloadDir) cache.downloadDir = defaultDownloadDir();

  // First run only: adopt the installer's choice (or the Windows UI language) and record
  // it, so the question is never asked twice and a later change sticks.
  if (!cache.language) {
    cache.language = detectLanguage();
    await persist(cache);
  }
  return applyEnvOverrides(cache);
}

async function persist(value: AppSettings): Promise<void> {
  try {
    await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
    await fs.writeFile(settingsFile(), JSON.stringify(value, null, 2), 'utf8');
  } catch {
    /* a read-only profile must not stop the app from starting */
  }
}

function defaultDownloadDir(): string {
  if (process.env.PEERLINK_HOME) return path.join(process.env.PEERLINK_HOME, 'received');
  return path.join(app.getPath('downloads'), 'PeerLink');
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  // Merge into the persisted settings, never into the environment-overridden view: an
  // override must not be able to leak onto disk through a save.
  if (!cache) await loadSettings();
  const current = cache as AppSettings;
  cache = {
    ...current,
    ...patch,
    quality: { ...current.quality, ...(patch.quality || {}) }
  };
  await persist(cache);
  return applyEnvOverrides(cache);
}

export function defaultDisplayName(): string {
  const user = process.env.USERNAME || process.env.USER || 'PeerLink user';
  return `${user}@${process.env.COMPUTERNAME || 'windows'}`;
}

export async function loadRecent(): Promise<RecentEntry[]> {
  if (recentCache) return recentCache;
  try {
    recentCache = JSON.parse(await fs.readFile(recentFile(), 'utf8')) as RecentEntry[];
  } catch {
    recentCache = [];
  }
  return recentCache;
}

export async function pushRecent(entry: RecentEntry): Promise<RecentEntry[]> {
  const list = await loadRecent();
  const next = [entry, ...list.filter((e) => e.code !== entry.code)].slice(0, 12);
  recentCache = next;
  await fs.writeFile(recentFile(), JSON.stringify(next, null, 2), 'utf8').catch(() => undefined);
  return next;
}
