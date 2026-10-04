import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SignalingClient, SignalingStatus } from '../lib/signaling-client';
import { api, generatePassword, useTicker } from '../lib/hooks';
import { useT } from '../lib/i18n';
import { useHostSession } from '../hooks/useHostSession';
import { useViewerSession } from '../hooks/useViewerSession';
import { useAutoPilot } from '../hooks/useAutoPilot';
import { Toasts, Toast } from './Toasts';
import { HostView } from './HostView';
import { ViewerSurface } from './ViewerSurface';
import { SettingsView } from './SettingsView';
import { TransferDock } from './TransferDock';
import type { AppInfo, LocalServerStatus } from '../../main/preload';
import type { AppSettings } from '../../main/settings';

type View = 'connect' | 'share' | 'settings';

let toastSeq = 0;

export function App(): JSX.Element {
  const t = useT();
  const [view, setView] = useState<View>('connect');
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [signalingStatus, setSignalingStatus] = useState<SignalingStatus>({ state: 'idle', url: '', attempt: 0 });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [recent, setRecent] = useState<{ code: string; name: string; at: number }[]>([]);
  const [sessionStartedAt, setSessionStartedAt] = useState(0);
  /** only set for scripted runs: overrides the display name so peers are identifiable */
  const [clientId, setClientId] = useState<string | null>(null);

  const pushToast = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = ++toastSeq;
    setToasts((prev) => [...prev.slice(-4), { ...toast, id }]);
    const ttl = toast.level === 'error' ? 9000 : toast.level === 'warn' ? 7000 : 4500;
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), ttl);
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  /** The viewer pasted into the remote screen: keep the host's clipboard in step. */
  const mirrorRemoteClipboard = useCallback((text: string) => {
    void api().copyText(text).catch(() => undefined);
  }, []);

  const host = useHostSession(pushToast, mirrorRemoteClipboard);
  const viewer = useViewerSession(pushToast, clientId || settings?.displayName || 'PeerLink viewer');

  // Lazy, stable references to the two controllers for the socket callbacks.
  const hostRef = useRef(host);
  hostRef.current = host;
  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;

  const [signaling] = useState(
    () =>
      new SignalingClient('', {
        onEvent: (event) => {
          hostRef.current.session?.onSignalingEvent(event);
          viewerRef.current.session?.onSignalingEvent(event);
        },
        onStatus: (status) => setSignalingStatus(status)
      })
  );

  // ----------------------------------------------------------------- bootstrap
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [appInfo, stored, recents] = await Promise.all([api().getAppInfo(), api().getSettings(), api().getRecent()]);
      if (cancelled) return;
      setInfo(appInfo);
      setRecent(recents);
      hostRef.current.attach(signaling);
      viewerRef.current.attach(signaling);
      if (stored.password) {
        setSettings(stored);
      } else {
        const saved = await api().setSettings({ password: generatePassword() });
        if (!cancelled) setSettings(saved);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signaling]);

  useEffect(() => {
    if (!settings?.serverUrl) return;
    signaling.setUrl(settings.serverUrl);
    signaling.connect();
  }, [settings?.serverUrl, signaling]);

  useEffect(() => {
    return () => signaling.close();
  }, [signaling]);

  // ------------------------------------------------------------------- actions
  const saveSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const saved = await api().setSettings(patch);
    setSettings(saved);
    return saved;
  }, []);

  const startSharing = useCallback(async () => {
    if (!settings) return;
    setView('share');
    await host.start({
      password: settings.password,
      displayName: clientId || settings.displayName,
      allowRemoteInput: settings.allowRemoteInput,
      autoAcceptFiles: settings.autoAcceptFiles,
      quality: settings.quality,
      audio: settings.quality.audio
    });
    setSessionStartedAt(Date.now());
  }, [host, settings, clientId]);

  const stopSharing = useCallback(() => {
    host.stop();
    setSessionStartedAt(0);
  }, [host]);

  const connectToPeer = useCallback(
    async (code: string, password: string, wantsControl: boolean) => {
      if (!settings) return;
      const digits = code.replace(/\D/g, '');
      await viewer.connect(digits, password, { wantsControl, autoAccept: settings.autoAcceptFiles });
      const updated = await api().pushRecent({ code: digits, name: '', at: Date.now() });
      setRecent(updated);
    },
    [settings, viewer]
  );

  const onCodeCopied = useCallback(() => {
    pushToast({ level: 'info', text: t('share.codeCopied'), detail: t('share.codeCopiedDetail') });
  }, [pushToast, t]);

  useAutoPilot({
    ready: settings !== null,
    host,
    viewer,
    onStartHost: startSharing,
    signalingStatus: () => signaling.getStatus(),
    onClientId: setClientId
  });

  const inSession = viewer.state.phase === 'live' || viewer.state.phase === 'negotiating' || viewer.state.phase === 'ended';

  const tick = useTicker(1000);
  const sessionSeconds = useMemo(
    () => (sessionStartedAt ? Math.floor((Date.now() - sessionStartedAt) / 1000) : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick, sessionStartedAt]
  );

  if (!settings) {
    return <div className="boot">{t('app.starting')}</div>;
  }

  return (
    <div className={`app ${inSession ? 'app--viewer' : ''}`}>
      <Toasts toasts={toasts} onDismiss={dismissToast} />

      {!inSession && (
        <header className="topbar">
          <div className="brand">
            <span className="brand__mark">PL</span>
            <div className="brand__text">
              <strong>PeerLink</strong>
              <span className="brand__sub">{t('app.tagline')}</span>
            </div>
          </div>

          <nav className="tabs">
            <button className={`tab ${view === 'connect' ? 'is-active' : ''}`} onClick={() => setView('connect')}>
              {t('tabs.connect')}
            </button>
            <button className={`tab ${view === 'share' ? 'is-active' : ''}`} onClick={() => setView('share')}>
              {t('tabs.share')}
              {host.state.phase !== 'idle' && host.state.phase !== 'error' && <span className="tab__dot" />}
            </button>
            <button className={`tab ${view === 'settings' ? 'is-active' : ''}`} onClick={() => setView('settings')}>
              {t('tabs.settings')}
            </button>
          </nav>

          <div className="topbar__status">
            {host.state.phase === 'live' && (
              <span className="pill pill--live">
                {t('common.live')} · {formatClock(sessionSeconds)}
              </span>
            )}
            <StatusPill status={signalingStatus} />
          </div>
        </header>
      )}

      <main className="content">
        {!inSession && view === 'connect' && (
          <ConnectView
            recent={recent}
            viewerState={viewer.state}
            onConnect={connectToPeer}
            onCancel={viewer.disconnect}
            serverOnline={signalingStatus.state === 'open'}
            localServer={info?.localServer ?? null}
            onStartServer={async () => {
              const status = await api().ensureServer(settings.localServerPort || 8787);
              setInfo(await api().getAppInfo());
              pushToast(
                status.running
                  ? { level: 'success', text: t('settings.localServerStarted'), detail: status.lanUrls[0] || status.url }
                  : { level: 'error', text: t('settings.localServerFailed'), detail: status.error }
              );
            }}
          />
        )}

        {!inSession && view === 'share' && (
          <HostView
            host={host}
            settings={settings}
            info={info}
            sessionSeconds={sessionSeconds}
            onStart={startSharing}
            onStop={stopSharing}
            onSaveSettings={saveSettings}
            pushToast={pushToast}
            onCodeCopied={onCodeCopied}
          />
        )}

        {!inSession && view === 'settings' && (
          <SettingsView
            info={info}
            settings={settings}
            host={host}
            onSave={saveSettings}
            pushToast={pushToast}
            onRefreshInfo={async () => setInfo(await api().getAppInfo())}
          />
        )}

        {inSession && (
          <ViewerSurface
            viewer={viewer}
            settings={settings}
            onSaveSettings={saveSettings}
            pushToast={pushToast}
          />
        )}
      </main>

      {!inSession && (
        <TransferDock
          transfers={[...host.transfers, ...viewer.transfers]}
          onReveal={(path) => void api().revealPath(path)}
          onCancel={(id, direction) => {
            if (direction === 'send') {
              void host.session?.cancelTransfer(id);
              void viewer.session?.cancelTransfer(id);
            }
          }}
        />
      )}
    </div>
  );
}

function StatusPill({ status }: { status: SignalingStatus }): JSX.Element {
  const t = useT();
  const label =
    status.state === 'open'
      ? status.latencyMs !== undefined
        ? t('status.serverLatency', { ms: status.latencyMs })
        : t('status.serverOnline')
      : status.state === 'connecting'
      ? t('status.serverConnecting')
      : status.state === 'reconnecting'
      ? t('status.serverReconnecting', { attempt: status.attempt })
      : status.state === 'closed'
      ? t('status.serverOffline')
      : t('status.serverIdle');

  return (
    <span className={`status status--${status.state}`} title={status.lastError || status.url}>
      <span className="status__dot" />
      {label}
    </span>
  );
}

function formatClock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function ConnectView(props: {
  recent: { code: string; name: string; at: number }[];
  viewerState: ReturnType<typeof useViewerSession>['state'];
  onConnect: (code: string, password: string, wantsControl: boolean) => Promise<void>;
  onCancel: () => void;
  serverOnline: boolean;
  localServer: LocalServerStatus | null;
  onStartServer: () => Promise<void>;
}): JSX.Element {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [wantsControl, setWantsControl] = useState(true);
  const [starting, setStarting] = useState(false);
  const t = useT();
  const busy = props.viewerState.phase === 'joining' || props.viewerState.phase === 'negotiating';
  const ready = code.replace(/\D/g, '').length === 6 && password.length >= 4;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    void props.onConnect(code, password, wantsControl);
  };

  return (
    <section className="connect">
      <div className="connect__hero">
        <h1>{t('connect.title')}</h1>
        <p>{t('connect.subtitle', { code: t('connect.sixDigitCode') })}</p>
      </div>

      {!props.serverOnline && props.localServer?.running && (
        <div className="alert alert--warn">
          <strong>{t('connect.localServerReconnecting', { port: props.localServer.port })}</strong>
          <div className="alert__actions">
            <button
              className="btn btn--primary btn--sm"
              disabled={starting}
              onClick={async () => {
                setStarting(true);
                try {
                  await props.onStartServer();
                } finally {
                  setStarting(false);
                }
              }}
            >
              {starting ? t('common.starting') : t('connect.restartServer')}
            </button>
          </div>
        </div>
      )}

      {!props.serverOnline && !props.localServer?.running && (
        <div className="alert alert--warn">
          <strong>{t('connect.serverDownTitle')}</strong>
          <div className="field__hint" style={{ marginTop: 6 }}>
            {t('connect.serverDownBody')}
          </div>
          <div className="alert__actions">
            <button
              className="btn btn--primary btn--sm"
              disabled={starting}
              onClick={async () => {
                setStarting(true);
                try {
                  await props.onStartServer();
                } finally {
                  setStarting(false);
                }
              }}
            >
              {starting ? t('common.starting') : t('connect.startServerHere')}
            </button>
          </div>
        </div>
      )}

      {props.serverOnline && props.localServer?.running && props.localServer.ownedByUs && (
        <p className="hint">
          {t('connect.localServerRunning')}
          {props.localServer.lanUrls[0] ? ` · ${t('connect.othersUse', { url: props.localServer.lanUrls[0] })}` : ''}
        </p>
      )}

      <form className="card connect__form" onSubmit={submit}>
        <label className="field">
          <span className="field__label">{t('connect.sessionCode')}</span>
          <input
            className="input input--code"
            value={code}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
              setCode(digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits);
            }}
            placeholder="123 456"
            inputMode="numeric"
            autoFocus
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span className="field__label">{t('connect.password')}</span>
          <input
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value.replace(/\D/g, '').slice(0, 12))}
            placeholder="123456"
            inputMode="numeric"
            spellCheck={false}
          />
        </label>

        <label className="toggle">
          <input type="checkbox" checked={wantsControl} onChange={(e) => setWantsControl(e.target.checked)} />
          <span>
            {t('connect.requestControl')}
            <em>{t('connect.requestControlHint')}</em>
          </span>
        </label>

        <div className="connect__actions">
          <button className="btn btn--primary" type="submit" disabled={busy || !ready}>
            {busy ? t('connect.connecting') : t('connect.connect')}
          </button>
          <button className="btn btn--ghost" type="button" onClick={props.onCancel} disabled={!busy}>
            {t('common.cancel')}
          </button>
        </div>

        {props.viewerState.error && <p className="alert alert--error">{props.viewerState.error}</p>}
        {busy && <p className="hint">{t('connect.waiting')}</p>}
      </form>

      {props.recent.length > 0 && (
        <div className="recent">
          <h2>{t('connect.recent')}</h2>
          <ul className="recent__list">
            {props.recent.map((entry) => (
              <li key={entry.code}>
                <button
                  className="recent__item"
                  onClick={() => setCode(entry.code.length > 3 ? `${entry.code.slice(0, 3)} ${entry.code.slice(3)}` : entry.code)}
                >
                  <span className="recent__code">{entry.code}</span>
                  <span className="recent__meta">{new Date(entry.at).toLocaleString()}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
