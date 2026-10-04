import { useState } from 'react';
import type { AppInfo, HelperStatus, LocalServerStatus } from '../../main/preload';
import type { AppSettings } from '../../main/settings';
import type { HostController } from '../hooks/useHostSession';
import { api, generatePassword } from '../lib/hooks';
import { useLanguage, useT } from '../lib/i18n';
import { LANGUAGES, languageNames, type Language } from '../../shared/i18n';
import type { Toast } from './Toasts';

interface Props {
  info: AppInfo | null;
  settings: AppSettings;
  host: HostController;
  onSave: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  pushToast: (toast: Omit<Toast, 'id'>) => void;
  onRefreshInfo: () => Promise<void>;
}

export function SettingsView({ info, settings, host, onSave, pushToast, onRefreshInfo }: Props): JSX.Element {
  const t = useT();
  const language = useLanguage();
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [displayName, setDisplayName] = useState(settings.displayName);
  const [downloadDir, setDownloadDir] = useState(settings.downloadDir);
  const [helper, setHelper] = useState<HelperStatus | null>(info?.helper ?? null);
  const [server, setServer] = useState<LocalServerStatus | null>(info?.localServer ?? null);
  const [busy, setBusy] = useState(false);

  const refreshServer = async () => {
    const status = await api().serverStatus();
    setServer(status);
    return status;
  };

  const apply = async (patch: Partial<AppSettings>, message: string) => {
    await onSave(patch);
    pushToast({ level: 'success', text: message });
  };

  const startLocalServer = async () => {
    setBusy(true);
    try {
      const status = await api().ensureServer(settings.localServerPort || 8787);
      setServer(status);
      if (status.running) {
        const lan = status.lanUrls[0];
        pushToast({
          level: 'success',
          text: 'Local server is running',
          detail: lan ? `Others connect to ${lan}` : 'Reachable on this machine only.'
        });
        // Point this app at the local server so the two halves agree.
        if (!settings.useLocalServer) await onSave({ useLocalServer: true, serverUrl: status.url });
        setServerUrl(status.url);
      } else {
        pushToast({ level: 'error', text: 'Could not start the local server', detail: status.error });
      }
      await onRefreshInfo();
    } finally {
      setBusy(false);
    }
  };

  const testHelper = async () => {
    const status = await api().inputStatus();
    if (status.state !== 'ready') {
      const started = await api().inputStart();
      setHelper(started);
      if (started.state === 'ready')
        pushToast({
          level: 'success',
          text: t('settings.helperTestReady'),
          detail: `${started.screen?.width}×${started.screen?.height}`
        });
      else pushToast({ level: 'error', text: t('settings.helperTestFailed'), detail: started.error });
      await onRefreshInfo();
      return;
    }
    // Nudge the pointer to prove injection really works, then report.
    if (status.screen) {
      await api().inputCommand({ t: 'move', x: 0.5, y: 0.5 });
    }
    setHelper(status);
    pushToast({ level: 'success', text: t('settings.helperTestOk'), detail: t('settings.helperTestOkDetail') });
    await onRefreshInfo();
  };

  const regeneratePassword = async () => {
    const password = generatePassword();
    await onSave({ password });
    if (host.session) await host.setPassword(password);
    pushToast({
      level: 'success',
      text: t('settings.newPassword', { password }),
      detail: t('settings.newPasswordDetail')
    });
  };

  const changeLanguage = async (next: Language) => {
    await onSave({ language: next });
    // The provider lives above this component, so the change is announced and applied
    // immediately: the whole UI re-renders in the new language.
    window.dispatchEvent(new CustomEvent('peerlink:language', { detail: { language: next } }));
  };

  /**
   * Saving a server address also settles *who runs the server*.
   *
   * "Start the bundled server" and "connect to a different server" are contradictory, and
   * letting both stand is what once left the app retrying a dead address while its own server
   * sat idle. Pointing at an address that is not ours therefore turns auto-start off, so the
   * choice sticks across restarts.
   */
  const saveServerUrl = async () => {
    const target = serverUrl.trim();
    if (!target) return;
    const ownAddresses = server?.running ? [server.url, ...(server.lanUrls ?? [])] : [];
    const isOurOwnServer = ownAddresses.includes(target);

    if (isOurOwnServer) {
      await apply({ serverUrl: target }, t('settings.serverUpdated'));
      return;
    }

    const wasAutoStarting = settings.useLocalServer;
    await apply({ serverUrl: target, useLocalServer: false }, t('settings.serverUpdated'));
    if (wasAutoStarting) {
      pushToast({
        level: 'info',
        text: t('settings.autoStartTurnedOff'),
        detail: t('settings.autoStartTurnedOffDetail')
      });
    }
  };

  return (
    <section className="settings">
      <div className="settings__grid">
        <div className="card">
          <h2>{t('settings.languageSection')}</h2>
          <label className="field">
            <span className="field__label">{t('language.switch')}</span>
            <select
              className="input"
              value={language || 'en'}
              onChange={(e) => void changeLanguage(e.target.value as Language)}
            >
              {LANGUAGES.map((code) => (
                <option key={code} value={code}>
                  {languageNames[code]}
                </option>
              ))}
            </select>
            <span className="field__hint">{t('settings.languageHint')}</span>
          </label>

          <h2>{t('settings.serverSection')}</h2>
          <p className={server?.running ? 'state state--ok' : 'state state--error'}>
            {server?.running
              ? t(server.ownedByUs ? 'settings.serverRunningOwned' : 'settings.serverRunningExternal', { port: server.port })
              : server?.error || t('settings.serverNotRunning')}
          </p>

          {server?.running && (
            <div className="lanbox">
              <span className="lanbox__label">{t('settings.othersEnter')}</span>
              <div className="lanbox__row">
                <code className="lanbox__url">{server.lanUrls[0] || server.url}</code>
                <button
                  className="btn btn--subtle btn--sm"
                  onClick={() => {
                    void api().copyText(server.lanUrls[0] || server.url);
                    pushToast({ level: 'info', text: t('settings.addressCopied'), detail: t('settings.addressCopiedDetail') });
                  }}
                >
                  {t('common.copy')}
                </button>
              </div>
              {server.lanUrls.length > 1 && (
                <span className="field__hint">{t('settings.otherInterfaces', { list: server.lanUrls.slice(1).join(', ') })}</span>
              )}
              <span className="field__hint">{t('settings.addressHint')}</span>
            </div>
          )}

          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.useLocalServer}
              onChange={(e) =>
                void apply(
                  { useLocalServer: e.target.checked },
                  e.target.checked ? t('settings.autoStartOn') : t('settings.autoStartOff')
                )
              }
            />
            <span>
              {t('settings.autoStart')}
              <em>{t('settings.autoStartHint')}</em>
            </span>
          </label>

          <div className="actions">
            <button className="btn btn--subtle btn--sm" onClick={startLocalServer} disabled={busy}>
              {busy ? t('settings.starting') : server?.running ? t('settings.restart') : t('settings.startNow')}
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => void refreshServer()}>
              {t('common.refresh')}
            </button>
          </div>

          <h2>{t('settings.connection')}</h2>
          <label className="field">
            <span className="field__label">{t('settings.serverUsedByApp')}</span>
            <input className="input" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} spellCheck={false} />
            <span className="field__hint">
              {settings.useLocalServer ? t('settings.serverManagedByLocal') : t('settings.serverHint')}
            </span>
          </label>
          <div className="actions">
            <button
              className="btn btn--primary btn--sm"
              onClick={saveServerUrl}
              disabled={serverUrl.trim() === settings.serverUrl}
            >
              {t('common.save')}
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => setServerUrl(settings.serverUrl)}>
              {t('common.reset')}
            </button>
          </div>

          <label className="field">
            <span className="field__label">{t('settings.displayName')}</span>
            <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            <span className="field__hint">{t('settings.displayNameHint')}</span>
          </label>
          <button className="btn btn--subtle btn--sm" onClick={() => void apply({ displayName }, t('settings.nameSaved'))}>
            {t('common.saveName')}
          </button>
        </div>

        <div className="card">
          <h2>{t('settings.files')}</h2>
          <label className="field">
            <span className="field__label">{t('settings.saveReceivedTo')}</span>
            <input className="input" value={downloadDir} onChange={(e) => setDownloadDir(e.target.value)} spellCheck={false} />
          </label>
          <div className="actions">
            <button className="btn btn--primary btn--sm" onClick={() => void apply({ downloadDir }, t('settings.downloadDirUpdated'))}>
              {t('common.save')}
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => void api().openPath(downloadDir)}>
              {t('common.openFolder')}
            </button>
          </div>

          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.autoAcceptFiles}
              onChange={(e) => void apply({ autoAcceptFiles: e.target.checked }, t('settings.preferenceSaved'))}
            />
            <span>
              {t('settings.autoAccept')}
              <em>{t('settings.autoAcceptHint')}</em>
            </span>
          </label>

          <h2>{t('settings.session')}</h2>
          <div className="field-row">
            <label className="field">
              <span className="field__label">{t('settings.persistentPassword')}</span>
              <input className="input" value={settings.password} readOnly />
            </label>
            <button className="btn btn--subtle" onClick={regeneratePassword}>
              {t('common.regenerate')}
            </button>
          </div>
          <p className="field__hint">{t('settings.passwordHint')}</p>
        </div>

        <div className="card">
          <h2>{t('settings.helper')}</h2>
          <p className={helperClass(helper)}>
            {helper?.state === 'ready'
              ? t('settings.helperReady', { width: helper.screen?.width ?? '?', height: helper.screen?.height ?? '?' })
              : helper?.state === 'starting'
              ? t('settings.helperStarting')
              : helper?.state === 'failed'
              ? helper.error || t('settings.helperFailed')
              : t('settings.helperStopped')}
          </p>
          <p className="field__hint">{t('settings.helperHint')}</p>
          <div className="actions">
            <button className="btn btn--subtle btn--sm" onClick={testHelper}>
              {t('settings.testHelper')}
            </button>
            <button
              className="btn btn--ghost btn--sm"
              onClick={async () => {
                const status = await api().inputStop();
                setHelper(status);
                await onRefreshInfo();
                pushToast({ level: 'info', text: t('settings.helperStoppedToast') });
              }}
            >
              {t('settings.stopHelper')}
            </button>
          </div>

          <h2>{t('settings.diagnostics')}</h2>
          <dl className="meta meta--tight">
            <div>
              <dt>{t('settings.peerlink')}</dt>
              <dd>{info?.version ?? '-'}</dd>
            </div>
            <div>
              <dt>Electron</dt>
              <dd>{info?.electron ?? '-'} · Chromium {info?.chrome ?? '-'}</dd>
            </div>
            <div>
              <dt>{t('settings.platform')}</dt>
              <dd>
                {info?.platform} {info?.arch}
              </dd>
            </div>
            <div>
              <dt>{t('settings.userData')}</dt>
              <dd className="ellipsis" title={info?.userData}>
                {info?.userData}
              </dd>
            </div>
          </dl>
          <button
            className="btn btn--ghost btn--sm"
            onClick={async () => {
              await api().openPath(info?.userData ?? '');
            }}
          >
            {t('settings.openDataFolder')}
          </button>
        </div>
      </div>
    </section>
  );
}

function helperClass(helper: HelperStatus | null): string {
  if (helper?.state === 'ready') return 'state state--ok';
  if (helper?.state === 'failed') return 'state state--error';
  return 'state';
}
