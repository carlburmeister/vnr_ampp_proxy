export type ClientUser = {
  id: number;
  username: string;
  firstName: string | null;
  lastName: string | null;
  userType: 'admin' | 'user';
};

export type ClientWorkload = {
  id: number;
  workloadId: string;
  name: string;
  isParent: 0 | 1;
  pageType: 'custom' | 'ampp-ui';
};

export type ClientDashboard = {
  id: number;
  dashboardId: string;
  name: string;
  associatedWorkloadId: string | null;
  pageType: 'custom' | 'ampp-ui';
};

export type ClientResources = {
  workloads: ClientWorkload[];
  dashboards: ClientDashboard[];
  gvuiLayouts?: ClientGvuiLayout[];
};

export type ClientGvuiLayout = {
  id: number;
  layoutId: string;
  name: string;
  associatedWorkloadId: string | null;
};

export type DiscoveredChild = {
  id: string;
  name: string;
  parentId: string;
};

export type ClientPermissions = {
  workloadIds: number[];
  dashboardIds: number[];
  deniedChildWorkloadIds: string[];
  gvuiLayoutIds?: number[];
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/user-management/${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string | string[] } | null;
    const message = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
    throw new Error(message || `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const listClientUsers = () => request<ClientUser[]>('users');
export const listClientResources = () => request<ClientResources>('resources');
export const getClientPermissions = (userId: number) =>
  request<ClientPermissions>(`users/${userId}/permissions`);
export const listDiscoveredChildren = (workloadRowId: number) =>
  request<DiscoveredChild[]>(`workloads/${workloadRowId}/children`);
export const saveClientPermissions = (userId: number, permissions: ClientPermissions) =>
  request<ClientPermissions>(`users/${userId}/permissions`, {
    method: 'PUT', body: JSON.stringify(permissions),
  });
