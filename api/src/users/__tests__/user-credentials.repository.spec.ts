import { ConfigService } from '@nestjs/config';
import { createPool } from 'mysql2/promise';

import { UserCredentialsRepository } from '../services/user-credentials.repository';

jest.mock('mysql2/promise', () => ({
  createPool: jest.fn(),
}));

describe('UserCredentialsRepository', () => {
  const execute = jest.fn();
  const end = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    (createPool as jest.Mock).mockReturnValue({
      execute,
      end,
    });
  });

  it('returns the configured mock user', async () => {
    execute.mockResolvedValueOnce([
      [
        {
          user_id: 'mock-user-001',
          client_name: 'Mock AMVVPP Operator',
          username: 'operator',
          password_hash: 'secret',
        },
      ],
    ]);

    const config = {
      get: jest.fn((key: string) => {
        if (key === 'MYSQL_PORT') {
          return '3306';
        }

        return undefined;
      }),
    } as unknown as ConfigService;

    const repository = new UserCredentialsRepository(config);

    await expect(repository.findByUsername(' Operator ')).resolves.toEqual({
      id: 'mock-user-001',
      username: 'operator',
      displayName: 'Mock AMVVPP Operator',
      passwordHash: 'secret',
    });

    expect(execute).toHaveBeenCalledWith(expect.any(String), ['operator']);
  });

  it('returns assigned DB workloads for the user', async () => {
    execute.mockResolvedValueOnce([
      [
        {
          workload_id: 'parent-workload-001',
          is_parent: 1,
          page_type: 'custom',
        },
        {
          workload_id: 'direct-workload-001',
          is_parent: 0,
          page_type: 'ampp-ui',
        },
      ],
    ]);

    const config = {
      get: jest.fn((key: string) => {
        if (key === 'MYSQL_PORT') {
          return '3306';
        }

        return undefined;
      }),
    } as unknown as ConfigService;

    const repository = new UserCredentialsRepository(config);

    await expect(repository.getUserDBWorkloads('mock-user-001')).resolves.toEqual([
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
    ]);

    expect(execute).toHaveBeenCalledWith(expect.any(String), ['mock-user-001']);
  });

  it('returns assigned dashboards for the user', async () => {
    execute.mockResolvedValueOnce([
      [
        {
          dashboard_id: 'dashboard-001',
          associated_workload_id: 'workload-001',
          name: 'Operations Dashboard',
          page_type: 'ampp-ui',
        },
      ],
    ]);

    const config = {
      get: jest.fn((key: string) => {
        if (key === 'MYSQL_PORT') {
          return '3306';
        }

        return undefined;
      }),
    } as unknown as ConfigService;

    const repository = new UserCredentialsRepository(config);

    await expect(repository.getUserDashboards('mock-user-001')).resolves.toEqual([
      {
        id: 'dashboard-001',
        associatedWorkloadId: 'workload-001',
        name: 'Operations Dashboard',
        pageType: 'ampp-ui',
      },
    ]);

    expect(execute).toHaveBeenCalledWith(expect.any(String), ['mock-user-001']);
  });
});
