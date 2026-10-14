import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

import { AmppControlService } from '../../ampp/services/ampp-control.service';
import { UserCredentialsRepository } from '../../users/services/user-credentials.repository';
import { AuthService } from '../auth.service';

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
}));

describe('AuthService', () => {
  let service: AuthService;
  let getWorkload: jest.Mock;
  let getDashboardNames: jest.Mock;
  let getWorkloadName: jest.Mock;
  let listChildWorkloads: jest.Mock;
  let getUserDBWorkloads: jest.Mock;
  let getUserDashboards: jest.Mock;
  let getWorkloadDenials: jest.Mock;
  let findById: jest.Mock;
  let storedPasswordHash: string;

  beforeEach(() => {
    storedPasswordHash = 'password-hash';
    getUserDBWorkloads = jest.fn(async () => [
      {
        id: 'parent-workload-001',
        name: 'Admin Parent Production',
        is_parent: 1,
        pageType: 'ampp-ui',
      },
      {
        id: 'direct-workload-001',
        name: 'Admin Direct Mixer',
        is_parent: 0,
        pageType: 'custom',
      },
      {
        id: 'standalone-workload-001',
        name: 'Admin Standalone App',
        is_parent: 0,
        pageType: 'custom',
      },
    ]);

    getWorkloadDenials = jest.fn(async () => []);
    getUserDashboards = jest.fn(async () => [
      {
        id: 'dashboard-001',
        associatedWorkloadId: 'direct-workload-001',
        name: 'Operations Dashboard',
        pageType: 'ampp-ui',
      },
    ]);

    const mockUser = {
      id: 'mock-user-001', username: 'admin', displayName: 'Mock AMVVPP Operator',
      passwordHash: storedPasswordHash, clientId: 1, userType: 'user' as const,
    };
    findById = jest.fn(async () => mockUser);
    const userCredentials = {
      findById,
      getWorkloadDenials,
      findByUsername: jest.fn(async (username: string) => {
        if (username !== 'admin') {
          return null;
        }

        return {
          id: 'mock-user-001',
          username: 'admin',
          displayName: 'Mock AMVVPP Operator',
          passwordHash: storedPasswordHash,
          clientId: 1,
          userType: 'user',
        };
      }),
      getUserDBWorkloads,
      getUserDashboards,
    } as unknown as UserCredentialsRepository;

    getWorkload = jest.fn(async (workloadId: string) => {
      if (workloadId === 'parent-workload-001') {
        return {
          id: workloadId,
          name: 'Production 1',
          applicationName: 'Production',
          packageName: 'GV.AMPP.Apps.Production',
          fabricId: 'mock-fabric-001',
          state: {
            nodeId: 'mock-node-001',
          },
        };
      }

      return {
        id: workloadId,
        name: 'Standalone workload 1',
        applicationName: 'Player',
        packageName: 'GV.AMPP.Apps.Player',
        fabricId: 'mock-fabric-001',
        state: {
          nodeId: 'mock-node-001',
        },
      };
    });

    listChildWorkloads = jest.fn(async (workloadId: string) => ({
      workloads:
        workloadId === 'parent-workload-001'
          ? [
              {
                workload: {
                  id: 'child-workload-001',
                  name: 'Mock Child Workload',
                  applicationName: 'Mini Mix X 8 Inputs HD',
                  packageName: 'GV.AMPP.Apps.MiniMixer',
                  fabricId: 'mock-fabric-001',
                  state: {
                    nodeId: 'mock-node-001',
                  },
                },
              },
              {
                workload: {
                  id: 'direct-workload-001',
                  name: 'Individual workload 1',
                  applicationName: 'Audio Mix X 16 Channels',
                  packageName: 'GV.AMPP.Apps.AudioMixer',
                  fabricId: 'mock-fabric-001',
                  state: {
                    nodeId: 'mock-node-001',
                  },
                },
              },
            ]
          : workloadId === 'child-workload-001'
            ? [{ workload: { id: 'internal-workload-001' } }]
            : [],
    }));

    getDashboardNames = jest.fn(async () => new Map([['dashboard-001', 'AMPP Operations Dashboard']]));
    getWorkloadName = jest.fn(async (id: string) => ({
      'parent-workload-001': 'Production 1',
      'standalone-workload-001': 'Standalone workload 1',
      'direct-workload-001': 'Individual workload 1',
    } as Record<string, string>)[id]);
    const amppControl = {
      getWorkload,
      listChildWorkloads,
      getDashboardNames,
      getWorkloadName,
    } as unknown as AmppControlService;

    service = new AuthService(userCredentials, amppControl);
  });

  it('loads parent children first and applies individual page type overrides', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    const result = await service.login('admin', 'password');

    expect(result).toMatchObject({
      user: {
        id: 'mock-user-001',
        username: 'admin',
        displayName: 'Mock AMVVPP Operator',
      },
      parentWorkloadId: 'parent-workload-001',
      fabricId: 'mock-fabric-001',
      nodeId: 'mock-node-001',
      allowedWorkloads: [
        {
          id: 'parent-workload-001',
          name: 'Production 1',
          is_parent: 1,
          pageType: 'ampp-ui',
          applicationName: 'Production',
          packageName: 'GV.AMPP.Apps.Production',
          child_workloads: [
            {
              id: 'child-workload-001',
              name: 'Mock Child Workload',
              applicationName: 'Mini Mix X 8 Inputs HD',
              packageName: 'GV.AMPP.Apps.MiniMixer',
              is_parent: 0,
              pageType: 'ampp-ui',
              fabricId: 'mock-fabric-001',
              nodeId: 'mock-node-001',
            },
            {
              id: 'direct-workload-001',
              name: 'Individual workload 1',
              applicationName: 'Audio Mix X 16 Channels',
              packageName: 'GV.AMPP.Apps.AudioMixer',
              is_parent: 0,
              pageType: 'custom',
              fabricId: 'mock-fabric-001',
              nodeId: 'mock-node-001',
            },
          ],
        },
        {
          id: 'standalone-workload-001',
          name: 'Standalone workload 1',
          is_parent: 0,
          pageType: 'custom',
          applicationName: 'Player',
          packageName: 'GV.AMPP.Apps.Player',
          fabricId: 'mock-fabric-001',
          nodeId: 'mock-node-001',
        },
      ],
      allowedDashboardIds: ['dashboard-001'],
      allowedDashboards: [
        {
          id: 'dashboard-001',
          associatedWorkloadId: 'direct-workload-001',
          name: 'AMPP Operations Dashboard',
          pageType: 'ampp-ui',
        },
      ],
    });

    expect(result.amppAllowedWorkloadIds).toEqual(
      expect.arrayContaining([
        'parent-workload-001',
        'child-workload-001',
        'direct-workload-001',
        'internal-workload-001',
        'standalone-workload-001',
      ]),
    );

    expect(getUserDBWorkloads).toHaveBeenCalledWith('mock-user-001');
    expect(getUserDashboards).toHaveBeenCalledWith('mock-user-001');
    expect(listChildWorkloads).toHaveBeenCalledWith('parent-workload-001');
    expect(getWorkload).toHaveBeenCalledTimes(2);
    expect(getWorkload).not.toHaveBeenCalledWith('direct-workload-001');
  });

  it('retains AMPP labels when Admin database workload names change', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    const initial = await service.login('admin', 'password');
    const session: any = {};
    service.applyAuthorization(session, initial);
    const originalFingerprint = session.authorizationFingerprint;
    const updatedWorkloads = (await getUserDBWorkloads()).map((workload) => ({
      ...workload,
      name: `Updated ${workload.name}`,
    }));
    getUserDBWorkloads.mockResolvedValue(updatedWorkloads);
    session.authorizationCheckedAt = 0;

    expect(await service.refreshSessionAuthorization(session)).toBe(true);
    expect(session.authorizationFingerprint).not.toBe(originalFingerprint);
    expect(session.allowedWorkloads[0].name).toBe('Production 1');
    expect(session.allowedWorkloads[0].child_workloads[0].name).toBe('Mock Child Workload');
    expect(session.allowedWorkloads[0].child_workloads[1].name).toBe('Individual workload 1');
    expect(session.allowedWorkloads[1].name).toBe('Standalone workload 1');
    expect(session.allowedDashboards[0].name).toBe('AMPP Operations Dashboard');
  });

  it('refreshes AMPP dashboard and workload labels without a permission change', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    const initial = await service.login('admin', 'password');
    const session: any = {};
    service.applyAuthorization(session, initial);
    const fingerprint = session.authorizationFingerprint;
    getDashboardNames.mockResolvedValue(new Map([['dashboard-001', 'Renamed AMPP Dashboard']]));
    getWorkloadName.mockImplementation(async (id: string) =>
      id === 'parent-workload-001' ? 'Renamed AMPP Production' : undefined);
    session.authorizationCheckedAt = 0;

    expect(await service.refreshSessionAuthorization(session)).toBe(true);
    expect(session.authorizationFingerprint).toBe(fingerprint);
    expect(session.allowedDashboards[0].name).toBe('Renamed AMPP Dashboard');
    expect(session.allowedWorkloads[0].name).toBe('Renamed AMPP Production');
    expect(session.allowedDashboardIds).toEqual(initial.allowedDashboardIds);
    expect(session.amppAllowedWorkloadIds).toEqual(initial.amppAllowedWorkloadIds);
    expect(getWorkload).toHaveBeenCalledTimes(2); // No authorization rebuild.
  });

  it('keeps DB dashboard names when AMPP metadata is unavailable', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    getDashboardNames.mockResolvedValue(new Map());
    const result = await service.login('admin', 'password');
    expect(result.allowedDashboards[0].name).toBe('Operations Dashboard');
  });

  it('normalizes PHP bcrypt hashes before comparison', async () => {
    const suffix = 'a'.repeat(53);
    storedPasswordHash = '$2y$12$' + suffix;
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    await service.login('admin', 'password');

    expect(bcrypt.compare).toHaveBeenCalledWith('password', '$2b$12$' + suffix);
  });

  it('preserves existing Node.js bcrypt hashes', async () => {
    const suffix = 'a'.repeat(53);
    storedPasswordHash = '$2b$12$' + suffix;
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    await service.login('admin', 'password');

    expect(bcrypt.compare).toHaveBeenCalledWith('password', storedPasswordHash);
  });

  it('rejects invalid credentials', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    await expect(service.login('admin', 'wrong-password')).rejects.toThrow(
      UnauthorizedException,
    );

    expect(getUserDBWorkloads).not.toHaveBeenCalled();
    expect(getUserDashboards).not.toHaveBeenCalled();
    expect(listChildWorkloads).not.toHaveBeenCalled();
  });

  it('removes denied children, nested descendants and dependent dashboards', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    getWorkloadDenials.mockResolvedValue(['child-workload-001', 'direct-workload-001']);
    getUserDashboards.mockResolvedValue([
      { id: 'blocked-dashboard', associatedWorkloadId: 'child-workload-001', name: 'Blocked', pageType: 'ampp-ui' },
      { id: 'standalone-dashboard', associatedWorkloadId: null, name: 'Standalone', pageType: 'ampp-ui' },
    ]);
    const result = await service.login('admin', 'password');
    expect(result.allowedWorkloads[0].child_workloads).toEqual([]);
    expect(result.amppAllowedWorkloadIds).not.toContain('child-workload-001');
    expect(result.amppAllowedWorkloadIds).not.toContain('internal-workload-001');
    expect(result.amppAllowedWorkloadIds).not.toContain('direct-workload-001');
    expect(result.allowedDashboardIds).toEqual(['standalone-dashboard']);
  });

  it('allows authenticated users without assigned workloads', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    getUserDBWorkloads.mockResolvedValue([]);
    getUserDashboards.mockResolvedValue([]);
    const result = await service.login('admin', 'password');
    expect(result.allowedWorkloads).toEqual([]);
    expect(result.amppAllowedWorkloadIds).toEqual([]);
    expect(result.fabricId).toBe('');
    expect(getWorkload).not.toHaveBeenCalled();
  });

  it('refreshes permissions in an existing session when assignments change', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    const initial = await service.login('admin', 'password');
    const session: any = {};
    service.applyAuthorization(session, initial);
    getUserDBWorkloads.mockResolvedValue([]);
    getUserDashboards.mockResolvedValue([]);
    session.authorizationCheckedAt = 0;
    expect(await service.refreshSessionAuthorization(session)).toBe(true);
    expect(session.allowedWorkloads).toEqual([]);
    expect(session.amppAllowedWorkloadIds).toEqual([]);
  });

});
