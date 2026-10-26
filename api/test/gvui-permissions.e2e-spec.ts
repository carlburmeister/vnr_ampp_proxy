import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Request, Response, NextFunction } from 'express';
import type { GvuiLayoutAssignment } from '../src/ampp-proxy/gvui/gvui.types';

import { SessionAuthGuard } from '../src/auth/session-auth.guard';
import { ClientPermissionsController } from '../src/users/controllers/client-permissions.controller';
import { ClientPermissionsService } from '../src/users/services/client-permissions.service';
import { setupGvuiPermissions } from './helpers/gvui-permissions-fixture';

// The session is already authenticated here. Exercise the real controller,
// DTO validation and transactional permission services with isolated SQL.
describe('GVUI permission API contracts (isolated HTTP)', () => {
  let app: INestApplication<App>;
  let fixture: ReturnType<typeof setupGvuiPermissions>;
  const permissionUrl = '/api/user-management/users/2/permissions';

  beforeEach(async () => {
    fixture = setupGvuiPermissions();
    const module = await Test.createTestingModule({
      controllers: [ClientPermissionsController],
      providers: [
        { provide: ClientPermissionsService, useValue: fixture.service },
      ],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.session = { user: fixture.actor } as Request['session'];
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns assignment resources and round-trips explicit grant/clear operations', async () => {
    const resources = await request(app.getHttpServer())
      .get('/api/user-management/resources')
      .expect(200);
    expect(
      (resources.body as { gvuiLayouts: GvuiLayoutAssignment[] })
        .gvuiLayouts[0],
    ).toMatchObject({
      id: 16,
      name: 'Layout',
    });
    for (const ids of [[], [16]]) {
      const saved = await request(app.getHttpServer())
        .put(permissionUrl)
        .send({ ...fixture.changes, gvuiLayoutIds: ids })
        .expect(200);
      expect((saved.body as { gvuiLayoutIds: number[] }).gvuiLayoutIds).toEqual(
        ids,
      );
      const loaded = await request(app.getHttpServer())
        .get(permissionUrl)
        .expect(200);
      expect(
        (loaded.body as { gvuiLayoutIds: number[] }).gvuiLayoutIds,
      ).toEqual(ids);
    }
  });

  it('preserves GVUI grants when an older tab omits the new field', async () => {
    const saved = await request(app.getHttpServer())
      .put(permissionUrl)
      .send(fixture.changes)
      .expect(200);
    expect((saved.body as { gvuiLayoutIds: number[] }).gvuiLayoutIds).toEqual([
      16,
    ]);
    expect(fixture.state.grants).toEqual([16]);
  });

  it.each([null, '16', ['16'], [0]].map((ids, index) => ({ ids, index })))(
    'rejects invalid/null GVUI field case $index',
    async ({ ids }) => {
      await request(app.getHttpServer())
        .put(permissionUrl)
        .send({ ...fixture.changes, gvuiLayoutIds: ids })
        .expect(400);
      expect(fixture.state.grants).toEqual([16]);
    },
  );

  it('hides denied assignments and rejects saving their grants', async () => {
    fixture.state.denied = true;
    const resources = await request(app.getHttpServer())
      .get('/api/user-management/resources')
      .expect(200);
    expect(
      (resources.body as { gvuiLayouts: GvuiLayoutAssignment[] }).gvuiLayouts,
    ).toEqual([]);
    const loaded = await request(app.getHttpServer())
      .get(permissionUrl)
      .expect(200);
    expect((loaded.body as { gvuiLayoutIds: number[] }).gvuiLayoutIds).toEqual(
      [],
    );
    await request(app.getHttpServer())
      .put(permissionUrl)
      .send({ ...fixture.changes, gvuiLayoutIds: [16] })
      .expect(400);
  });

  it.each(['ordinary', 'cross-client'])(
    'rejects %s permission requests',
    async (kind) => {
      if (kind === 'ordinary') fixture.state.role = 'user';
      else fixture.state.targetClient = 2;
      await request(app.getHttpServer()).get(permissionUrl).expect(403);
      await request(app.getHttpServer())
        .put(permissionUrl)
        .send({ ...fixture.changes, gvuiLayoutIds: [16] })
        .expect(403);
    },
  );

  it('does not expose an activation flag in resource responses', async () => {
    const response = await request(app.getHttpServer()).get('/api/user-management/resources').expect(200);
    expect(Object.keys(response.body as object).sort()).toEqual(['dashboards', 'gvuiLayouts', 'workloads']);
  });
});
