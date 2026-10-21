import type { SessionData } from 'express-session';

import type { AmppCookieHttpResponse } from './ampp-cookie-http.service';

/** Workloads on the requested node, provided the current proxy scope uses it. */
export function getDiscoveryNodeWorkloads(
  session: SessionData,
  workloadId: string,
  nodeId: string,
): Set<string> {
  const matches = (session.allowedWorkloads ?? [])
    .flatMap((parent) => [parent, ...(parent.child_workloads ?? [])])
    .filter((workload) => workload.nodeId?.toLowerCase() === nodeId.toLowerCase());

  if (!matches.some((workload) => workload.id.toLowerCase() === workloadId.toLowerCase())) {
    return new Set();
  }

  return new Set(matches.map((workload) => workload.id.toLowerCase()));
}

/** Node discovery may return services for workloads outside the user's grants. */
export function filterDiscoveryNodeResponse(
  session: SessionData,
  workloadId: string,
  upstreamPath: string,
  response: AmppCookieHttpResponse,
): AmppCookieHttpResponse {
  const target = new URL(upstreamPath, 'http://ampp-proxy.local');
  if (target.pathname.toLowerCase().replace(/\/+$/, '') !==
        '/discovery/api/v1/services' ||
      target.searchParams.size !== 1 ||
      !target.searchParams.has('instance') ||
      response.status !== 200) {
    return response;
  }

  const allowed = getDiscoveryNodeWorkloads(
    session, workloadId, target.searchParams.get('instance') ?? '',
  );
  if (!allowed.size) return response; // Existing workload-ID queries remain untouched.

  let services: unknown;
  try {
    services = JSON.parse(response.body.toString('utf8'));
  } catch {
    services = [];
  }

  // Fail closed for unrecognized responses to a node-wide query.
  const filtered = Array.isArray(services)
    ? services.filter((value: unknown) => {
        if (!value || typeof value !== 'object') return false;
        const service = value as Record<string, unknown>;
        const instance = service.serviceInstance;
        const id = service.serviceId;
        return typeof instance === 'string' &&
          allowed.has(instance.toLowerCase()) &&
          (typeof id !== 'string' || id.toLowerCase() === instance.toLowerCase());
      })
    : [];

  return {
    ...response,
    body: Buffer.from(JSON.stringify(filtered)),
    headers: {
      ...response.headers,
      'content-type': 'application/json; charset=utf-8',
      'content-length': undefined,
      etag: undefined,
    },
  };
}
