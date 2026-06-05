import type { DaemonStatus, RuntimeStatus, SavedConfig } from '../shared/types';
import { translate, type AppLanguage } from './i18n';

export type ReverseAction = 'start' | 'refresh' | 'stop' | 'copy';

export function reverseActionBlockedReason(
  action: ReverseAction,
  config: SavedConfig,
  daemon: DaemonStatus,
  runtime: RuntimeStatus | null,
  language: AppLanguage = 'zh-CN'
): string {
  if (action === 'copy') {
    return frpConfigured(config) ? '' : translate(language, 'reverse.noConfig');
  }
  if (daemon.health !== 'online') {
    return translate(language, 'reverse.daemonOffline');
  }
  if (action === 'stop') {
    return daemon.frpState && daemon.frpState !== 'disabled' ? '' : translate(language, 'reverse.notRunning');
  }
  if (!runtime?.frpcPath) {
    return translate(language, 'reverse.frpcMissing');
  }
  if (!config.managementUrl || !config.hasActivationCode) {
    return translate(language, 'reverse.missingMgmt');
  }
  if (!config.workspaceId || !config.clientId) {
    return translate(language, 'reverse.workspaceNotReady');
  }
  if (!daemon.sshAvailable) {
    return sshUnavailableMessage(daemon, language);
  }
  return '';
}

export function reverseReadinessMessage(config: SavedConfig, daemon: DaemonStatus, runtime: RuntimeStatus | null, language: AppLanguage = 'zh-CN'): string {
  return reverseActionBlockedReason('start', config, daemon, runtime, language) || translate(language, 'reverse.ready');
}

export function frpConfigured(config: SavedConfig): boolean {
  const frp = config.frp as Record<string, unknown> | null | undefined;
  return Boolean(frp && frp.enabled !== false && frp.server_addr && frp.remote_port);
}

function sshUnavailableMessage(daemon: DaemonStatus, language: AppLanguage): string {
  const platform = String(daemon.sshPlatform || '').toLowerCase();
  if (platform === 'darwin' || platform.startsWith('darwin')) {
    return translate(language, 'reverse.sshMac');
  }
  if (platform === 'win32' || platform === 'windows') {
    return daemon.sshInstallSupported
      ? translate(language, 'reverse.sshWindowsInstall')
      : translate(language, 'reverse.sshWindows');
  }
  if (platform === 'linux') {
    return translate(language, 'reverse.sshLinux');
  }
  if (daemon.sshState === 'unknown') {
    return translate(language, 'reverse.sshUnknown');
  }
  return translate(language, 'reverse.sshUnavailable');
}
