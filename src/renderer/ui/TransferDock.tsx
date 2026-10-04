import { useTicker } from '../lib/hooks';
import { useT } from '../lib/i18n';
import type { Translate } from '../lib/i18n';
import { formatBytes, formatEta, formatRate } from '../lib/format';
import type { TransferRecord } from '../../shared/transfer/manager';

interface Props {
  transfers: TransferRecord[];
  onReveal: (path: string) => void;
  onCancel: (id: string, direction: TransferRecord['direction']) => void;
}

export function TransferDock({ transfers, onReveal, onCancel }: Props): JSX.Element | null {
  // Re-render twice a second so rates and ETAs stay honest without extra state.
  useTicker(500);
  const t = useT();

  const interesting = transfers.filter((transfer) => transfer.status !== 'done' || Date.now() - (transfer.finishedAt ?? 0) < 60_000);
  if (!interesting.length) return null;

  const active = interesting.filter((transfer) => transfer.status === 'active' || transfer.status === 'offered').length;

  return (
    <section className="dock">
      <header className="dock__head">
        <h2>
          {t('transfers.title')} {active > 0 && <span className="dock__count">{t('transfers.activeCount', { count: active })}</span>}
        </h2>
      </header>
      <ul className="dock__list">
        {interesting
          .slice()
          .reverse()
          .slice(0, 8)
          .map((transfer) => (
            <li key={transfer.id} className={`dock__item dock__item--${transfer.status}`}>
              <span className={`dock__arrow dock__arrow--${transfer.direction}`}>{transfer.direction === 'send' ? '↑' : '↓'}</span>
              <div className="dock__body">
                <div className="dock__name" title={transfer.meta.name}>
                  {transfer.meta.name}
                </div>
                <div className="dock__bar">
                  <span style={{ width: `${transfer.meta.size ? Math.min(100, (transfer.progress / transfer.meta.size) * 100) : 0}%` }} />
                </div>
                <div className="dock__meta">
                  {statusLabel(transfer, t)} · {formatBytes(transfer.progress)} / {formatBytes(transfer.meta.size)}
                  {transfer.status === 'active' && transfer.direction === 'send' && transfer.bytesPerSecond
                    ? ` · ${formatRate(transfer.bytesPerSecond)} · ${t('transfers.left', {
                        eta: formatEta(transfer.meta.size - transfer.progress, transfer.bytesPerSecond)
                      })}`
                    : ''}
                </div>
              </div>
              <div className="dock__actions">
                {transfer.savedPath && transfer.status === 'done' && (
                  <button className="btn btn--ghost btn--sm" onClick={() => onReveal(transfer.savedPath!)}>
                    {t('common.show')}
                  </button>
                )}
                {(transfer.status === 'active' || transfer.status === 'offered') && transfer.direction === 'send' && (
                  <button className="btn btn--ghost btn--sm" onClick={() => onCancel(transfer.id, transfer.direction)}>
                    {t('transfers.cancel')}
                  </button>
                )}
              </div>
            </li>
          ))}
      </ul>
    </section>
  );
}

function statusLabel(transfer: TransferRecord, t: Translate): string {
  switch (transfer.status) {
    case 'offered':
      return transfer.direction === 'send' ? t('transfers.waitingApproval') : t('transfers.incoming');
    case 'active':
      return transfer.direction === 'send' ? t('transfers.sending') : t('transfers.receiving');
    case 'done':
      return transfer.direction === 'send' ? t('transfers.sent') : t('transfers.saved');
    case 'rejected':
      return t('transfers.declined');
    case 'cancelled':
      return t('transfers.cancelled');
    case 'failed':
      return t('transfers.failed');
    default:
      return t('transfers.paused');
  }
}
