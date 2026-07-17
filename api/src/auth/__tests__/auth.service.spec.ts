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
  let listChildWorkloads: jest.Mock;
  let getUserDBWorkloads: jest.Mock;

  beforeEach(() => {
    getUserDBWorkloads = jest.fn(async () => [
      {
        id: 'parent-workload-001',
        name: 'Production 1',
        is_parent: 1,
      },
      {
        id: 'direct-workload-001',
        name: 'Individual workload 1',
        is_parent: 0,
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

    listChildWorkloads = jest.fn(async () => ({
      workloads: [
        {
          workload: {
            id: 'child-workload-001',
            name: 'Mock Child Workload',
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
      listChildWorkloads,
    } as unknown as AmppControlService;

    service = new AuthService(userCredentials, amppControl);
  });

  it('returns a user and allowed workloads for valid credentials', async () => {
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
          child_workloads: [
            {
              id: 'child-workload-001',
              name: 'Mock Child Workload',
              applicationName: 'GV.Player',
              fabricId: 'mock-fabric-001',
              nodeId: 'mock-node-001',
            },
          ],
        },
        {
          id: 'direct-workload-001',
          name: 'Individual workload 1',
          is_parent: 0,
        },
      ],
    });

    expect(getUserDBWorkloads).toHaveBeenCalledWith('mock-user-001');
    expect(listChildWorkloads).toHaveBeenCalledWith('parent-workload-001');
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