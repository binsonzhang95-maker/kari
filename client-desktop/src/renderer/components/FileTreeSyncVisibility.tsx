import {
  AlertTriangle,
  Cloud,
  CloudCog,
  CloudOff,
  CloudUpload,
  ShieldAlert,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  FileNode,
  FileTreeChildrenResult,
  FileTreePathAction,
  SyncDisposition,
} from '../../shared/types';
import { useI18n, type I18nKey } from '../i18n';

// ============================================================================
// File-tree sync visibility primitives (plan: 2026-05-25-file-tree-sync-visibility)
//
// Three exports the existing Sidebar TreeNode consumes via small,
// additive call sites:
//
//   - <SyncDispositionIcon node> — renders the cloud icon based on
//     node.syncDisposition. switch-exhaustive on the SyncDisposition
//     union (round-2 codex P2 #14 fixed conflict-falls-through to
//     "local only" via switch + TypeScript never-check).
//
//   - useFilePathActionRunner() — the IPC dispatcher hook with
//     would_dominate confirm dialog. Returns runAction(action, node)
//     + the in-flight confirm-replace dialog state.
//
//   - useLazyChildrenAugment() — opt-in hook that mirrors the
//     existing eager tree by calling listFileChildren for each
//     expanded directory and storing the per-node disposition. The
//     TreeNode reads from this Map before falling back to
//     node.syncDisposition. Lets us ship visibility immediately
//     without rewriting the entire tree to lazy loading first.
// ============================================================================

// --- Icon component ---------------------------------------------------------

export function SyncDispositionIcon({ node }: { node: FileNode }) {
  const { t } = useI18n();
  const disposition = node.syncDisposition || 'included';
  switch (disposition) {
    case 'included':
      return (
        <Cloud
          className="tree-sync-icon tree-sync-icon--included"
          size={13}
          aria-label={t('fileSync.icon.included')}
        />
      );
    case 'partially_included':
      return (
        <CloudCog
          className="tree-sync-icon tree-sync-icon--partial"
          size={13}
          aria-label={t('fileSync.icon.partial')}
        />
      );
    case 'pending_upload':
      return (
        <CloudUpload
          className="tree-sync-icon tree-sync-icon--pending"
          size={13}
          aria-label={t('fileSync.icon.pending')}
        />
      );
    case 'excluded':
      return (
        <CloudOff
          className="tree-sync-icon tree-sync-icon--excluded"
          size={13}
          aria-label={t('fileSync.icon.excluded')}
        />
      );
    case 'hard_ignored':
      return (
        <ShieldAlert
          className="tree-sync-icon tree-sync-icon--hard-ignored"
          size={13}
          aria-label={t('fileSync.icon.hardIgnored')}
        />
      );
    case 'cloud_only':
      return (
        <Cloud
          className="tree-sync-icon tree-sync-icon--cloud-only"
          size={13}
          aria-label={t('fileSync.icon.cloudOnly')}
        />
      );
    case 'local_only':
      return (
        <Cloud
          className="tree-sync-icon tree-sync-icon--local-only"
          size={13}
          aria-label={t('fileSync.icon.localOnly')}
        />
      );
    case 'conflict':
      return (
        <AlertTriangle
          className="tree-sync-icon tree-sync-icon--conflict"
          size={13}
          aria-label={t('fileSync.icon.conflict')}
        />
      );
    default: {
      // TypeScript never-check ensures every SyncDisposition variant
      // has an explicit case. Compile-time safety against a future
      // disposition being added without a matching badge.
      const _exhaustive: never = disposition;
      void _exhaustive;
      return null;
    }
  }
}

// --- Context menu -----------------------------------------------------------

const FILE_ACTION_ERROR_CODE_KEY: Record<string, I18nKey> = {
  no_workspace: 'fileAction.error.noWorkspace',
  not_activated: 'fileAction.error.notActivated',
  invalid_action: 'fileAction.error.invalidAction',
  hard_ignored: 'fileAction.error.hardIgnored',
  path_upload_in_flight: 'fileAction.error.pathUploadInFlight',
  empty_after_ignore: 'fileAction.error.emptyAfterIgnore',
  empty_only_hard_ignored: 'fileAction.error.emptyOnlyHardIgnored',
  override_already_committed: 'fileAction.error.overrideAlreadyCommitted',
  path_escapes_workspace: 'fileAction.error.pathEscapesWorkspace',
  COVERED_BY_ANCESTOR_OVERRIDE: 'fileAction.error.coveredByAncestor',
  DOMINATES_EXISTING_OVERRIDES: 'fileAction.error.dominatesExisting',
  INCOMPLETE_IDENTITY: 'fileAction.error.notActivated',
  HARD_IGNORE_IMMUTABLE: 'fileAction.error.hardIgnored',
  upload_pending_ft_task_6: 'fileAction.error.uploadPendingFtTask6',
};

type FilePathActionResult =
  | { ok: true; removed?: boolean; persisted?: boolean; code?: string }
  | {
      ok: false;
      code: string;
      error?: string;
      inFlightPath?: string;
      wouldDominate?: string[];
      interp?: Record<string, unknown>;
    };

// Pending confirm-replace dialog state. The renderer surfaces this
// when files:pathAction returns code='would_dominate' with the list
// the user must consent to. On confirm, the IPC is re-issued with
// replaceChildren:true + expectedDominated (round-1 codex #3 — pass
// the user-confirmed set so a stale would_dominate triggers a fresh
// dialog rather than over-broad consent).
export interface ConfirmReplaceState {
  newAnchor: string;
  newAnchorAbs: string;
  children: string[];
}

export function useFilePathActionRunner(opts?: { onActionApplied?: () => void }) {
  const { t } = useI18n();
  const onAppliedRef = useRef(opts && opts.onActionApplied);
  useEffect(() => {
    onAppliedRef.current = opts && opts.onActionApplied;
  }, [opts]);
  const [confirmReplace, setConfirmReplace] = useState<ConfirmReplaceState | null>(null);

  const dispatch = useCallback(
    async (
      action: FileTreePathAction,
      node: FileNode,
      extra?: { replaceChildren?: boolean; expectedDominated?: string[] },
    ): Promise<FilePathActionResult> => {
      try {
        return await window.kari.filePathAction({
          action,
          path: node.path,
          relPath: node.relPath,
          ...(extra ? extra : {}),
        });
      } catch (e) {
        // IPC reject — main process threw outside its own try/catch.
        // Surface as a generic failure; log for diagnostics.
        // eslint-disable-next-line no-console
        console.error('filePathAction IPC reject:', e);
        return { ok: false, code: 'ipc_reject', error: String(e) };
      }
    },
    [],
  );

  const surfaceError = useCallback(
    (result: Extract<FilePathActionResult, { ok: false }>) => {
      const key = FILE_ACTION_ERROR_CODE_KEY[result.code];
      const vars: Record<string, string | number> = {};
      if (result.inFlightPath) vars.inFlightPath = result.inFlightPath;
      if (result.interp) {
        for (const [k, v] of Object.entries(result.interp)) {
          if (typeof v === 'string' || typeof v === 'number') vars[k] = v;
        }
      }
      const message = key ? t(key, vars) : result.error || t('fileAction.failed');
      // Use the existing window.alert for now — Sidebar callers can
      // upgrade to a toast system in a follow-up commit without
      // touching this hook's contract.
      window.alert(message);
    },
    [t],
  );

  const runAction = useCallback(
    async (action: FileTreePathAction, node: FileNode) => {
      const result = await dispatch(action, node);
      if (result.ok) {
        // Some success paths still need user feedback — e.g. the
        // upload_pending_ft_task_6 placeholder. Show the i18n string
        // as info rather than swallowing.
        if (result.code && FILE_ACTION_ERROR_CODE_KEY[result.code]) {
          // eslint-disable-next-line no-alert
          window.alert(t(FILE_ACTION_ERROR_CODE_KEY[result.code]));
        }
        if (onAppliedRef.current) onAppliedRef.current();
        return;
      }
      if (result.code === 'would_dominate' && Array.isArray(result.wouldDominate)) {
        setConfirmReplace({
          newAnchor: node.relPath,
          newAnchorAbs: node.path,
          children: result.wouldDominate,
        });
        return;
      }
      surfaceError(result);
    },
    [dispatch, surfaceError, t],
  );

  const confirmReplaceAccept = useCallback(async () => {
    const state = confirmReplace;
    if (!state) return;
    // Replay the always_sync_path action with replaceChildren=true
    // and the exact list the user just confirmed (expectedDominated).
    // If the world changed in between, the main process re-runs
    // dryRun and replies with a fresh would_dominate — we re-set
    // the dialog with the new list and the user can re-confirm.
    const fakeNode: FileNode = {
      name: state.newAnchor.split('/').pop() || state.newAnchor,
      path: state.newAnchorAbs,
      relPath: state.newAnchor,
      type: 'directory',
      size: 0,
    };
    setConfirmReplace(null);
    const result = await dispatch('always_sync_path', fakeNode, {
      replaceChildren: true,
      expectedDominated: state.children,
    });
    if (result.ok) {
      if (result.code && FILE_ACTION_ERROR_CODE_KEY[result.code]) {
        window.alert(t(FILE_ACTION_ERROR_CODE_KEY[result.code]));
      }
      if (onAppliedRef.current) onAppliedRef.current();
      return;
    }
    if (result.code === 'would_dominate' && Array.isArray(result.wouldDominate)) {
      // Set diverged between confirm-show and confirm-click.
      setConfirmReplace({
        newAnchor: state.newAnchor,
        newAnchorAbs: state.newAnchorAbs,
        children: result.wouldDominate,
      });
      return;
    }
    surfaceError(result);
  }, [confirmReplace, dispatch, surfaceError, t]);

  const confirmReplaceCancel = useCallback(() => setConfirmReplace(null), []);

  return { runAction, confirmReplace, confirmReplaceAccept, confirmReplaceCancel };
}

// Context menu UI primitive. Renders the 3-action menu anchored at
// (x, y). Caller controls visibility via the surrounding state.
export function FileContextMenu({
  node,
  x,
  y,
  flipUp = false,
  onClose,
  onRun,
  clipboard,
  onCopy,
  onDelete,
  onPaste,
  onShowInFinder,
}: {
  node: FileNode;
  x: number;
  y: number;
  // When true, the menu renders ABOVE the (x,y) anchor instead of
  // below — caller sets this when the right-click was in the bottom
  // half of the viewport so the menu doesn't get clipped past the
  // window edge.
  flipUp?: boolean;
  onClose: () => void;
  onRun: (action: FileTreePathAction, node: FileNode) => void;
  // Right-click file ops (sub-commit: file-tree-actions). Optional —
  // older callers that don't pass these get the sync-only menu.
  clipboard?: { path: string; name: string; isDir: boolean } | null;
  onCopy?: (node: FileNode) => void;
  onDelete?: (node: FileNode) => void;
  onPaste?: (targetDir: FileNode) => void;
  onShowInFinder?: (node: FileNode) => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  // Dismiss on outside-click / Escape — keeps the menu modal-feeling
  // without a full overlay.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const isHardIgnored = node.syncDisposition === 'hard_ignored';
  // "Stop always-syncing" is shown only when the node carries its own
  // override (not just an inherited one — removing an inherited
  // override requires touching the ancestor that owns it).
  const showStopAlwaysSync = !!node.hasOverride;
  // "Force upload once" is INTENTIONALLY HIDDEN until FT-Task-6 wires
  // the actual path-scoped snapshot upload pipeline. The IPC currently
  // returns {ok:false, code:'upload_pending_ft_task_6'} for this
  // action — neither uploads nor persists — so surfacing the menu item
  // would actively mislead users (click → "Path is now in sync scope"
  // toast → nothing actually uploaded, no override persisted).
  // "Always sync this path" stays visible because IT persists the
  // override row and the next normal sync correctly picks the path up;
  // the placeholder message is accurate for that flow.
  // TODO(FT-Task-6): re-enable this branch once uploadProjectPathOverride
  // exists and the IPC returns an actual session id / upload progress.
  const SHOW_FORCE_UPLOAD_ONCE = false;
  // Anchor: when flipUp, render menu ABOVE the click position using
  // bottom instead of top. The number is converted from "y from top"
  // to "y from bottom" by subtracting from viewport height. Keep it
  // simple — caller already decided flipUp based on which half of
  // the viewport the click fell in.
  const anchorStyle = flipUp
    ? { left: x, bottom: window.innerHeight - y }
    : { left: x, top: y };
  return (
    <div
      ref={ref}
      className={'file-context-menu' + (flipUp ? ' file-context-menu--flip-up' : '')}
      style={anchorStyle}
      role="menu"
    >
      {SHOW_FORCE_UPLOAD_ONCE && (
        <button
          type="button"
          role="menuitem"
          disabled={isHardIgnored}
          title={isHardIgnored ? t('fileAction.hint.hardIgnored') : undefined}
          onClick={() => {
            onClose();
            onRun('force_upload_once', node);
          }}
        >
          {t('fileAction.forceUploadOnce')}
        </button>
      )}
      {!isHardIgnored && !node.hasOverride && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onRun('always_sync_path', node);
          }}
        >
          {t('fileAction.alwaysSync')}
        </button>
      )}
      {showStopAlwaysSync && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onRun('stop_always_syncing', node);
          }}
        >
          {t('fileAction.stopAlwaysSync')}
        </button>
      )}
      {/* If the node is hard-ignored AND has no override (the typical
          case for hard_ignored nodes), all three buttons are hidden.
          Render a passive hint so the menu isn't empty + confusing. */}
      {isHardIgnored && !showStopAlwaysSync && (
        <div className="file-context-menu__hint">
          {t('fileAction.hint.hardIgnored')}
        </div>
      )}
      {/* File-tree right-click actions: delete / copy / paste. The
          paste item is disabled when the clipboard is empty (mirrors
          OS-native context menus). Delete confirms in the caller; the
          caller is also responsible for triggering Upload propagation
          since the daemon's control-only mode blocks outbound auto-
          sync. Copy is renderer-state only — IPC paste does the
          actual fs.cp + upload. */}
      {(onCopy || onDelete || onPaste) && (
        <div className="file-context-menu__divider" aria-hidden="true" />
      )}
      {onCopy && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onCopy(node);
          }}
        >
          {t('fileAction.copy')}
        </button>
      )}
      {onPaste && (
        <button
          type="button"
          role="menuitem"
          disabled={!clipboard}
          title={clipboard ? undefined : t('fileAction.hint.pasteEmpty')}
          onClick={() => {
            if (!clipboard) return;
            onClose();
            onPaste(node);
          }}
        >
          {clipboard ? t('fileAction.pasteNamed').replace('{name}', clipboard.name) : t('fileAction.paste')}
        </button>
      )}
      {onShowInFinder && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onShowInFinder(node);
          }}
        >
          {t('fileAction.showInFinder')}
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          role="menuitem"
          className="file-context-menu__danger"
          onClick={() => {
            onClose();
            onDelete(node);
          }}
        >
          {t('fileAction.delete')}
        </button>
      )}
    </div>
  );
}

// Confirm-replace dialog primitive. Renders the would_dominate flow's
// confirm UI: title with count, body with anchor + list, two buttons.
export function ConfirmReplaceDialog({
  state,
  onAccept,
  onCancel,
}: {
  state: ConfirmReplaceState;
  onAccept: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="file-confirm-replace-overlay" role="dialog" aria-modal="true">
      <div className="file-confirm-replace">
        <h3>{t('fileAction.confirmReplace.title', { count: state.children.length })}</h3>
        <p>
          {t('fileAction.confirmReplace.body', {
            count: state.children.length,
            newAnchor: state.newAnchor,
          })}
        </p>
        <ul className="file-confirm-replace__list">
          {state.children.map((rel) => (
            <li key={rel}>{rel}</li>
          ))}
        </ul>
        <div className="file-confirm-replace__buttons">
          <button type="button" onClick={onCancel}>
            {t('fileAction.confirmReplace.cancel')}
          </button>
          <button type="button" className="is-primary" onClick={onAccept}>
            {t('fileAction.confirmReplace.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Lazy children augmentation hook ---------------------------------------
//
// Bridge for the existing eager tree: on mount and on every directory
// expansion, fetch listFileChildren for that path and store the
// per-node SyncDisposition in a Map keyed by absolute path. TreeNode
// reads from this map first; falls back to node.syncDisposition; falls
// back to 'included' default (handled by SyncDispositionIcon).
//
// Also runs the parent-badge patcher: if a child listing reveals mixed
// children (some included, some excluded / hard_ignored), the parent
// directory's disposition is patched from its base to
// 'partially_included' (round-1 codex P1 #3 — was documentation-only).

export interface NodeAugment {
  syncDisposition: SyncDisposition;
  syncReason?: string;
  hasOverride?: boolean;
  overrideInheritedFrom?: string;
}

export function useLazyChildrenAugment(workspaceRoot: string | undefined) {
  const [augments, setAugments] = useState<Map<string, NodeAugment>>(new Map());
  // Lazy-tree expansion: scanWorkspace returns directories with empty
  // children. When a directory is expanded the FileNode[] from
  // listFileChildren goes here, keyed by absolute path. TreeNode reads
  // this Map (via augmentNode) so it can render fetched children
  // without us having to mutate the original tree state.
  const [fetchedChildren, setFetchedChildren] = useState<Map<string, FileNode[]>>(new Map());
  // Per-path generation counter (round-1 codex #2). Concurrent expansion
  // of dir A and dir B used to race on a single global counter — A's
  // response was discarded because B's bump rolled the counter forward.
  // Now each path tracks its own generation; only the LATEST request
  // for a given path wins, but parallel requests for DIFFERENT paths
  // are independent.
  const pathGenRef = useRef<Map<string, number>>(new Map());

  const reset = useCallback(() => {
    setAugments(new Map());
    setFetchedChildren(new Map());
    pathGenRef.current = new Map();
  }, []);

  // Refresh whenever the workspace root changes (project switch).
  useEffect(() => {
    reset();
  }, [workspaceRoot, reset]);

  const fetchAndApply = useCallback(
    async (dirPath: string) => {
      if (!workspaceRoot) return;
      const prev = pathGenRef.current.get(dirPath) || 0;
      const myGen = prev + 1;
      pathGenRef.current.set(dirPath, myGen);
      let result: FileTreeChildrenResult;
      try {
        result = await window.kari.listFileChildren({ dirPath });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('listFileChildren failed for', dirPath, e);
        return;
      }
      if (pathGenRef.current.get(dirPath) !== myGen) return; // stale for THIS path
      // Stash the fetched children so TreeNode can render them in place
      // of the empty `children: []` returned by the shallow scanWorkspace.
      setFetchedChildren((prev) => {
        const next = new Map(prev);
        next.set(dirPath, result.nodes);
        return next;
      });
      setAugments((prevMap) => {
        const next = new Map(prevMap);
        // Per-child augment from the response.
        for (const child of result.nodes) {
          next.set(child.path, {
            syncDisposition: child.syncDisposition || 'included',
            syncReason: child.syncReason,
            hasOverride: !!child.hasOverride,
            overrideInheritedFrom: child.overrideInheritedFrom,
          });
        }
        // Parent badge patcher: drives the directory badge from the
        // mix of its IMMEDIATE children. Round-1 codex #1 hardened the
        // patcher to ALSO demote: if a previously-mixed dir now has
        // uniformly-included children, we must clear the stale
        // 'partially_included' augment or the yellow CloudCog gets
        // stuck on the parent forever.
        const dispositions = new Set(result.nodes.map((n) => n.syncDisposition || 'included'));
        const hasIncluded =
          dispositions.has('included')
          || dispositions.has('partially_included')
          || dispositions.has('pending_upload');
        const hasExcluded = dispositions.has('excluded') || dispositions.has('hard_ignored');
        const prior = next.get(dirPath);
        const priorDisposition = prior?.syncDisposition;
        if (hasIncluded && hasExcluded) {
          // Mixed subtree → promote to partially_included unless the
          // parent is already in a stronger state (pending / excluded /
          // hard_ignored shouldn't be demoted to partial).
          if (
            priorDisposition !== 'partially_included'
            && priorDisposition !== 'pending_upload'
            && priorDisposition !== 'excluded'
            && priorDisposition !== 'hard_ignored'
          ) {
            next.set(dirPath, {
              ...(prior || { syncDisposition: 'included' }),
              syncDisposition: 'partially_included',
              syncReason: 'mixed-subtree',
            });
          }
        } else if (priorDisposition === 'partially_included' && prior?.syncReason === 'mixed-subtree') {
          // Mix resolved one way or the other. Two cases (round-2
          // codex — round-1's blanket delete was a data-safety
          // regression for the all-excluded case: deletion fell
          // back to the raw FileNode's eager-load disposition,
          // which is usually 'included' green even for now-fully-
          // excluded dirs).
          if (hasIncluded && !hasExcluded) {
            // All children included → safe to drop the patcher's
            // stale 'partially_included' write; raw FileNode
            // disposition takes over (typically 'included').
            next.delete(dirPath);
          } else if (!hasIncluded && hasExcluded) {
            // All children excluded → write 'excluded' explicitly
            // so the dir stops painting yellow without falling back
            // to a misleading-green raw disposition.
            next.set(dirPath, {
              syncDisposition: 'excluded',
              syncReason: 'mixed-subtree-resolved-excluded',
            });
          }
          // hasIncluded && hasExcluded is handled by the if-branch
          // above; !hasIncluded && !hasExcluded means empty dir
          // listing, leave the prior augment alone.
        }
        return next;
      });
    },
    [workspaceRoot],
  );

  // On mount / when the workspace root changes, fetch the root listing
  // so top-level nodes have augments without requiring a click.
  useEffect(() => {
    if (workspaceRoot) {
      void fetchAndApply(workspaceRoot);
    }
  }, [workspaceRoot, fetchAndApply]);

  return { augments, fetchedChildren, fetchAndApply, reset };
}

// Apply augment Map to a FileNode without mutating the original.
// TreeNode wraps each node through this so the icon component sees
// augmented disposition without us having to thread the Map through
// every call site.
//
// Lazy-tree contract: if the node is a directory with empty `children`
// (the shape scanWorkspace now returns for every dir below the root),
// substitute the children fetched by listFileChildren when available.
// Directories that have never been expanded keep `children: []`, which
// the `<details>` element happily renders as a closed disclosure.
export function augmentNode(
  node: FileNode,
  augments: Map<string, NodeAugment>,
  fetchedChildren?: Map<string, FileNode[]>,
): FileNode {
  const a = augments.get(node.path);
  let children = node.children;
  if (
    fetchedChildren
    && node.type === 'directory'
    && (!children || children.length === 0)
  ) {
    const fetched = fetchedChildren.get(node.path);
    if (fetched && fetched.length > 0) {
      children = fetched;
    }
  }
  if (!a && children === node.children) return node;
  return {
    ...node,
    children,
    syncDisposition: a ? a.syncDisposition : node.syncDisposition,
    syncReason: a ? (a.syncReason ?? node.syncReason) : node.syncReason,
    hasOverride: a ? (a.hasOverride ?? node.hasOverride) : node.hasOverride,
    overrideInheritedFrom: a ? (a.overrideInheritedFrom ?? node.overrideInheritedFrom) : node.overrideInheritedFrom,
  };
}
