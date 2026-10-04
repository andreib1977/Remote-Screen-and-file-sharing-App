/**
 * PeerLink main process: window lifecycle, screen-capture authorization,
 * native input helper ownership and all privileged IPC.
 */

import { app, BrowserWindow, desktopCapturer, ipcMain, screen, session, shell, systemPreferences } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { InputHelper } from './input-helper';
import { closeAllSessions, registerFileIpc, sweepStalePartials } from './file-bridge';
import { AppSettings, loadRecent, loadSettings, pushRecent, saveSettings } from './settings';
import { readAutoPilot, registerAutoPilotIpc, autoPilotLog } from './autopilot';
import { DEFAULT_SERVER_PORT, ensureLocalServer, lanAddresses, serverStatus, serverScriptPath, type LocalServerStatus } from './local-server';

const isDev = process.env.PEERLINK_DEV === '1';
const RENDERER_DEV_URL = 'http://127.0.0.1:5273';

// Isolated profiles for scripted runs; a normal launch never sets PEERLINK_HOME.
if (process.env.PEERLINK_HOME) {
  app.setPath('userData', process.env.PEERLINK_HOME);
}

let mainWindow: BrowserWindow | null = null;
const inputHelper = new InputHelper();

/** sourceId requested by the renderer, set right before getDisplayMedia() is called. */
let pendingCaptureSourceId: string | null = null;
let pendingCaptureAudio = false;

/** Last known state of the bundled rendezvous server. */
let localServer: LocalServerStatus = {
  running: false,
  url: `ws://127.0.0.1:${DEFAULT_SERVER_PORT}`,
  port: DEFAULT_SERVER_PORT,
  lanUrls: [],
  ownedByUs: false
};

function rendererEntry(): { url?: string; file?: string } {
  if (isDev) return { url: RENDERER_DEV_URL };
  return { file: path.join(app.getAppPath(), 'dist', 'renderer', 'index.html') };
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    title: 'PeerLink',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // A shared screen keeps producing frames even when the window is in the background.
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  const entry = rendererEntry();
  if (entry.url) {
    void mainWindow.loadURL(entry.url);
  } else {
    void mainWindow.loadFile(entry.file!);
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

function setupCaptureHandler(): void {
  autoPilotLog(`electron ${process.versions.electron} / chromium ${process.versions.chrome}`);
  // Renderer asks for `chromeMediaSource: 'desktop'`; this handler decides which
  // screen (or window) it actually gets, without showing Chrome's picker UI.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        autoPilotLog(`capture handler fired: requested source=${pendingCaptureSourceId ?? '(primary)'} audio=${pendingCaptureAudio}`);
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false
        });
        autoPilotLog(`capture handler: ${sources.length} screen source(s): ${sources.map((s) => s.id).join(',')}`);
        const wanted = pendingCaptureSourceId;
        const source = (wanted && sources.find((s) => s.id === wanted)) || sources[0];
        if (!source) {
          autoPilotLog('capture handler: no screen sources available');
          callback({});
          return;
        }
        autoPilotLog(`capture handler: granting ${source.id}`);
        if (pendingCaptureAudio && process.platform === 'win32') {
          // Windows loopback: lets the viewer hear the host.
          callback({ video: source, audio: 'loopback' });
        } else {
          callback({ video: source });
        }
        autoPilotLog('capture handler: callback returned');
      } catch (err) {
        autoPilotLog(`capture handler failed: ${err instanceof Error ? err.stack : String(err)}`);
        callback({});
      }
    },
    { useSystemPicker: false }
  );
  autoPilotLog('display media request handler registered');
}

function displayList() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display, index) => ({
    id: String(display.id),
    label: `${display.label || `Display ${index + 1}`} - ${display.size.width}x${display.size.height}${display.id === primaryId ? ' (primary)' : ''}`,
    width: display.size.width,
    height: display.size.height,
    primary: display.id === primaryId,
    scaleFactor: display.scaleFactor
  }));
}

function desktopBounds() {
  // Union of every display, in physical pixels - matches what SendInput's
  // virtual-desktop coordinate space expects.
  const displays = screen.getAllDisplays();
  const left = Math.min(...displays.map((d) => d.bounds.x));
  const top = Math.min(...displays.map((d) => d.bounds.y));
  const right = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const bottom = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function registerIpc(): void {
  ipcMain.handle('app:info', async () => {
    const settings = await loadSettings();
    return {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      packaged: app.isPackaged,
      helper: inputHelper.getStatus(),
      settings,
      displays: displayList(),
      desktop: desktopBounds(),
      userData: app.getPath('userData'),
      localServer,
      serverScript: serverScriptPath()
    };
  });

  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:set', async (_e, patch: Partial<AppSettings>) => saveSettings(patch));
  ipcMain.handle('recent:get', () => loadRecent());
  ipcMain.handle('recent:push', (_e, entry: { code: string; name: string; at: number }) => pushRecent(entry));

  // ---- bundled rendezvous server ----
  ipcMain.handle('server:status', async () => {
    localServer = await serverStatus(localServer.port, localServer.ownedByUs);
    return localServer;
  });

  ipcMain.handle('server:ensure', async (_e, port?: number) => {
    const settings = await loadSettings();
    localServer = await ensureLocalServer(port ?? settings.localServerPort ?? DEFAULT_SERVER_PORT);
    autoPilotLog(`local server: running=${localServer.running} owned=${localServer.ownedByUs} ${localServer.error ?? ''}`);
    return localServer;
  });

  ipcMain.handle('server:lan-urls', () => lanAddresses());

  ipcMain.handle('displays:list', () => ({ displays: displayList(), desktop: desktopBounds() }));

  ipcMain.handle('capture:prepare', (_e, opts: { sourceId?: string; audio?: boolean }) => {
    pendingCaptureSourceId = opts?.sourceId ? String(opts.sourceId) : null;
    pendingCaptureAudio = Boolean(opts?.audio);
    autoPilotLog(`capture:prepare source=${pendingCaptureSourceId ?? '(primary)'} audio=${pendingCaptureAudio}`);
    return true;
  });
  ipcMain.handle('capture:sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 240, height: 150 } });
    return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
  });

  // ---- native input helper ----
  ipcMain.handle('input:status', async () => {
    const status = inputHelper.getStatus();
    if (status.state === 'ready') {
      const alive = await inputHelper.ping();
      return { ...status, alive };
    }
    return status;
  });

  ipcMain.handle('input:start', () => inputHelper.start());

  ipcMain.handle('input:stop', () => {
    inputHelper.stop();
    return inputHelper.getStatus();
  });

  ipcMain.handle('input:command', (_e, command: Record<string, unknown>) => {
    if (!inputHelper.isReady()) {
      void inputHelper.start().then((status) => {
        if (status.state === 'ready') inputHelper.send(command);
      });
      return false;
    }
    return inputHelper.send(command);
  });

  ipcMain.handle('input:clipboard-get', () => inputHelper.getClipboard());
  ipcMain.handle('input:clipboard-set', (_e, text: string) => {
    if (!inputHelper.isReady()) {
      void inputHelper.start();
      return false;
    }
    return inputHelper.send({ t: 'clipboard-set', s: String(text ?? '') });
  });

  registerFileIpc(() => mainWindow);
}

async function ensureDownloadDir(): Promise<void> {
  const settings = await loadSettings();
  await fs.promises.mkdir(settings.downloadDir, { recursive: true }).catch(() => undefined);
}

// Single instance: two PeerLink windows fighting over one input helper would be confusing.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    setupCaptureHandler();
    registerIpc();
    registerAutoPilotIpc();

    // Bring the bundled server up *before* the window so the app's first connection
    // attempt succeeds. If a server is already listening - a previous launch, or one the
    // user started by hand - this just detects it and moves on.
    const settings = await loadSettings();
    if (settings.useLocalServer && process.env.PEERLINK_NO_LOCAL_SERVER !== '1') {
      localServer = await ensureLocalServer(settings.localServerPort || DEFAULT_SERVER_PORT);
      autoPilotLog(
        `local server ready=${localServer.running} owned=${localServer.ownedByUs} url=${localServer.url} lan=${localServer.lanUrls.join(',')} ${localServer.error ?? ''}`
      );

      // "I run the server" and "connect somewhere else" are contradictory settings, and a
      // stale or hand-edited URL used to win - leaving the app retrying a dead address while
      // its own server sat idle. When the bundled server is on, it is authoritative.
      if (
        localServer.running &&
        !process.env.PEERLINK_SERVER_URL &&
        settings.serverUrl !== localServer.url
      ) {
        autoPilotLog(`adopting local server url: ${settings.serverUrl} -> ${localServer.url}`);
        await saveSettings({ serverUrl: localServer.url });
      }
    } else {
      localServer = await serverStatus(settings.localServerPort || DEFAULT_SERVER_PORT);
    }

    createWindow();
    await ensureDownloadDir();
    void sweepStalePartials();

    // Scripted runs (npm run test:e2e) can keep the window off-screen.
    const autoPilot = readAutoPilot();
    if (autoPilot?.enabled && process.env.PEERLINK_HEADLESS !== '0' && mainWindow) {
      mainWindow.setPosition(-4000, -4000);
      mainWindow.setSkipTaskbar(true);
    }

    // `PEERLINK_SHOT=<path>` writes a screenshot of the rendered window once it is up;
    // used to verify the UI paints without a human looking at it.
    const shotPath = process.env.PEERLINK_SHOT;
    if (shotPath) {
      const delay = Number(process.env.PEERLINK_SHOT_DELAY || 6000);
      const views = (process.env.PEERLINK_SHOT_VIEWS || '').split(',').filter(Boolean);
      const capture = async (target: string) => {
        const image = await mainWindow?.webContents.capturePage();
        if (!image) throw new Error('no window');
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, image.toPNG());
        return image.getSize();
      };
      setTimeout(async () => {
        try {
          if (views.length === 0) {
            const size = await capture(shotPath);
            autoPilotLog(`screenshot written to ${shotPath} (${size.width}x${size.height})`);
            return;
          }
          // One screenshot per requested tab, driven through the real React tabs.
          // Tabs are matched by position, not label: labels are translated, so a text match
          // would silently stop working in any language but English.
          for (let index = 0; index < views.length; index++) {
            const view = views[index];
            const tabIndex = ['connect', 'share', 'settings'].indexOf(view);
            const clicked = await mainWindow?.webContents.executeJavaScript(`
              (() => {
                const tabs = [...document.querySelectorAll('.tab')];
                const target = tabs[${tabIndex >= 0 ? tabIndex : 0}];
                if (!target) return false;
                target.click();
                return true;
              })()
            `);
            autoPilotLog(`view ${view}: clicked=${clicked}`);
            await new Promise((resolve) => setTimeout(resolve, 900));
            const target = shotPath.replace(/\.png$/, `-${view}.png`);
            const size = await capture(target);
            autoPilotLog(`screenshot written to ${target} (${size.width}x${size.height})`);
          }
        } catch (err) {
          autoPilotLog(`screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, delay).unref();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    if (process.platform === 'darwin') {
      // macOS gates screen recording behind an explicit permission.
      void systemPreferences.getMediaAccessStatus?.('screen');
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    inputHelper.stop();
    closeAllSessions();
  });
}
