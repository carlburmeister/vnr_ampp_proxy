import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SessionData } from 'express-session';
import { GvuiProxyService } from '../gvui/gvui-proxy.service';

const LAYOUT = '11111111-1111-4111-8111-111111111111';
const WORKLOAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALIAS = 'ts-gvui--dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CONTEXT = `gvui-${LAYOUT}`;
const ORIGIN = 'https://ampp.invalid';

// These compatibility cases run unchanged on main, the original PR, and its fix.
// Activity is fixture evidence of inactivity, not an assertion about AMPP TTL.
async function setup() {
  const service = new GvuiProxyService(
    new ConfigService({ PLATFORM_URL: ORIGIN }),
    {
      getGvuiConfigurations: () =>
        Promise.resolve([
          {
            configuration: {
              key: `gv-ui-l/${LAYOUT}`,
              value: JSON.stringify({
                id: LAYOUT,
                components: [
                  {
                    type: 'web',
                    url: `${ORIGIN}/app/wrapper/embedded/single/Test/${WORKLOAD}`,
                  },
                ],
              }),
            },
          },
        ]),
    } as never,
  );
  const session = {
    cookie: {},
    allowedGvuiLayoutIds: [LAYOUT],
    allowedGvuiLayouts: [
      { id: LAYOUT, name: 'Layout', associatedWorkloadId: null },
    ],
    allowedWorkloads: [
      {
        id: WORKLOAD,
        name: 'Test',
        is_parent: 0,
        pageType: 'ampp-ui',
        packageName: 'Test',
      },
    ],
    amppAllowedWorkloadIds: [WORKLOAD],
  } as SessionData;
  await service.launch(session, LAYOUT);
  const create = () => {
    const prepared = service.prepareApiRequest(
      session,
      CONTEXT,
      'POST',
      '/notifications/api/v1/mailbox',
      Buffer.from(JSON.stringify({ id: ALIAS })),
    );
    return service.completeApiRequest(session, CONTEXT, prepared, {
      url: ORIGIN,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ id: prepared.mailbox.upstreamId })),
    });
  };
  return { service, session, create };
}

describe('GVUI baseline compatibility', () => {
  it('preserves an owned alias and rejects another session or revoked layout', async () => {
    const { service, session, create } = await setup();
    create();
    const path = `/notifications/api/v1/notifications/${ALIAS}?count=100&timeout=10000`;
    expect(
      service.prepareApiRequest(session, CONTEXT, 'GET', path).path,
    ).toContain(session.gvuiMailboxes[ALIAS].upstreamId);
    expect(() =>
      service.prepareApiRequest(
        { ...session, gvuiMailboxes: {} },
        CONTEXT,
        'GET',
        path,
      ),
    ).toThrow(ForbiddenException);
    session.allowedGvuiLayoutIds = [];
    expect(() =>
      service.prepareApiRequest(session, CONTEXT, 'GET', path),
    ).toThrow(ForbiddenException);
  });

  it('reclaims 512 recorded-idle aliases before accepting a fresh alias', async () => {
    const { session, create } = await setup();
    const old = Date.now() - 27 * 60000;
    session.gvuiMailboxes = Object.fromEntries(
      Array.from({ length: 512 }, (_, i) => [
        `old-${i}`,
        {
          contextId: CONTEXT,
          upstreamId: `upstream-${i}`,
          createdAt: old,
          lastUsedAt: old,
        },
      ]),
    );
    expect(create().status).toBe(200);
    expect(Object.keys(session.gvuiMailboxes)).toEqual([ALIAS]);
  });
});
