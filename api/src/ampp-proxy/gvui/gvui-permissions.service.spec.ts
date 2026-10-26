import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { ReplacePermissionsDto } from '../../users/dto/replace-permissions.dto';
import { UserCredentialsRepository } from '../../users/services/user-credentials.repository';
import { GvuiPermissionsService } from './gvui-permissions.service';

describe('GVUI database permission contracts', () => {
  function setup(flag?: string) {
    const db = {
      execute: jest
        .fn<Promise<[unknown[]]>, [string, unknown[]]>()
        .mockResolvedValue([[]]),
      query: jest
        .fn<Promise<[unknown[]]>, [string, unknown[]]>()
        .mockResolvedValue([[]]),
    };
    const users = {
      withConnection: jest.fn(
        (run: (connection: typeof db) => Promise<unknown>) => run(db),
      ),
    };
    const service = new GvuiPermissionsService(
      users as unknown as UserCredentialsRepository,
      new ConfigService({ GVUI_PHASE2_ENABLED: flag }),
    );
    return { db, users, service };
  }

  it.each([undefined, 'false', 'TRUE', '1'])(
    'makes no GVUI table reads/writes with flag %s',
    async (flag) => {
      const { db, users, service } = setup(flag);
      expect(await service.listAssignments(db as never, 1)).toEqual([]);
      expect(await service.getGrantedIds(db as never, 7, 1)).toEqual([]);
      expect(await service.getUserLayouts('7', 1)).toEqual([]);
      expect(
        await service.replaceGrants(db as never, 1, 7, '1', undefined),
      ).toEqual([]);
      expect(() => service.validateChanges([])).toThrow(BadRequestException);
      expect(db.execute).not.toHaveBeenCalled();
      expect(db.query).not.toHaveBeenCalled();
      expect(users.withConnection).not.toHaveBeenCalled();
    },
  );

  it('uses assignment row IDs in management APIs, but UUIDs for session authorization', async () => {
    const { db, service } = setup('true');
    db.execute
      .mockResolvedValueOnce([
        [
          {
            id: 16,
            layoutId: 'layout-uuid',
            name: 'Layout',
            associatedWorkloadId: null,
          },
        ],
      ])
      .mockResolvedValueOnce([[{ id: 16 }]])
      .mockResolvedValueOnce([
        [{ id: 'layout-uuid', name: 'Layout', associatedWorkloadId: null }],
      ]);
    expect((await service.listAssignments(db as never, 1))[0].id).toBe(16);
    expect(await service.getGrantedIds(db as never, 7, 1)).toEqual([16]);
    expect((await service.getUserLayouts('7', 1))[0].id).toBe('layout-uuid');
    for (const [sql] of db.execute.mock.calls) {
      expect(sql).toContain('NOT EXISTS');
      expect(sql).toContain('client_gvui_denials');
      expect(sql).toContain('client_workload_denials');
    }
    const [sql, params] = db.execute.mock.calls[2];
    expect(sql).toContain('u.client_id=?');
    expect(sql).toContain('g.client_id=u.client_id');
    expect(params).toEqual([1, '7']);
  });

  it('fails closed when enabled tables cannot be read', async () => {
    const { db, service } = setup('true');
    db.execute.mockRejectedValue(new Error('Table does not exist'));
    await expect(service.getUserLayouts('7', 1)).rejects.toThrow(
      'Table does not exist',
    );
  });

  it('preserves omission, deduplicates valid IDs and rejects invalid service inputs', () => {
    const { service } = setup('true');
    expect(service.validateChanges(undefined)).toBeUndefined();
    expect(service.validateChanges([16, 16])).toEqual([16]);
    for (const value of [
      null,
      '16',
      {},
      [null],
      ['16'],
      [0],
      [-1],
      [1.5],
      [2147483648],
      Array(501).fill(16),
    ]) {
      expect(() => service.validateChanges(value)).toThrow(BadRequestException);
    }
  });

  it.each([undefined, [], [16], [16, 17]].map((ids) => ({ ids })))(
    'accepts compatible DTO payload $ids',
    ({ ids }) => {
      const dto = plainToInstance(ReplacePermissionsDto, {
        workloadIds: [],
        dashboardIds: [],
        deniedChildWorkloadIds: [],
        ...(ids === undefined ? {} : { gvuiLayoutIds: ids }),
      });
      expect(validateSync(dto)).toEqual([]);
    },
  );

  it.each(
    [
      null,
      '16',
      [null],
      ['16'],
      [0],
      [-1],
      [1.5],
      [2147483648],
      Array(501).fill(16),
    ].map((ids, index) => ({ ids, index })),
  )('rejects malformed DTO case $index', ({ ids }) => {
    const dto = plainToInstance(ReplacePermissionsDto, {
      workloadIds: [],
      dashboardIds: [],
      deniedChildWorkloadIds: [],
      gvuiLayoutIds: ids,
    });
    expect(
      validateSync(dto).some((error) => error.property === 'gvuiLayoutIds'),
    ).toBe(true);
  });
});
