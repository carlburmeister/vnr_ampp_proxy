import { ForbiddenException } from '@nestjs/common';

import { AmppControlService } from '../../ampp/services/ampp-control.service';
import type { AuthenticatedUser } from '../../auth/auth.service';
import { ClientPermissionsService } from '../services/client-permissions.service';
import { UserCredentialsRepository } from '../services/user-credentials.repository';

describe('ClientPermissionsService child workload listing', () => {
  const actor = { id: 1, clientId: 2, userType: 'admin' } as AuthenticatedUser;
  const listChildWorkloads = jest.fn();
  const db = {
    execute: jest.fn(async (sql: string) => {
      if (sql.includes('FROM client_users')) return [[{ client_id: 2, user_type: 'admin' }]];
      if (sql.includes('FROM ampp_workloads')) {
        return [[{ row_id: 7, workload_id: 'parent-uuid', is_parent: 1 }]];
      }
      return [[]];
    }),
  };
  const users = {
    withConnection: async (callback: (connection: typeof db) => Promise<unknown>) => callback(db),
  } as unknown as UserCredentialsRepository;
  const ampp = { listChildWorkloads } as unknown as AmppControlService;
  const service = new ClientPermissionsService(users, ampp);

  beforeEach(() => {
    db.execute.mockClear();
    listChildWorkloads.mockReset();
  });

  it('lists only immediate children in the same numeric name order as the user home page', async () => {
    listChildWorkloads.mockImplementation(async (id: string) => {
      if (id !== 'parent-uuid') throw new Error('Grandchildren must not be fetched for the selector');
      return { workloads: [
        { workload: { id: 'child-10', name: 'Mixer 10' } },
        { workload: { id: 'child-2', name: 'Mixer 2' } },
      ] };
    });

    expect(await service.listChildWorkloads(actor, 7)).toEqual([
      { id: 'child-2', name: 'Mixer 2', parentId: 'parent-uuid' },
      { id: 'child-10', name: 'Mixer 10', parentId: 'parent-uuid' },
    ]);
    expect(listChildWorkloads).toHaveBeenCalledTimes(1);
    expect(listChildWorkloads).toHaveBeenCalledWith('parent-uuid');
  });

  it('hides AMV-restricted children from client administrators', async () => {
    db.execute.mockImplementationOnce(async () => [[{ client_id: 2, user_type: 'admin' }]])
      .mockImplementationOnce(async () => [[{ row_id: 7, workload_id: 'parent-uuid', is_parent: 1 }]])
      .mockImplementationOnce(async () => [[{ workload_id: 'CHILD-2' }]]);
    listChildWorkloads.mockResolvedValue({ workloads: [
      { workload: { id: 'child-2', name: 'Blocked' } },
      { workload: { id: 'child-10', name: 'Allowed' } },
    ] });
    expect(await service.listChildWorkloads(actor, 7)).toEqual([
      { id: 'child-10', name: 'Allowed', parentId: 'parent-uuid' },
    ]);
    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('client_workload_denials'), [2],
    );
  });

  it('rejects workloads not owned by the client', async () => {
    db.execute.mockImplementationOnce(async () => [[{ client_id: 2, user_type: 'admin' }]])
      .mockImplementationOnce(async () => [[]]);

    await expect(service.listChildWorkloads(actor, 999)).rejects.toBeInstanceOf(ForbiddenException);
    expect(listChildWorkloads).not.toHaveBeenCalled();
  });
});


describe('ClientPermissionsService resource display names', () => {
  const actor = { id: 1, clientId: 2, userType: 'admin' } as AuthenticatedUser;
  const db = {
    execute: jest.fn(async (sql: string) => {
      if (sql.includes('FROM client_users')) return [[{ client_id: 2, user_type: 'admin' }]];
      if (sql.includes('FROM ampp_workloads')) return [[
        { id: 7, workloadId: 'workload-1', name: 'DB Workload', isParent: 1, pageType: 'ampp-ui' },
      ]];
      if (sql.includes('FROM ampp_dashboards')) return [[
        { id: 8, dashboardId: 'DASH-1', name: 'DB Dashboard', associatedWorkloadId: null, pageType: 'ampp-ui' },
        { id: 9, dashboardId: 'custom-1', name: 'Custom Label', associatedWorkloadId: null, pageType: 'custom' },
      ]];
      return [[]];
    }),
  };
  const users = {
    withConnection: async (callback: (connection: typeof db) => Promise<unknown>) => callback(db),
  } as unknown as UserCredentialsRepository;
  const getDashboardNames = jest.fn(async () => new Map([['dash-1', 'AMPP Dashboard']]));
  const getWorkloadName = jest.fn(async () => 'AMPP Workload');
  const ampp = { getDashboardNames, getWorkloadName } as unknown as AmppControlService;
  const service = new ClientPermissionsService(users, ampp);

  it('uses AMPP labels for registered resources and retains custom labels', async () => {
    const result = await service.listResources(actor);
    expect(result.workloads[0].name).toBe('AMPP Workload');
    expect(result.dashboards[0].name).toBe('AMPP Dashboard');
    expect(result.dashboards[1].name).toBe('Custom Label');
  });

  it('falls back to stored names for missing AMPP entries', async () => {
    getDashboardNames.mockResolvedValueOnce(new Map());
    getWorkloadName.mockResolvedValueOnce(undefined);
    const result = await service.listResources(actor);
    expect(result.workloads[0].name).toBe('DB Workload');
    expect(result.dashboards.some((item) => item.name === 'DB Dashboard')).toBe(true);
  });

  it('does not call AMPP when the actor fails client-admin validation', async () => {
    db.execute.mockResolvedValueOnce([[{ client_id: 2, user_type: 'user' }]]);
    getDashboardNames.mockClear();
    getWorkloadName.mockClear();
    await expect(service.listResources(actor)).rejects.toBeInstanceOf(ForbiddenException);
    expect(getDashboardNames).not.toHaveBeenCalled();
    expect(getWorkloadName).not.toHaveBeenCalled();
  });
});
