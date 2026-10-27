import type { SessionData } from 'express-session';

export const GVUI_CATALOG_PATH =
  '/configuration/api/v1/configurations/startswith/gv-ui-l';
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type JsonObject = Record<string, unknown>;
export type GvuiConfiguration = {
  id: string;
  item: JsonObject;
  configuration: JsonObject;
  layout: JsonObject;
};

export function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function configuration(value: unknown): GvuiConfiguration | undefined {
  const item = object(value);
  const config = object(item?.configuration);
  const key = typeof config?.key === 'string' ? config.key.toLowerCase() : '';
  const id = key.startsWith('gv-ui-l/') ? key.slice(8) : '';
  if (!item || !config || !UUID.test(id) || typeof config.value !== 'string')
    return;
  try {
    const layout = object(JSON.parse(config.value));
    if (
      !layout ||
      (layout.id !== undefined &&
        (typeof layout.id !== 'string' || layout.id.toLowerCase() !== id)) ||
      !Array.isArray(layout.components) ||
      layout.components.length > 1000
    )
      return;
    return { id, item, configuration: config, layout };
  } catch {
    return;
  }
}

export function permittedComponents(
  record: GvuiConfiguration,
  session: SessionData,
  origin: string,
  proxyOrigin?: string,
) {
  const effective = new Set(
    (session.amppAllowedWorkloadIds ?? []).map((id) => id.toLowerCase()),
  );
  const workloads = (session.allowedWorkloads ?? []).flatMap((workload) => [
    workload,
    ...(workload.child_workloads ?? []),
  ]);
  const contexts = new Set(
    workloads
      .map((workload) => workload.id.toLowerCase())
      .filter((id) => effective.has(id)),
  );
  const dashboardIds = new Set(
    (session.allowedDashboardIds ?? []).map((id) => id.toLowerCase()),
  );
  const dashboards = new Map(
    (session.allowedDashboards ?? [])
      .filter(
        (dashboard) =>
          dashboard.pageType === 'ampp-ui' &&
          dashboardIds.has(dashboard.id.toLowerCase()),
      )
      .map((dashboard) => [dashboard.id.toLowerCase(), dashboard]),
  );
  const packages = new Map(
    (session.allowedWorkloads ?? []).flatMap((workload) =>
      [workload, ...(workload.child_workloads ?? [])].flatMap((item) =>
        effective.has(item.id.toLowerCase()) && item.packageName
          ? [[item.id.toLowerCase(), item.packageName] as const]
          : [],
      ),
    ),
  );
  const components: {
      component: JsonObject;
      dashboardId?: string;
      workloadId?: string;
    }[] = [],
    workloadIds: string[] = [];
  for (const raw of record.layout.components as unknown[]) {
    const component = object(raw);
    if (component?.type !== 'web' || typeof component.url !== 'string') return;
    try {
      const url = new URL(component.url);
      const native = url.pathname.match(
        /^\/app\/wrapper\/embedded\/single\/([^/]+)\/([^/]+)\/?$/i,
      );
      const dashboard = url.pathname.match(
        /^\/cluster\/systemdashboard\/dashboard\/([^/]+)\/?$/i,
      );
      if (
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (!native && !dashboard)
      )
        return;
      if (dashboard) {
        if (!UUID.test(dashboard[1])) return;
        const id = dashboard[1].toLowerCase(),
          grant = dashboards.get(id);
        if (!grant) continue;
        const workloadId = grant.associatedWorkloadId?.toLowerCase();
        if (workloadId && !contexts.has(workloadId)) continue;
        components.push({ component, dashboardId: id, workloadId });
        if (workloadId) workloadIds.push(workloadId);
        continue;
      }
      if (!native || !UUID.test(native[2])) return;
      const id = native[2].toLowerCase(),
        pkg = packages.get(id);
      if (!pkg) continue;
      if (pkg !== native[1]) return;
      components.push({ component });
      workloadIds.push(id);
    } catch {
      return;
    }
  }
  const permittedContexts = [...new Set(workloadIds)].sort();
  if (!components.length || !permittedContexts.length) return;
  // Dashboard frames use the ordinary dashboard proxy, including its existing
  // configuration, Matrix, control and callback checks. A layout adds no grants.
  const selected = components.map(({ component, dashboardId, workloadId }) => {
    if (!dashboardId) return component;
    const path = `/api/ampp-proxy/ui/${encodeURIComponent(workloadId ?? permittedContexts[0])}/cluster/systemdashboard/dashboard/${dashboardId}`;
    return {
      ...component,
      url: proxyOrigin ? new URL(path, proxyOrigin).toString() : path,
    };
  });
  return {
    item: {
      ...record.item,
      configuration: {
        ...record.configuration,
        value: JSON.stringify({ ...record.layout, components: selected }),
      },
    },
    workloadIds: permittedContexts,
  };
}

export function replaceJson<
  T extends {
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  },
>(response: T, value: unknown): T {
  const body = Buffer.from(JSON.stringify(value));
  const headers: Record<string, string | string[] | undefined> = {
    ...response.headers,
    'content-length': String(body.length),
    'cache-control': 'no-store',
  };
  delete headers.etag;
  delete headers['last-modified'];
  return { ...response, body, headers };
}
