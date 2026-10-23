import type { AuthenticatedUser } from './authApi';

export type WorkloadPageType = 'custom' | 'ampp-ui';

export type ChildWorkload = {
  is_parent: 0;
  id: string;
  name: string;
  applicationName: string;
  packageName: string;
  pageType: WorkloadPageType;
  fabricId?: string;
  nodeId?: string;
};

export type AllowedWorkload = {
  id: string;
  name: string;
  is_parent: 0 | 1;
  applicationName?: string;
  packageName?: string;
  pageType: WorkloadPageType;
  fabricId?: string;
  nodeId?: string;
  child_workloads?: ChildWorkload[];
};

export type AllowedDashboard = {
  id: string;
  associatedWorkloadId: string | null;
  name: string;
  pageType: WorkloadPageType;
};

export type SessionData = {
  // Converted from the server's deadline to this browser's clock on receipt.
  expiresAt: number;
  user: AuthenticatedUser;
  parentWorkloadId?: string;
  fabricId?: string;
  nodeId?: string;
  allowedWorkloads: AllowedWorkload[];
  allowedDashboards: AllowedDashboard[];
};

export async function getCurrentSession(signal?: AbortSignal): Promise<SessionData | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 10000);

  try {
    const response = await fetch('/api/ampp/session/current', {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    });

    if (response.status === 401) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Load current session failed: ${response.status}`);
    }

    const data = await response.json() as SessionData & { serverTime: number };
    if (!Number.isFinite(data.expiresAt) || !Number.isFinite(data.serverTime)) {
      throw new Error('Session response is missing its expiry deadline');
    }
    data.expiresAt = Date.now() + Math.max(0, data.expiresAt - data.serverTime);
    return data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
