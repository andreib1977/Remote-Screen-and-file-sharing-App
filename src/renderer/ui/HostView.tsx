import { useState } from 'react';
import type { HostController } from '../hooks/useHostSession';
import type { AppInfo } from '../../main/preload';
import type { AppSettings } from '../../main/settings';
import { api, useCopyToClipboard } from '../lib/hooks';
import { useT } from '../lib/i18n';
import type { Toast } from './Toasts';

interface Props {
  host: HostController;
  settings: AppSettings;
  info: AppInfo | null;
  sessionSeconds: number;
  onStart: () => Promise<void>;
  onStop: () => void;
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  pushToast: (toast: Omit<Toast, 'id'>) => void;
  onCodeCopied: () => void;
}

export function HostView(props: Props): JSX.Element {
  const { host, settings, info } = props;
  const t = useT();
  const [copied, copy] = useCopyToClipboard();
  const [passwordDraft, setPasswordDraft] = useState(settings.password);
  const [busy, setBusy] = useState(false);

  const phase = host.state.phase;
  const live = phase === 'live';
  const active = phase === 'ready' || phase === 'viewer-connecting' || phase === 'live' || phase === 'registering';
  const controlRequested = host.state.controlRequested && !host.state.controlGranted;

  const start = async () => {
    setBusy(true);
    try {
      await props.onStart();
    } finally {
      setBusy(false);
    }
  };

  const toggleRemoteInput = async (allow: boolean) => {
    await props.onSaveSettings({ allowRemoteInput: allow });
    await host.setAllowRemoteInput(allow);
  };

  const changePassword = async () => {
    const next = passwordDraft.replace(/\D/g, '').slice(0, 12);
    if (next.length < 4) {
      props.pushToast({ level: 'warn', text: t('share.passwordTooShort') });
      return;
    }
    setPasswordDraft(next);
    await props.onSaveSettings({ password: next });
    await host.setPassword(next);
    props.pushToast({ level: 'success', text: t('share.passwordUpdated'), detail: t('share.passwordUpdatedDetail') });
  };

  const sendFiles = async () => {
    const picked = await api().pickFiles({ folders: true });
    if (picked.length) await host.sendPaths(picked);
  };

  return (
    <section className="share">
      <div className="share__grid">
        <div className="card share__main">
          <div className="card__head">
            <h2>{t('share.title')}</h2>
            {live && <span className="pill pill--live">{t('common.live')}</span>}
            {phase === 'ready' && <span className="pill">{t('share.waitingViewer')}</span>}
            {phase === 'viewer-connecting' && <span className="pill pill--warn">{t('share.viewerConnecting')}</span>}
          </div>

          {!active && (
            <>
              <p className="muted">{t('share.intro')}</p>
              <button className="btn btn--primary btn--lg" onClick={start} disabled={busy}>
                {busy ? t('common.starting') : t('share.startSharing')}
              </button>
              {host.state.error && <p className="alert alert--error">{host.state.error}</p>}
              {info?.helper.state === 'failed' && (
                <p className="alert alert--warn">
                  {t('share.helperFailedTitle')}: {info.helper.error}
                  <br />
                  {t('share.helperStillWorks')}
                </p>
              )}
            </>
          )}

          {active && (
            <>
              <div className="codeblock">
                <div>
                  <span className="codeblock__label">{t('share.yourSessionCode')}</span>
                  <div className="codeblock__code">{host.state.code || '··· ···'}</div>
                </div>
                <button
                  className="btn btn--subtle"
                  onClick={() => {
                    copy(host.state.code.replace(/\s/g, ''));
                    props.onCodeCopied();
                  }}
                >
                  {copied ? t('common.copied') : t('common.copy')}
                </button>
              </div>

              {info?.localServer.running && info.localServer.lanUrls[0] && (
                <div className="lanbox">
                  <span className="lanbox__label">{t('share.addressToSend')}</span>
                  <div className="lanbox__row">
                    <code className="lanbox__url">{info.localServer.lanUrls[0]}</code>
                    <button
                      className="btn btn--subtle btn--sm"
                      onClick={() => {
                        copy(info.localServer.lanUrls[0]);
                        props.pushToast({
                          level: 'info',
                          text: t('share.addressCopied'),
                          detail: t('share.addressCopiedDetail')
                        });
                      }}
                    >
                      {t('common.copy')}
                    </button>
                  </div>
                  <span className="field__hint">{t('share.addressHint')}</span>
                </div>
              )}

              <div className="field-row">
                <label className="field">
                  <span className="field__label">{t('share.passwordLabel')}</span>
                  <input
                    className="input"
                    value={passwordDraft}
                    onChange={(e) => setPasswordDraft(e.target.value.replace(/\D/g, '').slice(0, 12))}
                  />
                </label>
                <button className="btn btn--subtle" onClick={changePassword} disabled={passwordDraft === settings.password}>
                  {t('common.update')}
                </button>
              </div>

              <dl className="meta">
                <div>
                  <dt>{t('share.status')}</dt>
                  <dd>
                    {live
                      ? t('share.connectedTo', {
                          name: host.state.viewer?.name || t('share.viewerNameFallback'),
                          time: formatClock(props.sessionSeconds)
                        })
                      : phase === 'viewer-connecting'
                      ? t('share.negotiating')
                      : t('share.waitingSomeone')}
                  </dd>
                </div>
                <div>
                  <dt>{t('share.session')}</dt>
                  <dd>
                    {host.state.viewer ? t('share.sessionFull') : t('share.sessionFree')}
                    {host.state.replacedViewers > 0
                      ? t(host.state.replacedViewers === 1 ? 'share.sessionReplacedOne' : 'share.sessionReplacedMany', {
                          count: host.state.replacedViewers
                        })
                      : ''}
                  </dd>
                </div>
                <div>
                  <dt>{t('share.stream')}</dt>
                  <dd>
                    {host.state.stats
                      ? `${host.state.stats.width || '?'}×${host.state.stats.height || '?'} · ${Math.round(
                          host.state.stats.fps
                        )} fps · ${Math.round(host.state.stats.bitrateKbps / 8)} KB/s`
                      : t('share.idle')}
                    {host.state.audioActive ? t('share.audioOn') : ''}
                  </dd>
                </div>
                <div>
                  <dt>{t('share.transfers')}</dt>
                  <dd>
                    {host.transfers.length
                      ? t('share.transfersActive', {
                          active: host.transfers.filter((transfer) => transfer.status === 'active').length,
                          total: host.transfers.length
                        })
                      : t('share.noneYet')}
                  </dd>
                </div>
              </dl>

              <div className="actions">
                <button className="btn btn--subtle" onClick={sendFiles}>
                  {t('share.sendFiles')}
                </button>
                <button className="btn btn--ghost" onClick={props.onStop}>
                  {t('share.stopSharing')}
                </button>
              </div>
            </>
          )}
        </div>

        <div className="card share__side">
          <h2>{t('share.permissions')}</h2>

          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.allowRemoteInput}
              onChange={(e) => void toggleRemoteInput(e.target.checked)}
              disabled={!active}
            />
            <span>
              {t('share.allowRemoteInput')}
              <em>{t('share.allowRemoteInputHint')}</em>
            </span>
          </label>

          {controlRequested && (
            <div className="alert alert--ask">
              <strong>{t('share.controlRequested', { name: host.state.viewer?.name || t('share.viewerNameFallback') })}</strong>
              <div className="alert__actions">
                <button className="btn btn--primary btn--sm" onClick={host.grantControl}>
                  {t('share.allow')}
                </button>
                <button className="btn btn--ghost btn--sm" onClick={host.denyControl}>
                  {t('share.deny')}
                </button>
              </div>
            </div>
          )}

          {host.state.controlGranted && (
            <div className="alert alert--ok">
              {t('share.controlActive')}
              <button className="btn btn--ghost btn--sm" onClick={host.denyControl}>
                {t('share.revoke')}
              </button>
            </div>
          )}

          <h2>{t('share.screen')}</h2>
          <label className="field">
            <span className="field__label">{t('share.monitor')}</span>
            <select
              className="input"
              disabled={!active}
              value={host.activeMonitorId || host.monitors.find((monitor) => monitor.primary)?.id || host.monitors[0]?.id || ''}
              onChange={(e) => void host.switchMonitor(e.target.value)}
            >
              {host.monitors.map((monitor) => (
                <option key={monitor.id} value={monitor.id}>
                  {monitor.label}
                </option>
              ))}
            </select>
            <span className="field__hint">{t('share.monitorHint')}</span>
          </label>

          <label className="field">
            <span className="field__label">{t('share.frameRate')}</span>
            <select className="input" value={host.quality.fps} onChange={(e) => void host.setQuality({ fps: Number(e.target.value) })}>
              <option value={15}>{t('share.fps15')}</option>
              <option value={30}>{t('share.fps30')}</option>
              <option value={60}>{t('share.fps60')}</option>
            </select>
          </label>

          <label className="field">
            <span className="field__label">{t('share.sharpness')}</span>
            <select className="input" value={host.quality.scale} onChange={(e) => void host.setQuality({ scale: Number(e.target.value) })}>
              <option value={1}>{t('share.scaleNative')}</option>
              <option value={0.75}>{t('share.scale75')}</option>
              <option value={0.5}>{t('share.scale50')}</option>
            </select>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={host.quality.audio}
              onChange={(e) => void host.setQuality({ audio: e.target.checked })}
            />
            <span>
              {t('share.shareAudio')}
              <em>{host.state.audioActive ? t('share.shareAudioHintOn') : t('share.shareAudioHintOff')}</em>
            </span>
          </label>
        </div>
      </div>
    </section>
  );
}

function formatClock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
