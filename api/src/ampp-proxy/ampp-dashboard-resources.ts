import type { SessionData } from 'express-session';

// A fabric-less Matrix name in a dashboard applies only to ICE entities.
export const ICE_DASHBOARD_REFERENCE = '__ice__';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Dashboard resource grants are read-only and limited to the current proxy scope.
export function getDashboardResourceIds(
  session: SessionData,
  workloadId: string,
  resource: 'node' | 'fabric',
): Set<string> {
  const normalizedWorkloadId = workloadId.toLowerCase();
  const scope = session.amppDashboardMatrixAccess?.[normalizedWorkloadId];
  const allowedDashboardIds = new Set(
    (session.allowedDashboardIds ?? []).map((id) => id.toLowerCase()),
  );
  const ids = new Set<string>();

  for (const dashboard of session.allowedDashboards ?? []) {
    const dashboardId = dashboard.id.toLowerCase();
    if (
      !allowedDashboardIds.has(dashboardId) ||
      (dashboard.associatedWorkloadId !== null &&
        dashboard.associatedWorkloadId.toLowerCase() !== normalizedWorkloadId)
    ) {
      continue;
    }

    const references = scope?.dashboards?.[dashboardId];
    if (!references) {
      continue;
    }

    const values =
      resource === 'fabric'
        ? Object.keys(references)
        : scope?.dashboardNodeIds?.[dashboardId] ?? [];
    for (const id of values) {
      if (UUID_PATTERN.test(id)) {
        ids.add(id.toLowerCase());
      }
    }
  }

  return ids;
}
