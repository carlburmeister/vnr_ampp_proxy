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
) {
  const effective = new Set(
    (session.amppAllowedWorkloadIds ?? []).map((id) => id.toLowerCase()),
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
  const components: JsonObject[] = [],
    workloadIds: string[] = [];
  for (const raw of record.layout.components as unknown[]) {
    const component = object(raw);
    if (component?.type !== 'web' || typeof component.url !== 'string') return;
    try {
      const url = new URL(component.url);
      const match = url.pathname.match(
        /^\/app\/wrapper\/embedded\/single\/([^/]+)\/([^/]+)\/?$/i,
      );
      if (
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !match ||
        !UUID.test(match[2])
      )
        return;
      const id = match[2].toLowerCase(),
        pkg = packages.get(id);
      if (!pkg) continue;
      if (pkg !== match[1]) return;
      components.push(component);
      workloadIds.push(id);
    } catch {
      return;
    }
  }
  if (!components.length) return;
  return {
    item: {
      ...record.item,
      configuration: {
        ...record.configuration,
        value: JSON.stringify({ ...record.layout, components }),
      },
    },
    workloadIds: [...new Set(workloadIds)].sort(),
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
