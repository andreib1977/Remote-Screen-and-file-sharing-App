import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewerController } from '../hooks/useViewerSession';
import type { AppSettings } from '../../main/settings';
import { api, useTicker } from '../lib/hooks';
import { useT } from '../lib/i18n';
import { formatBytes, formatRate } from '../lib/format';
import type { Toast } from './Toasts';
import type { TransferRecord } from '../../shared/transfer/manager';

interface Props {
  viewer: ViewerController;
  settings: AppSettings;
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  pushToast: (toast: Omit<Toast, 'id'>) => void;
}

export function ViewerSurface({ viewer, pushToast }: Props): JSX.Element {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [showToolbar, setShowToolbar] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [syncingClipboard, setSyncingClipboard] = useState(true);
  const [audioMuted, setAudioMuted] = useState(true);
  const tick = useTicker(1000);
  const lastRemoteClipboard = useRef<string | null>(null);

  const state = viewer.state;

  // Attach the remote stream and rebind input whenever the video element changes.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !viewer.stream) return;
    video.srcObject = viewer.stream;
    void video.play().catch(() => undefined);
    const detach = viewer.session?.bindInputSurface(video);
    video.focus();
    return () => detach?.();
  }, [viewer.stream, viewer.session, state.phase]);

  // Clipboard: host -> viewer.
  useEffect(() => {
    const text = state.remoteClipboard;
    if (!text || !syncingClipboard) return;
    if (lastRemoteClipboard.current === text) return;
    lastRemoteClipboard.current = text;
    void api().copyText(text).catch(() => undefined);
  }, [state.remoteClipboard, syncingClipboard]);

  // Clipboard: viewer -> host. Only fires on local changes, and skips anything we just
  // wrote ourselves, so the two sides cannot ping-pong.
  useEffect(() => {
    if (!syncingClipboard || !state.controlGranted) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      const text = await api().readText().catch(() => '');
      if (cancelled || !text) return;
      if (text === lastRemoteClipboard.current) return;
      lastRemoteClipboard.current = text;
      viewer.session?.sendClipboardText(text);
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [syncingClipboard, state.controlGranted, viewer.session]);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const files = event.dataTransfer?.files;
      if (files && files.length) {
        void viewer.sendBrowserFiles(files);
        pushToast({ level: 'info', text: t('viewer.sendingFiles', { count: files.length }) });
        return;
      }
      const path = event.dataTransfer?.getData('text/plain');
      if (path) void viewer.sendPaths([path]);
    },
    [pushToast, viewer, t]
  );

  const sendFiles = async () => {
    const picked = await api().pickFiles({ folders: true });
    if (picked.length) await viewer.sendPaths(picked);
  };

  const pickFolder = async () => {
    const dir = await api().pickPath({ directory: true, title: t('viewer.sendFolder') });
    if (dir) {
      pushToast({ level: 'info', text: t('viewer.preparingFolder'), detail: dir });
      await viewer.sendPaths([dir]);
    }
  };

  const toggleFullscreen = () => {
    const element = surfaceRef.current;
    if (!element) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void element.requestFullscreen().catch(() => undefined);
  };

  const stats = state.stats;
  const session = state.session;
  const active = state.phase === 'live';
  const transfers = viewer.transfers;

  return (
    <div className="viewer" ref={surfaceRef}>
      <div
        className={`viewer__stage ${dragging ? 'is-dragover' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <video
          ref={videoRef}
          className="viewer__video"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            cursor: state.controlGranted ? 'none' : 'default'
          }}
          muted={audioMuted}
          playsInline
          tabIndex={0}
          onWheel={(e) => {
            if (!state.controlGranted && e.ctrlKey) {
              setZoom((z) => Math.min(3, Math.max(0.4, z - Math.sign(e.deltaY) * 0.1)));
            }
          }}
        />

        {state.phase !== 'live' && (
          <div className="viewer__overlay">
            {state.phase === 'negotiating' || state.phase === 'joining' ? (
              <>
                <div className="spinner" />
                <p>{state.phase === 'joining' ? t('viewer.contacting') : t('viewer.negotiating')}</p>
              </>
            ) : state.phase === 'ended' ? (
              <>
                <p>{state.endReason || t('viewer.sessionEnded')}</p>
                <button className="btn btn--primary" onClick={() => viewer.disconnect()}>
                  {t('common.back')}
                </button>
              </>
            ) : state.phase === 'error' ? (
              <>
                <p className="alert alert--error">{state.error}</p>
                <button className="btn btn--primary" onClick={() => viewer.disconnect()}>
                  {t('common.back')}
                </button>
              </>
            ) : null}
          </div>
        )}

        {dragging && <div className="viewer__dropzone">{t('viewer.dropToSend')}</div>}
      </div>

      {showToolbar && (
        <div className="viewer__bar">
          <div className="viewer__bar-left">
            <span className={`pill ${active ? 'pill--live' : 'pill--warn'}`}>{active ? t('viewer.live') : state.phase}</span>
            <span className="viewer__title">{session?.hostName || t('viewer.remoteDesktop')}</span>
            {session && (
              <span className="viewer__meta">
                {t('viewer.streamInfo', { width: session.desktop.width, height: session.desktop.height })}
                {stats
                  ? ` · ${Math.round(stats.fps)} fps · ${Math.round(stats.bitrateKbps / 8)} KB/s${
                      stats.rttMs ? ` · ${stats.rttMs} ms` : ''
                    }`
                  : ''}
              </span>
            )}
          </div>

          <div className="viewer__bar-right">
            <button
              className={`btn btn--sm ${state.controlGranted ? 'btn--danger' : 'btn--subtle'}`}
              onClick={() => (state.controlGranted ? viewer.releaseControl() : viewer.requestControl())}
              disabled={!active}
              title={t('viewer.releaseHint')}
            >
              {state.controlGranted
                ? t('viewer.releaseControl')
                : state.controlRequested
                ? t('viewer.waitingApproval')
                : t('viewer.requestControl')}
            </button>

            <button className="btn btn--sm btn--subtle" onClick={sendFiles} disabled={!active}>
              {t('viewer.sendFiles')}
            </button>

            <button className="btn btn--sm btn--subtle" onClick={pickFolder} disabled={!active} title={t('viewer.sendFolderHint')}>
              {t('viewer.sendFolder')}
            </button>

            <label className="mini-toggle" title={t('viewer.clipboardHint')}>
              <input type="checkbox" checked={syncingClipboard} onChange={(e) => setSyncingClipboard(e.target.checked)} />
              {t('viewer.clipboard')}
            </label>

            <label className="mini-toggle" title={t('viewer.audioHint')}>
              <input
                type="checkbox"
                checked={!audioMuted}
                onChange={(e) => {
                  setAudioMuted(!e.target.checked);
                  if (videoRef.current) videoRef.current.muted = !e.target.checked;
                }}
              />
              {t('viewer.audio')}
            </label>

            <div className="zoom">
              <button className="btn btn--icon" onClick={() => setZoom((z) => Math.max(0.4, z - 0.1))} title={t('viewer.zoomOut')}>
                −
              </button>
              <button
                className="btn btn--icon"
                onClick={() => {
                  setZoom(1);
                  setPan({ x: 0, y: 0 });
                }}
                title={t('viewer.zoomFit')}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button className="btn btn--icon" onClick={() => setZoom((z) => Math.min(3, z + 0.1))} title={t('viewer.zoomIn')}>
                +
              </button>
            </div>

            <button className="btn btn--icon" onClick={toggleFullscreen} title={t('viewer.fullscreen')}>
              ⛶
            </button>
            <button className="btn btn--icon" onClick={() => setShowToolbar(false)} title={t('viewer.hideToolbar')}>
              ▴
            </button>
            <button className="btn btn--danger btn--sm" onClick={() => viewer.disconnect()}>
              {t('viewer.disconnect')}
            </button>
          </div>
        </div>
      )}

      {!showToolbar && (
        <button className="viewer__showbar" onClick={() => setShowToolbar(true)}>
          {t('viewer.showControls')}
        </button>
      )}

      <ViewerFileStrip transfers={transfers} onReveal={(path) => void api().revealPath(path)} />
      <div className="hidden-tick" data-tick={tick} />
    </div>
  );
}

function ViewerFileStrip({
  transfers,
  onReveal
}: {
  transfers: TransferRecord[];
  onReveal: (path: string) => void;
}): JSX.Element | null {
  const t = useT();
  const visible = transfers.filter((transfer) => transfer.status === 'active' || transfer.status === 'offered').slice(0, 3);
  if (!visible.length) return null;
  return (
    <div className="viewer__files">
      {visible.map((transfer) => {
        const pct = transfer.meta.size ? Math.min(100, (transfer.progress / transfer.meta.size) * 100) : 0;
        return (
          <div key={transfer.id} className="viewer__file">
            <span className="viewer__file-name">
              {transfer.direction === 'send' ? '↑' : '↓'} {transfer.meta.name}
            </span>
            <span className="viewer__file-bar">
              <span style={{ width: `${pct}%` }} />
            </span>
            <span className="viewer__file-meta">
              {formatBytes(transfer.progress)} / {formatBytes(transfer.meta.size)}
              {transfer.direction === 'send' && transfer.bytesPerSecond ? ` · ${formatRate(transfer.bytesPerSecond)}` : ''}
            </span>
            {transfer.savedPath && (
              <button className="btn btn--ghost btn--sm" onClick={() => onReveal(transfer.savedPath!)}>
                {t('viewer.openFolder')}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
