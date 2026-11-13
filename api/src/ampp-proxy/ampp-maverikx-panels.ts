import { BadGatewayException, ForbiddenException } from '@nestjs/common';
import type { SessionData } from 'express-session';

import type { AmppCookieHttpResponse } from './ampp-cookie-http.service';

const PANEL_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CATALOG = '/ampp/control/api/v1/panel/panels';

export function isMaverikxContext(session: SessionData, id: string): boolean {
  const normalized = id.toLowerCase();
  if (
    session.amppAllowedWorkloadIds &&
    !session.amppAllowedWorkloadIds.some(
      (allowed) => allowed.toLowerCase() === normalized,
    )
  )
    return false;
  const workload = (session.allowedWorkloads ?? [])
    .flatMap((root) => [root, ...(root.child_workloads ?? [])])
    .find((item) => item.id.toLowerCase() === normalized);
  return Boolean(
    workload &&
    (workload.packageName
      ? workload.packageName.toLowerCase() === 'gv.ampp.apps.prodswitcher'
      : workload.applicationName?.replace(/\s/g, '').toLowerCase() ===
        'maverikx'),
  );
}

export function panelUiTarget(
  path: string,
): { panelId: string; workloadId: string } | undefined {
  try {
    path = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  const match = path.match(
    /^\/ampp\/control\/embedded\/panelControl\/([^/]+)\/workload\/([0-9a-f-]{36})\/?$/i,
  );
  if (!match || !PANEL_ID.test(match[1]) || !UUID.test(match[2]))
    return undefined;
  return { panelId: match[1], workloadId: match[2] };
}

export function isPanelAllowed(
  session: SessionData,
  workloadId: string,
  panelId: string,
): boolean {
  return (
    isMaverikxContext(session, workloadId) &&
    (session.amppPanelIdsByWorkload?.[workloadId.toLowerCase()] ?? []).includes(
      panelId.toLowerCase(),
    )
  );
}

// A reusable panel need not contain a workload reference. Explicit targets,
// including serialized form/configuration data, must stay within control grants.
export function panelReferencesAllowed(
  session: SessionData,
  value: unknown,
): boolean {
  const allowed = new Set(
    (
      session.amppAllowedWorkloadIds ??
      (session.allowedWorkloads ?? []).flatMap((root) => [
        root.id,
        ...(root.child_workloads ?? []).map((child) => child.id),
      ])
    ).map((id) => id.toLowerCase()),
  );
  const inspect = (item: unknown, depth = 0): boolean => {
    if (depth > 32) return false;
    if (typeof item === 'string') {
      for (const match of item.matchAll(
        /(?:gv\.(?:ampp\.(?:control|workload|apps\.[^.]+)|cluster\.workload)\.|\/(?:workload|application)\/)([0-9a-f-]{36})(?=[./?"\s]|$)/gi,
      ))
        if (!allowed.has(match[1].toLowerCase())) return false;
      if (
        item.trimStart().startsWith('[') ||
        item.trimStart().startsWith('{')
      ) {
        try {
          return inspect(JSON.parse(item), depth + 1);
        } catch {
          /* Literal labels, CSS and script text are not serialized JSON. */
        }
      }
      return true;
    }
    if (Array.isArray(item))
      return item.every((child) => inspect(child, depth + 1));
    const object = asObject(item);
    if (!object) return true;
    return Object.entries(object).every(([key, child]) => {
      if (
        /^(?:workload|workload_?id)$/i.test(key) &&
        typeof child === 'string' &&
        UUID.test(child) &&
        !allowed.has(child.toLowerCase())
      )
        return false;
      if (/^workload$/i.test(key)) {
        const id = asObject(child)?.id;
        if (
          typeof id === 'string' &&
          UUID.test(id) &&
          !allowed.has(id.toLowerCase())
        )
          return false;
      }
      if (
        /^workloads$/i.test(key) &&
        Array.isArray(child) &&
        child.some(
          (id) =>
            typeof id === 'string' &&
            UUID.test(id) &&
            !allowed.has(id.toLowerCase()),
        )
      )
        return false;
      return inspect(child, depth + 1);
    });
  };
  return inspect(value);
}

export function isPanelCommit(
  session: SessionData,
  workloadId: string,
  body?: Buffer,
): boolean {
  if (!isMaverikxContext(session, workloadId)) return false;
  let data: Record<string, unknown> | undefined;
  try {
    data = asObject(JSON.parse(body?.toString('utf8') ?? ''));
  } catch {
    return false;
  }
  if (
    !data ||
    typeof data.workload !== 'string' ||
    data.workload.toLowerCase() !== workloadId.toLowerCase() ||
    typeof data.command !== 'string' ||
    !/^[a-z][a-z0-9_-]{0,127}$/i.test(data.command) ||
    typeof data.reconKey !== 'string' ||
    !data.reconKey ||
    data.reconKey.length > 256 ||
    /^dashboard-/i.test(data.reconKey) ||
    !Object.keys(data).every((key) =>
      [
        'application',
        'command',
        'workload',
        'reconKey',
        'formData',
        'FormData',
        'version',
      ].includes(key),
    ) ||
    !(
      data.application === 'MaverikX' ||
      (data.application === 'any' && data.command === 'getstate')
    )
  )
    return false;
  if ('formData' in data && 'FormData' in data) return false;
  const form = data.formData ?? data.FormData;
  if (typeof form !== 'string') return false;
  try {
    return (
      Boolean(asObject(JSON.parse(form))) &&
      panelReferencesAllowed(session, data)
    );
  } catch {
    return false;
  }
}

export function isPanelMailboxId(
  session: SessionData,
  workloadId: string,
  mailboxId: string,
): boolean {
  if (!isMaverikxContext(session, workloadId)) return false;
  const match = mailboxId.match(
    /^ts-(?:app-([0-9a-f-]{36})|(?:api\.ampp-proxy\.ui\.([0-9a-f-]{36})\.)?ampp\.control)--[0-9a-f-]{36}$/i,
  );
  return Boolean(
    match &&
    ((!match[1] && !match[2]) ||
      (match[1] ?? match[2]).toLowerCase() === workloadId.toLowerCase()),
  );
}

export function isPanelNotificationPublish(
  session: SessionData,
  workloadId: string,
  body?: Buffer,
): boolean {
  if (!isMaverikxContext(session, workloadId)) return false;
  try {
    const data = asObject(JSON.parse(body?.toString('utf8') ?? ''));
    if (
      !data ||
      typeof data.Source !== 'string' ||
      typeof data.topic !== 'string'
    )
      return false;
    const prefix = `/api/ampp-proxy/ui/${workloadId}`;
    const source = data.Source.startsWith(prefix)
      ? data.Source.slice(prefix.length)
      : data.Source;
    const panel = panelUiTarget(source);
    if (
      source !== '/ampp/control' &&
      (!panel ||
        panel.workloadId.toLowerCase() !== workloadId.toLowerCase() ||
        !isPanelAllowed(session, workloadId, panel.panelId))
    )
      return false;
    const topic = data.topic.match(
      /^gv\.ampp\.control\.([0-9a-f-]{36})\.[a-z][a-z0-9_-]{0,127}$/i,
    );
    const content = asObject(
      typeof data.content === 'string'
        ? JSON.parse(data.content)
        : data.content,
    );
    if (
      !topic ||
      topic[1].toLowerCase() !== workloadId.toLowerCase() ||
      !content
    )
      return false;
    const key = content.Key ?? content.key;
    return (
      typeof key === 'string' &&
      key.length > 0 &&
      key.length <= 256 &&
      Boolean(asObject(content.Payload ?? content.payload)) &&
      Object.keys(content).length === 2 &&
      panelReferencesAllowed(session, content)
    );
  } catch {
    return false;
  }
}

export function filterMaverikxPanelResponse(
  session: SessionData,
  workloadId: string,
  pathname: string,
  response: AmppCookieHttpResponse,
): AmppCookieHttpResponse | undefined {
  if (!isMaverikxContext(session, workloadId)) return undefined;
  const definition = pathname.match(
    /^\/ampp\/control\/api\/v1\/panel\/([^/]+)$/i,
  );
  const references =
    pathname === '/ampp/control/api/v1/control/application/references';
  if (pathname !== CATALOG && !definition && !references) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body.toString('utf8'));
  } catch {
    throw new BadGatewayException('AMPP panel response is not valid JSON');
  }
  let filtered: unknown;
  if (references) {
    if (!Array.isArray(parsed))
      throw new BadGatewayException(
        'AMPP application references are not an array',
      );
    // Existing dashboards use this catalogue for other authorized app widgets.
    // Preserve that established contract; the new standalone workload grant
    // needs only MaverikX's application reference.
    const dashboardScope = (session.allowedDashboards ?? []).some(
      (dashboard) =>
        dashboard.associatedWorkloadId === null ||
        dashboard.associatedWorkloadId.toLowerCase() ===
          workloadId.toLowerCase(),
    );
    filtered = dashboardScope
      ? parsed
      : parsed.filter((item) => asObject(item)?.name === 'MaverikX');
  } else if (pathname === CATALOG) {
    const catalog = asObject(parsed);
    const panels = asObject(catalog?.panels);
    if (!panels)
      throw new BadGatewayException(
        'AMPP panel response is missing its panels dictionary',
      );
    const entries = Object.entries(panels).filter(([, item]) =>
      compatiblePanel(session, item),
    );
    const ids = entries.map(([, item]) =>
      (item as { id: string }).id.toLowerCase(),
    );
    (session.amppPanelIdsByWorkload ??= {})[workloadId.toLowerCase()] = ids;
    filtered = { ...catalog, panels: Object.fromEntries(entries) };
  } else {
    const record = asObject(parsed);
    const panel = asObject(record?.panel) ?? record;
    if (
      !definition ||
      !isPanelAllowed(session, workloadId, definition[1]) ||
      !compatiblePanel(session, panel) ||
      typeof panel?.id !== 'string' ||
      panel.id.toLowerCase() !== definition[1].toLowerCase() ||
      !panelReferencesAllowed(session, parsed)
    ) {
      throw new ForbiddenException(
        'AMPP panel is not allowed for this workload',
      );
    }
    filtered = parsed;
  }
  return {
    ...response,
    headers: {
      ...response.headers,
      'content-length': undefined,
      etag: undefined,
      'last-modified': undefined,
    },
    body: Buffer.from(JSON.stringify(filtered)),
  };
}

function compatiblePanel(session: SessionData, value: unknown): boolean {
  const panel = asObject(value);
  return Boolean(
    panel &&
    typeof panel.id === 'string' &&
    PANEL_ID.test(panel.id) &&
    panel.applicationType === 'MaverikX' &&
    panelReferencesAllowed(session, panel),
  );
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
