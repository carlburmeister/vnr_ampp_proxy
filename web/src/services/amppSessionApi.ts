import type { AuthenticatedUser } from './authApi';

export type ChildWorkload = {
  is_parent: 0;
  id: string;
  name: string;
  applicationName: string;
  fabricId?: string;
  nodeId?: string;
};

export type AllowedWorkload = {
  id: string;
  name: string;
  is_parent: 0 | 1;
  applicationName?: string;
  fabricId?: string;
  nodeId?: string;
  child_workloads?: ChildWorkload[];
};

export type SessionData = {
  user: AuthenticatedUser;
  parentWorkloadId?: string;
  fabricId?: string;
  nodeId?: string;
  allowedWorkloads: AllowedWorkload[];
};

export async function getCurrentSession(): Promise<SessionData | null> {
  const response = await fetch('/api/ampp/session/current', {
    credentials: 'include',
  });

  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Load current session failed: ${response.status}`);
  }

  return response.json();
}