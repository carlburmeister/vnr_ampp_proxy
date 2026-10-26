import type { ClientPermissions } from '../../services/clientPermissionsApi';

export function comparablePermissions(permissions: ClientPermissions): string {
  return JSON.stringify({
    workloadIds: [...permissions.workloadIds].sort((a, b) => a - b),
    dashboardIds: [...permissions.dashboardIds].sort((a, b) => a - b),
    deniedChildWorkloadIds: permissions.deniedChildWorkloadIds.map((id) => id.toLowerCase()).sort(),
    gvuiLayoutIds: permissions.gvuiLayoutIds === undefined ? undefined : [...permissions.gvuiLayoutIds].sort((a, b) => a - b),
  });
}

export function permissionSavePayload(permissions: ClientPermissions, gvuiEnabled: boolean): ClientPermissions {
  const changes = { ...permissions };
  // An older/disabled backend must receive omission, not an explicit clearing.
  if (!gvuiEnabled) delete changes.gvuiLayoutIds;
  return changes;
}
