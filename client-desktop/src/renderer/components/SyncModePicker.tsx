import { useCallback, useEffect, useState } from 'react';
import { useI18n, type I18nKey } from '../i18n';

// Sync mode picker (Phase B B9).
//
// Two scopes:
//   - global default: applies to every project that doesn't override
//   - per-project: overrides the global default; can be cleared
//     (radio "Inherit default" maps to clearing the project row).
//
// Modes:
//   - lightweight: Kari-managed denylist (node_modules, build, dist,
//     etc.) PLUS .kariignore. Recommended default for most projects.
//   - full: only .kariignore + hard-ignore. Use when the user wants
//     every file (e.g. tutorials, repos with hand-edited build output
//     that must travel with source).

type SyncMode = 'lightweight' | 'full';

const MODE_LABEL: Record<SyncMode, I18nKey> = {
  lightweight: 'syncMode.lightweight',
  full: 'syncMode.full',
};
const MODE_DESC: Record<SyncMode, I18nKey> = {
  lightweight: 'syncMode.lightweight.desc',
  full: 'syncMode.full.desc',
};

export function SyncModePicker({ scope }: { scope: 'global' | 'project' }) {
  const { t } = useI18n();
  // initialLoading is only true on first mount; subsequent refreshes
  // (after save) don't blank the UI to the 'Loading…' placeholder
  // (round-1 codex #3 — every option click was hiding the radio
  // list during the round trip + losing which option the user just
  // selected mid-render).
  //
  // hasLoadedOnce tracks whether we ever got real data from main —
  // round-2 self-review: if the FIRST getSyncMode throws, initialLoading
  // clears in finally but the picker would render with stale state
  // defaults (lightweight + null projectMode), misleading the user
  // into thinking those defaults reflect actual store state.
  const [initialLoading, setInitialLoading] = useState(true);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [defaultMode, setDefaultMode] = useState<SyncMode>('lightweight');
  const [projectMode, setProjectMode] = useState<SyncMode | null>(null);
  const [effectiveMode, setEffectiveMode] = useState<SyncMode | null>(null);
  const [identityComplete, setIdentityComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const result = await window.kari.getSyncMode();
      if (!result.ok) {
        setError(result.error || result.code);
        return;
      }
      setDefaultMode(result.defaultMode);
      setProjectMode(result.projectMode);
      setEffectiveMode(result.effectiveMode);
      setIdentityComplete(result.identityComplete);
      setHasLoadedOnce(true);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await refresh();
      } finally {
        setInitialLoading(false);
      }
    })();
  }, [refresh]);

  const handleGlobalChange = useCallback(
    async (mode: SyncMode) => {
      setSaving(true);
      try {
        const result = await window.kari.setGlobalSyncMode(mode);
        if (!result.ok) {
          setError(result.error || result.code);
          return;
        }
        await refresh();
      } finally {
        setSaving(false);
      }
    },
    [refresh],
  );

  const handleProjectChange = useCallback(
    async (mode: SyncMode | null) => {
      setSaving(true);
      try {
        const result = await window.kari.setProjectSyncMode(mode);
        if (!result.ok) {
          setError(result.error || result.code);
          return;
        }
        await refresh();
      } finally {
        setSaving(false);
      }
    },
    [refresh],
  );

  if (initialLoading) {
    return <div className="sync-mode-picker sync-mode-picker--loading">{t('syncMode.loading')}</div>;
  }
  // If the initial fetch failed (hasLoadedOnce never flipped true), do
  // NOT render the option list — its radio defaults ('lightweight'
  // selected, null projectMode) would misleadingly look like actual
  // store state. Surface the error + a retry button instead.
  if (!hasLoadedOnce) {
    return (
      <div className="sync-mode-picker">
        <div className="sync-mode-picker__error">{error || t('syncMode.loading')}</div>
        <button
          type="button"
          className="sync-mode-picker__retry"
          onClick={() => void refresh()}
        >
          {t('common.refresh')}
        </button>
      </div>
    );
  }

  if (scope === 'global') {
    return (
      <div className="sync-mode-picker">
        <div className="sync-mode-picker__header">
          <h4>{t('syncMode.globalTitle')}</h4>
          <p className="sync-mode-picker__desc">{t('syncMode.globalDesc')}</p>
        </div>
        {error && <div className="sync-mode-picker__error">{error}</div>}
        <div className="sync-mode-picker__options">
          {(['lightweight', 'full'] as const).map((mode) => (
            <label
              key={mode}
              className={
                'sync-mode-picker__option'
                + (defaultMode === mode ? ' is-selected' : '')
              }
            >
              <input
                type="radio"
                name="syncMode-global"
                value={mode}
                checked={defaultMode === mode}
                disabled={saving}
                onChange={() => handleGlobalChange(mode)}
              />
              <div className="sync-mode-picker__option-text">
                <div className="sync-mode-picker__option-label">{t(MODE_LABEL[mode])}</div>
                <div className="sync-mode-picker__option-desc">{t(MODE_DESC[mode])}</div>
              </div>
            </label>
          ))}
        </div>
      </div>
    );
  }

  // scope === 'project'
  if (!identityComplete) {
    return (
      <div className="sync-mode-picker sync-mode-picker--no-workspace">
        {t('syncMode.noWorkspace')}
      </div>
    );
  }
  const inheritedLabel = t('syncMode.inherit', { mode: t(MODE_LABEL[defaultMode]) });
  return (
    <div className="sync-mode-picker">
      <div className="sync-mode-picker__header">
        <h4>{t('syncMode.projectTitle')}</h4>
        <p className="sync-mode-picker__desc">
          {effectiveMode && t('syncMode.projectDesc', { effective: t(MODE_LABEL[effectiveMode]) })}
        </p>
      </div>
      {error && <div className="sync-mode-picker__error">{error}</div>}
      <div className="sync-mode-picker__options">
        {/* Inherit default — clears the project override. */}
        <label
          className={
            'sync-mode-picker__option'
            + (projectMode === null ? ' is-selected' : '')
          }
        >
          <input
            type="radio"
            name="syncMode-project"
            value="__inherit__"
            checked={projectMode === null}
            disabled={saving}
            onChange={() => handleProjectChange(null)}
          />
          <div className="sync-mode-picker__option-text">
            <div className="sync-mode-picker__option-label">{inheritedLabel}</div>
            <div className="sync-mode-picker__option-desc">{t('syncMode.inheritDesc')}</div>
          </div>
        </label>
        {/* Per-project override options. */}
        {(['lightweight', 'full'] as const).map((mode) => (
          <label
            key={mode}
            className={
              'sync-mode-picker__option'
              + (projectMode === mode ? ' is-selected' : '')
            }
          >
            <input
              type="radio"
              name="syncMode-project"
              value={mode}
              checked={projectMode === mode}
              disabled={saving}
              onChange={() => handleProjectChange(mode)}
            />
            <div className="sync-mode-picker__option-text">
              <div className="sync-mode-picker__option-label">{t(MODE_LABEL[mode])}</div>
              <div className="sync-mode-picker__option-desc">{t(MODE_DESC[mode])}</div>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}
