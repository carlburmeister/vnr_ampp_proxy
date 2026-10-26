import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { setupGvuiPermissions as setup } from '../../../test/helpers/gvui-permissions-fixture';

describe('GVUI grants in the shared permission transaction', () => {
  it('preserves raw GVUI grants for an older request body, including hidden denied grants', async () => {
    const { actor, state, service, changes, run } = setup();
    state.denied = true;
    expect(
      (await service.replacePermissions(actor, 2, changes)).gvuiLayoutIds,
    ).toEqual([]);
    expect(state.grants).toEqual([16]);
    expect(
      run.mock.calls.some(([sql]) =>
        /^(DELETE|INSERT).*client_user_gvui_permissions/.test(sql),
      ),
    ).toBe(false);
  });

  it('explicit [] clears GVUI grants and commits the same transaction', async () => {
    const { actor, state, service, changes, db } = setup();
    expect(
      (
        await service.replacePermissions(actor, 2, {
          ...changes,
          gvuiLayoutIds: [],
        })
      ).gvuiLayoutIds,
    ).toEqual([]);
    expect(state.grants).toEqual([]);
    expect(db.commit).toHaveBeenCalledTimes(1);
  });

  it('deduplicates IDs, attributes the grant and checks it after the client lock', async () => {
    const { actor, service, changes, state, run } = setup();
    expect(
      (
        await service.replacePermissions(actor, 2, {
          ...changes,
          gvuiLayoutIds: [16, 16],
        })
      ).gvuiLayoutIds,
    ).toEqual([16]);
    expect(state.grants).toEqual([16]);
    const sql = run.mock.calls.map(([query]) => query);
    expect(sql.findIndex((q) => q.includes('FROM clients'))).toBeLessThan(
      sql.findIndex((q) => q.includes('SELECT g.row_id FROM')),
    );
  });

  it.each(['denied', 'associationDenied', 'layoutClient'] as const)(
    'rejects restricted/cross-client layout (%s) without changing permissions',
    async (key) => {
      const { actor, state, service, changes, db } = setup();
      if (key === 'layoutClient') state.layoutClient = 2;
      else state[key] = true;
      await expect(
        service.replacePermissions(actor, 2, {
          ...changes,
          gvuiLayoutIds: [16],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(state.grants).toEqual([16]);
      expect(state.workloads).toEqual([7]);
      expect(db.rollback).toHaveBeenCalledTimes(1);
      expect(db.commit).not.toHaveBeenCalled();
    },
  );

  it('rechecks denials introduced before the shared client lock is obtained', async () => {
    const { actor, state, service, changes, db } = setup();
    state.afterClientLock = () => {
      state.denied = true;
    };
    await expect(
      service.replacePermissions(actor, 2, { ...changes, gvuiLayoutIds: [16] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.rollback).toHaveBeenCalled();
    expect(state.grants).toEqual([16]);
  });

  it.each(['role', 'actorClient', 'targetClient'] as const)(
    'rejects unauthorized grant writes (%s)',
    async (key) => {
      const { actor, state, service, changes, run } = setup();
      if (key === 'role') state.role = 'user';
      else state[key] = 2;
      await expect(
        service.replacePermissions(actor, 2, {
          ...changes,
          gvuiLayoutIds: [16],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(
        run.mock.calls.some(([sql]) =>
          sql.includes('client_user_gvui_permissions'),
        ),
      ).toBe(false);
    },
  );

  it('rejects an administrator whose role changed while waiting for the client lock', async () => {
    const { actor, state, service, changes, db } = setup();
    state.afterClientLock = () => {
      state.role = 'user';
    };
    await expect(
      service.replacePermissions(actor, 2, { ...changes, gvuiLayoutIds: [16] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.rollback).toHaveBeenCalled();
    expect(state.grants).toEqual([16]);
  });

  it('rolls GVUI grants back if a later workload write fails', async () => {
    const { actor, state, service, changes, db } = setup();
    state.failWorkloadInsert = true;
    await expect(
      service.replacePermissions(actor, 2, {
        ...changes,
        workloadIds: [7],
        gvuiLayoutIds: [],
      }),
    ).rejects.toThrow('Workload insert failed');
    expect(state.grants).toEqual([16]);
    expect(state.workloads).toEqual([7]);
    expect(db.rollback).toHaveBeenCalled();
    expect(db.commit).not.toHaveBeenCalled();
  });

  it('does not query GVUI tables for legacy saves while disabled', async () => {
    const { actor, service, changes, run } = setup(false);
    await service.replacePermissions(actor, 2, changes);
    expect(run.mock.calls.some(([sql]) => sql.includes('gvui'))).toBe(false);
    await expect(
      service.replacePermissions(actor, 2, { ...changes, gvuiLayoutIds: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
