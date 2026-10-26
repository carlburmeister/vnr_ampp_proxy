import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { ConfigService } from '@nestjs/config';
import { GvuiPermissionsService } from '../../ampp-proxy/gvui/gvui-permissions.service';
import type { AllowedGvuiLayout } from '../../ampp-proxy/gvui/gvui.types';

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
  let phase2Enabled: boolean;
  let gvuiLayouts: AllowedGvuiLayout[];
  let getUserLayouts: jest.Mock;

  beforeEach(() => {
    phase2Enabled = false;
    gvuiLayouts = [];
    getUserLayouts = jest.fn(async () => phase2Enabled ? gvuiLayouts : []);
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

    const gvui = { get enabled() { return phase2Enabled; }, getUserLayouts } as unknown as GvuiPermissionsService;
    service = new AuthService(userCredentials, amppControl, new ConfigService(), gvui);
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

  it('keeps denied children hidden while retaining their read-only resource IDs', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    getWorkloadDenials.mockResolvedValue(['child-workload-001']);
    const result = await service.login('admin', 'password');
    expect(result.allowedWorkloads[0].child_workloads.map((child) => child.id))
      .not.toContain('child-workload-001');
    expect(result.amppAllowedWorkloadIds).not.toContain('child-workload-001');
    expect(result.amppResourceWorkloadIds).toEqual(expect.arrayContaining([
      'parent-workload-001', 'child-workload-001', 'internal-workload-001',
    ]));
    const session: any = {};
    service.applyAuthorization(session, result);
    expect(session.amppResourceWorkloadIds).toEqual(result.amppResourceWorkloadIds);
    expect(session.allowedWorkloads[0].child_workloads.map((child) => child.id))
      .not.toContain('child-workload-001');
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
    expect(session.amppResourceWorkloadIds).toEqual([]);
  });

  it('filters GVUI workload associations without expanding embedded resource access', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    const previous = await service.login('admin', 'password');
    phase2Enabled = true;
    gvuiLayouts = [
      { id: 'top-level', name: 'Top', associatedWorkloadId: null },
      { id: 'associated', name: 'Associated', associatedWorkloadId: 'DIRECT-WORKLOAD-001' },
      { id: 'unavailable', name: 'Unavailable', associatedWorkloadId: 'ungranted-workload' },
    ];
    const result = await service.login('admin', 'password');
    expect(result.allowedGvuiLayoutIds).toEqual(['top-level', 'associated']);
    expect(result.allowedWorkloads).toEqual(previous.allowedWorkloads);
    expect(result.amppAllowedWorkloadIds).toEqual(previous.amppAllowedWorkloadIds);
    expect(result.amppResourceWorkloadIds).toEqual(previous.amppResourceWorkloadIds);
    expect(getUserLayouts).toHaveBeenLastCalledWith('mock-user-001', 1);
  });

  it('allows a top-level GVUI grant without manufacturing a workload or launch context', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    phase2Enabled = true;
    gvuiLayouts = [{ id: 'top', name: 'Top', associatedWorkloadId: null }];
    getUserDBWorkloads.mockResolvedValue([]); getUserDashboards.mockResolvedValue([]);
    const result = await service.login('admin', 'password');
    expect(result.allowedGvuiLayoutIds).toEqual(['top']);
    expect(result.amppAllowedWorkloadIds).toEqual([]);
    expect(result.parentWorkloadId).toBeUndefined(); expect(getWorkload).not.toHaveBeenCalled();
  });

  it('refreshes revoked grants within the existing authorization interval', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(100000);
    try {
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      phase2Enabled = true;
      gvuiLayouts = [{ id: 'layout', name: 'Layout', associatedWorkloadId: null }];
      const session: any = {};
      service.applyAuthorization(session, await service.login('admin', 'password'));
      const fingerprint = session.authorizationFingerprint;
      gvuiLayouts = []; getUserLayouts.mockClear();
      clock.mockReturnValue(109999);
      expect(await service.refreshSessionAuthorization(session)).toBe(false);
      expect(getUserLayouts).not.toHaveBeenCalled();
      clock.mockReturnValue(110000);
      expect(await service.refreshSessionAuthorization(session)).toBe(true);
      expect(session.allowedGvuiLayoutIds).toEqual([]);
      expect(session.allowedGvuiLayouts).toEqual([]);
      expect(session.authorizationFingerprint).not.toBe(fingerprint);
    } finally { clock.mockRestore(); }
  });

  it('includes GVUI names and associations in authorization fingerprints', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    phase2Enabled = true;
    gvuiLayouts = [{ id: 'layout', name: 'Original', associatedWorkloadId: null }];
    const session: any = {};
    service.applyAuthorization(session, await service.login('admin', 'password'));
    const original = session.authorizationFingerprint;
    gvuiLayouts = [{ id: 'layout', name: 'Renamed', associatedWorkloadId: 'denied-workload' }];
    session.authorizationCheckedAt = 0;
    await service.refreshSessionAuthorization(session);
    expect(session.authorizationFingerprint).not.toBe(original);
    expect(session.allowedGvuiLayouts).toEqual([]);
  });

  it('refreshes old sessions missing GVUI fields immediately even with a matching fingerprint', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    phase2Enabled = true;
    gvuiLayouts = [{ id: 'layout', name: 'Layout', associatedWorkloadId: null }];
    const session: any = {};
    service.applyAuthorization(session, await service.login('admin', 'password'));
    delete session.allowedGvuiLayouts; delete session.allowedGvuiLayoutIds;
    expect(await service.refreshSessionAuthorization(session)).toBe(true);
    expect(session.allowedGvuiLayoutIds).toEqual(['layout']);
    expect(session.allowedGvuiLayouts).toEqual(gvuiLayouts);
  });

  it('clears Phase 2 grants immediately when its flag is disabled', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    phase2Enabled = true;
    gvuiLayouts = [{ id: 'layout', name: 'Layout', associatedWorkloadId: null }];
    const session: any = {};
    service.applyAuthorization(session, await service.login('admin', 'password'));
    phase2Enabled = false;
    expect(await service.refreshSessionAuthorization(session)).toBe(true);
    expect(session.allowedGvuiLayoutIds).toEqual([]);
    expect(session.gvuiPhase2Enabled).toBe(false);
  });

  it('does not advance the refresh deadline or authorize a request after a GVUI database failure', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    phase2Enabled = true;
    const session: any = {};
    service.applyAuthorization(session, await service.login('admin', 'password'));
    session.authorizationCheckedAt = 0;
    getUserLayouts.mockRejectedValue(new Error('GVUI tables unavailable'));
    await expect(service.refreshSessionAuthorization(session)).rejects.toThrow('GVUI tables unavailable');
    expect(session.authorizationCheckedAt).toBe(0);
  });

});
