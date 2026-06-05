import type { ProjectListResult, SyncthingState } from './types';

export function projectsNeedSyncRefresh(projectList: ProjectListResult | null | undefined): boolean;
export function syncthingEventsNeedProjectRefresh(syncthingState: SyncthingState | null | undefined): boolean;
