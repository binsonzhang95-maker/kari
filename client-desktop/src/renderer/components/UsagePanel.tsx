import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { UsageRange, UsageSnapshot } from '../../shared/types';
import { useI18n } from '../i18n';

// Per-product registry. Order drives display order. Adding a third
// product requires (a) a matching field on UsageSnapshot and (b) a row
// here — no other code changes.
const PRODUCTS: Array<{ id: 'deepseek' | 'kimi'; name: string }> = [
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'kimi', name: 'Kimi' }
];

const numberFmt = new Intl.NumberFormat('en-US');

function formatTokens(n: number): string {
  return numberFmt.format(Math.max(0, Math.floor(n)));
}

function formatRangeSuffix(range: UsageRange, t: ReturnType<typeof useI18n>['t']): string {
  const now = new Date();
  switch (range) {
    case 'month':
      return t('usage.suffix.month', { value: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}` });
    case 'week': {
      const dow = (now.getDay() + 6) % 7;
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
      return t('usage.suffix.week', { value: `${start.getMonth() + 1}/${start.getDate()}` });
    }
    case 'today':
      return t('usage.suffix.today', { value: `${now.getMonth() + 1}/${now.getDate()}` });
    case 'all':
    default:
      return t('usage.suffix.all');
  }
}

function formatAsOf(asOf: number, t: ReturnType<typeof useI18n>['t']): string {
  const delta = Date.now() - asOf;
  if (delta < 5_000) return t('usage.now');
  if (delta < 60_000) return t('usage.secondsAgo', { value: Math.floor(delta / 1000) });
  if (delta < 3_600_000) return t('usage.minutesAgo', { value: Math.floor(delta / 60_000) });
  const d = new Date(asOf);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export function UsagePanel() {
  const { t } = useI18n();
  const [range, setRange] = useState<UsageRange>('month');
  const [data, setData] = useState<UsageSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (next: UsageRange) => {
    setLoading(true);
    setError(null);
    try {
      const snap = await window.kari.readUsage(next);
      setData(snap);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(range);
  }, [range, refresh]);

  const totalAll = useMemo(() => {
    if (!data) return 0;
    return PRODUCTS.reduce((sum, p) => sum + (data[p.id]?.total ?? 0), 0);
  }, [data]);
  const rangeLabels = useMemo<Array<{ id: UsageRange; label: string }>>(() => [
    { id: 'month', label: t('usage.range.month') },
    { id: 'week', label: t('usage.range.week') },
    { id: 'today', label: t('usage.range.today') },
    { id: 'all', label: t('usage.range.all') }
  ], [t]);

  return (
    <div className="settings-panel usage-settings-panel">
      <section className="settings-card usage-controls-card">
        <h3>{t('usage.title')}</h3>
        <p>{t('usage.description')}</p>
        <div className="settings-action-row usage-panel__bar">
          <div className="usage-range-tabs" role="tablist" aria-label={t('usage.rangeLabel')}>
          {rangeLabels.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-pressed={range === tab.id}
              className={range === tab.id ? 'usage-range-tab usage-range-tab--active' : 'usage-range-tab'}
              onClick={() => setRange(tab.id)}
            >
              {tab.label}
            </button>
          ))}
          </div>
          <button
            type="button"
            className="settings-action usage-refresh"
            onClick={() => void refresh(range)}
            disabled={loading}
            aria-label={t('common.refresh')}
            title={t('common.refresh')}
          >
            <RefreshCw size={13} className={loading ? 'usage-refresh__icon usage-refresh__icon--spin' : 'usage-refresh__icon'} />
            <span className="usage-refresh__label">
              {loading ? t('usage.loading') : data ? formatAsOf(data.asOf, t) : t('usage.notLoaded')}
            </span>
          </button>
        </div>
      </section>

      <section className="settings-card usage-card">
        <header className="usage-card__head">
          <div>
            <h3>{t('usage.breakdownTitle')}</h3>
            <p>{t('usage.breakdownDesc')}</p>
          </div>
        </header>
        <div className="usage-list" role="list">
          {PRODUCTS.map((product) => {
            const entry = data?.[product.id];
            const total = entry?.total ?? 0;
            const inTokens = entry?.in;
            const outTokens = entry?.out;
            return (
              <div key={product.id} className="usage-row" role="listitem">
                <div className="usage-row__head">
                  <span className="usage-row__name">{product.name}</span>
                  <span className="usage-row__total">{formatTokens(total)}</span>
                </div>
                <div className="usage-row__meta">
                  <span
                    className="usage-row__metric"
                    title={inTokens === null || inTokens === undefined ? t('usage.splitPending') : undefined}
                  >
                    <span className="usage-row__metric-label">{t('usage.input')}</span>
                    <span className="usage-row__metric-value">
                      {inTokens === null || inTokens === undefined ? '—' : formatTokens(inTokens)}
                    </span>
                  </span>
                  <span
                    className="usage-row__metric"
                    title={outTokens === null || outTokens === undefined ? t('usage.splitPending') : undefined}
                  >
                    <span className="usage-row__metric-label">{t('usage.output')}</span>
                    <span className="usage-row__metric-value">
                      {outTokens === null || outTokens === undefined ? '—' : formatTokens(outTokens)}
                    </span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <footer className="usage-panel__foot">
          <span>{formatRangeSuffix(range, t)}</span>
          <span>
            {t('usage.total')} <strong>{formatTokens(totalAll)}</strong> {t('usage.tokensUnit')}
          </span>
        </footer>
      </section>

      {error && <div className="settings-warning usage-panel__error">{t('usage.readFailed', { error })}</div>}
    </div>
  );
}
