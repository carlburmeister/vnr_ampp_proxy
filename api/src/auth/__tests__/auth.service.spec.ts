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
  let listChildWorkloads: jest.Mock;
  let getUserDBWorkloads: jest.Mock;

  beforeEach(() => {
    getUserDBWorkloads = jest.fn(async () => [
      {
        id: 'parent-workload-001',
        name: '',
        is_parent: 1,
        pageType: 'custom',
      },
      {
        id: 'direct-workload-001',
        name: '',
        is_parent: 0,
        pageType: 'ampp-ui',
      },
      {
        id: 'standalone-workload-001',
        name: '',
        is_parent: 0,
        pageType: 'custom',
      },
    ]);

    const userCredentials = {
      findByUsername: jest.fn(async (username: string) => {
        if (username !== 'admin') {
          return null;
        }

        return {
          id: 'mock-user-001',
          username: 'admin',
          displayName: 'Mock VNR Operator',
          passwordHash: 'password-hash',
        };
      }),
      getUserDBWorkloads,
    } as unknown as UserCredentialsRepository;

    getWorkload = jest.fn(async (workloadId: string) => {
      if (workloadId === 'parent-workload-001') {
        return {
          id: workloadId,
          name: 'Production 1',
          applicationName: 'GV.Production',
          fabricId: 'mock-fabric-001',
          state: {
            nodeId: 'mock-node-001',
          },
        };
      }

      return {
        id: workloadId,
        name: 'Standalone workload 1',
        applicationName: 'GV.Player',
        fabricId: 'mock-fabric-001',
        state: {
          nodeId: 'mock-node-001',
        },
      };
    });

    listChildWorkloads = jest.fn(async () => ({
      workloads: [
        {
          workload: {
            id: 'child-workload-001',
            name: 'Mock Child Workload',
            applicationName: 'GV.MiniMixer',
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
            applicationName: 'GV.Player',
            fabricId: 'mock-fabric-001',
            state: {
              nodeId: 'mock-node-001',
            },
          },
        },
      ],
    }));

    const amppControl = {
      getWorkload,
      listChildWorkloads,
    } as unknown as AmppControlService;

    service = new AuthService(userCredentials, amppControl);
  });

  it('loads parent children first and applies individual page type overrides', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    await expect(service.login('admin', 'password')).resolves.toMatchObject({
      user: {
        id: 'mock-user-001',
        username: 'admin',
        displayName: 'Mock VNR Operator',
      },
      parentWorkloadId: 'parent-workload-001',
      fabricId: 'mock-fabric-001',
      nodeId: 'mock-node-001',
      allowedWorkloads: [
        {
          id: 'parent-workload-001',
          name: 'Production 1',
          is_parent: 1,
          pageType: 'custom',
          child_workloads: [
            {
              id: 'child-workload-001',
              name: 'Mock Child Workload',
              applicationName: 'GV.MiniMixer',
              is_parent: 0,
              pageType: 'custom',
              fabricId: 'mock-fabric-001',
              nodeId: 'mock-node-001',
            },
            {
              id: 'direct-workload-001',
              name: 'Individual workload 1',
              applicationName: 'GV.Player',
              is_parent: 0,
              pageType: 'ampp-ui',
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
          applicationName: 'GV.Player',
          fabricId: 'mock-fabric-001',
          nodeId: 'mock-node-001',
        },
      ],
    });

    expect(getUserDBWorkloads).toHaveBeenCalledWith('mock-user-001');
    expect(listChildWorkloads).toHaveBeenCalledWith('parent-workload-001');
    expect(getWorkload).toHaveBeenCalledTimes(2);
    expect(getWorkload).not.toHaveBeenCalledWith('direct-workload-001');
  });

  it('rejects invalid credentials', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    await expect(service.login('admin', 'wrong-password')).rejects.toThrow(
      UnauthorizedException,
    );

    expect(getUserDBWorkloads).not.toHaveBeenCalled();
    expect(listChildWorkloads).not.toHaveBeenCalled();
  });
});