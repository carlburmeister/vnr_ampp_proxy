import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SessionData } from 'express-session';
import { AmppControlService } from '../../ampp/services/ampp-control.service';
import { AmppMatrixFilterService } from '../ampp-matrix-filter.service';
import { AmppProxyPolicyService } from '../ampp-proxy-policy.service';
import { AmppResponseRewriterService } from '../ampp-response-rewriter.service';
import { GvuiProxyService } from './gvui-proxy.service';
import type { AmppCookieHttpResponse } from '../ampp-cookie-http.service';
import { runInNewContext } from 'node:vm';

const A = '11111111-1111-4111-8111-111111111111',
  B = '22222222-2222-4222-8222-222222222222';
const W = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  S = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const P = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  MAIL = 'ts-gvui--dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORIGIN = 'https://ampp.invalid',
  CATALOG = '/configuration/api/v1/configurations/startsWith/gv-ui-l';
const context = (id = A) => `gvui-${id}`;
const component = (id = W, pkg = 'GV.AMPP.Apps.MiniMixer') => ({
  type: 'web',
  url: `${ORIGIN}/app/wrapper/embedded/single/${pkg}/${id}`,
  x: 20,
  y: 10,
  width: 300,
  height: 200,
});
const dashboardComponent = (id = B) => ({
  type: 'web',
  url: `${ORIGIN}/cluster/systemdashboard/dashboard/${id}`,
  x: 100,
  y: 50,
  width: 640,
  height: 480,
});
function grantDashboard(
  session: SessionData,
  associatedWorkloadId: string | null = W,
) {
  session.allowedDashboardIds = [B];
  session.allowedDashboards = [
    { id: B, name: 'Dashboard', associatedWorkloadId, pageType: 'ampp-ui' },
  ];
}
function componentsOf(value: AmppCookieHttpResponse) {
  const items = JSON.parse(value.body.toString()) as ReturnType<
    typeof record
  >[];
  return (
    JSON.parse(items[0].configuration.value) as {
      components: Record<string, unknown>[];
    }
  ).components;
}
const record = (
  id = A,
  components: unknown[] = [component(), component(S)],
) => ({
  configuration: {
    key: `gv-ui-l/${id}`,
    version: 7,
    value: JSON.stringify({ id, name: 'Layout', theme: 'dark', components }),
  },
});
const response = (value: unknown): AmppCookieHttpResponse => ({
  url: ORIGIN + CATALOG,
  status: 200,
  headers: {
    'content-type': 'application/json',
    etag: 'upstream',
    'last-modified': 'old',
  },
  body: Buffer.from(JSON.stringify(value)),
});

function setup() {
  const config = new ConfigService({
    PLATFORM_URL: ORIGIN,
  });
  const ampp = {
    getGvuiConfigurations: jest.fn(() =>
      Promise.resolve([record(), record(B)]),
    ),
  };
  const service = new GvuiProxyService(
    config,
    ampp as unknown as AmppControlService,
  );
  const matrix = new AmppMatrixFilterService(config);
  const policy = new AmppProxyPolicyService(matrix, service);
  const session: SessionData = {
    cookie: {} as SessionData['cookie'],
    user: {
      id: '1',
      username: 'user',
      displayName: 'User',
      clientId: 1,
      userType: 'user',
    },
    allowedGvuiLayoutIds: [A, B],
    allowedGvuiLayouts: [A, B].map((id) => ({
      id,
      name: 'Layout',
      associatedWorkloadId: null,
    })),
    allowedWorkloads: [
      {
        id: P,
        name: 'Parent',
        is_parent: 1,
        pageType: 'ampp-ui',
        child_workloads: [
          {
            id: W,
            name: 'Mixer',
            is_parent: 0,
            packageName: 'GV.AMPP.Apps.MiniMixer',
            applicationName: 'Mixer',
            fabricId: 'fabric',
            nodeId: 'node',
            pageType: 'ampp-ui',
          },
        ],
      },
      {
        id: S,
        name: 'Standalone',
        is_parent: 0,
        packageName: 'GV.AMPP.Apps.MiniMixer',
        pageType: 'ampp-ui',
      },
    ],
    amppAllowedWorkloadIds: [P, W, S],
    amppResourceWorkloadIds: [P, W, S],
  };
  return { config, ampp, service, matrix, policy, session };
}

describe('GVUI launch, proxy and notification isolation', () => {
  it('opens two database-authorized layouts in independent contexts for an ordinary user', async () => {
    const { service, session, policy } = setup();
    const before = JSON.stringify(session.allowedWorkloads);
    const first = await service.launch(session, A),
      second = await service.launch(session, B);
    expect(first.url).toContain(`/ui/${context()}/gvui/desktop/${A}`);
    expect(second.url).toContain(`/ui/${context(B)}/gvui/desktop/${B}`);
    expect(service.contextWorkload(session, context())).toBe(W);
    expect(
      policy.assertUiResourceAccess(
        session,
        context(),
        `/gvui/callback/desktop/${A}?code=opaque`,
      ),
    ).toContain(A);
    expect(() =>
      policy.assertUiResourceAccess(session, context(), `/gvui/desktop/${B}`),
    ).toThrow(ForbiddenException);
    expect(JSON.stringify(session.allowedWorkloads)).toBe(before);
  });

  it('rejects unknown/cross-client/denied grants before contacting AMPP', async () => {
    const { service, session, ampp } = setup();
    session.allowedGvuiLayoutIds = [];
    await expect(service.launch(session, A)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(ampp.getGvuiConfigurations).not.toHaveBeenCalled();
  });

  it('launches a dashboard-only layout using its independently authorized association', async () => {
    const { service, session, ampp, policy } = setup();
    grantDashboard(session, P);
    const item = record(A, [dashboardComponent()]);
    ampp.getGvuiConfigurations.mockResolvedValue([item]);
    const before = JSON.stringify(session);
    await service.launch(session, A);
    expect(service.contextWorkload(session, context())).toBe(P);
    const selected = componentsOf(
      service.filterApiResponse(
        session,
        context(),
        CATALOG,
        response([item]),
        'https://proxy.invalid',
      ),
    );
    expect(selected).toEqual([
      {
        ...dashboardComponent(),
        url: `https://proxy.invalid/api/ampp-proxy/ui/${P}/cluster/systemdashboard/dashboard/${B}`,
      },
    ]);
    expect(
      policy.assertUiResourceAccess(
        session,
        P,
        `/cluster/systemdashboard/dashboard/${B}`,
      ),
    ).toContain(B);
    expect(
      policy.assertApiAccess(
        session,
        P,
        'GET',
        `/configuration/api/v1/configuration/gv/systemdashboards/dashboards/${B}`,
      ),
    ).toContain(B);
    expect(() =>
      policy.assertUiResourceAccess(
        session,
        W,
        `/cluster/systemdashboard/dashboard/${B}`,
      ),
    ).toThrow(ForbiddenException);
    expect(JSON.stringify(session)).toBe(before);
  });

  it('keeps dashboard frame contexts independent across authorized workloads', async () => {
    const { service, session, ampp, policy } = setup();
    grantDashboard(session, P);
    session.allowedDashboardIds.push(A);
    session.allowedDashboards.push({
      id: A,
      name: 'Other dashboard',
      associatedWorkloadId: S,
      pageType: 'ampp-ui',
    });
    const item = record(A, [dashboardComponent(), dashboardComponent(A)]);
    ampp.getGvuiConfigurations.mockResolvedValue([item]);
    await service.launch(session, A);
    const selected = componentsOf(
      service.filterApiResponse(
        session,
        context(),
        CATALOG,
        response([item]),
        'https://proxy.invalid',
      ),
    );
    expect(selected.map((component) => component.url)).toEqual([
      `https://proxy.invalid/api/ampp-proxy/ui/${P}/cluster/systemdashboard/dashboard/${B}`,
      `https://proxy.invalid/api/ampp-proxy/ui/${S}/cluster/systemdashboard/dashboard/${A}`,
    ]);
    expect(
      policy.assertUiResourceAccess(
        session,
        S,
        `/cluster/systemdashboard/dashboard/${A}`,
      ),
    ).toContain(A);
    expect(() =>
      policy.assertUiResourceAccess(
        session,
        P,
        `/cluster/systemdashboard/dashboard/${A}`,
      ),
    ).toThrow(ForbiddenException);
  });

  it('uses an authorized native component context for an unassociated dashboard', async () => {
    const { service, session, ampp, policy } = setup();
    grantDashboard(session, null);
    const item = record(A, [dashboardComponent(), component()]);
    ampp.getGvuiConfigurations.mockResolvedValue([item]);
    await service.launch(session, A);
    const selected = componentsOf(
      service.filterApiResponse(session, context(), CATALOG, response([item])),
    );
    expect(selected[0]).toEqual({
      ...dashboardComponent(),
      url: `/api/ampp-proxy/ui/${W}/cluster/systemdashboard/dashboard/${B}`,
    });
    expect(
      policy.assertUiResourceAccess(
        session,
        W,
        `/cluster/systemdashboard/dashboard/${B}`,
      ),
    ).toContain(B);
  });

  it('does not choose an unrelated first workload for an unassociated dashboard-only layout', async () => {
    const { service, session, ampp } = setup();
    grantDashboard(session, null);
    ampp.getGvuiConfigurations.mockResolvedValue([
      record(A, [dashboardComponent()]),
    ]);
    await expect(service.launch(session, A)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it.each(['ids', 'effective', 'association', 'custom'] as const)(
    'removes a dashboard lacking %s permission while retaining native siblings',
    async (kind) => {
      const { service, session, ampp } = setup();
      grantDashboard(session);
      if (kind === 'ids') session.allowedDashboardIds = [];
      if (kind === 'effective') session.allowedDashboards = [];
      if (kind === 'association')
        session.allowedDashboards[0].associatedWorkloadId = B;
      if (kind === 'custom') session.allowedDashboards[0].pageType = 'custom';
      const item = record(A, [component(), dashboardComponent()]);
      ampp.getGvuiConfigurations.mockResolvedValue([item]);
      await service.launch(session, A);
      expect(
        componentsOf(
          service.filterApiResponse(
            session,
            context(),
            CATALOG,
            response([item]),
          ),
        ),
      ).toEqual([component()]);
    },
  );

  it('rechecks dashboard permission and association revocation for open layouts and direct links', async () => {
    const { service, session, ampp, policy } = setup();
    grantDashboard(session);
    ampp.getGvuiConfigurations.mockResolvedValue([
      record(A, [dashboardComponent()]),
    ]);
    await service.launch(session, A);
    session.allowedDashboardIds = [];
    expect(service.isAllowed(session, context())).toBe(false);
    expect(() =>
      policy.assertUiResourceAccess(
        session,
        W,
        `/cluster/systemdashboard/dashboard/${B}`,
      ),
    ).toThrow(ForbiddenException);
    session.allowedDashboardIds = [B];
    session.amppAllowedWorkloadIds = [P, S];
    expect(service.isAllowed(session, context())).toBe(false);
  });

  it.each([
    {
      type: 'unknown-widget',
      url: `${ORIGIN}/cluster/systemdashboard/dashboard/${B}`,
    },
    {
      type: 'web',
      url: `${ORIGIN}/cluster/systemdashboard/dashboard/${B}?token=secret`,
    },
    {
      type: 'web',
      url: `${ORIGIN}/cluster/systemdashboard/dashboard/${B}/extra`,
    },
    {
      type: 'web',
      url: `https://outside.invalid/cluster/systemdashboard/dashboard/${B}`,
    },
  ])(
    'rejects unsupported or unsafe dashboard/widget forms',
    async (invalid) => {
      const { service, session, ampp } = setup();
      grantDashboard(session);
      ampp.getGvuiConfigurations.mockResolvedValue([
        record(A, [component(), invalid]),
      ]);
      await expect(service.launch(session, A)).rejects.toBeInstanceOf(
        ConflictException,
      );
    },
  );

  it('preserves and authorizes exact OAuth/callback routes and actual embedded workload contexts', async () => {
    const { service, session, policy, config } = setup();
    await service.launch(session, A);
    const rewrite = new AmppResponseRewriterService(config);
    // GV.UI returns from OAuth through /gvui/callback/desktop/{layoutId}.
    for (const path of [
      `/gvui/desktop/${A}/?state=opaque`,
      `/gvui/callback/desktop/${A}?code=opaque`,
      '/gvui/callback',
      '/gvui/refresh?state=opaque',
    ]) {
      expect(policy.assertUiResourceAccess(session, context(), path)).toBe(
        path,
      );
    }
    for (const path of [
      '/gvui/layouts',
      `/gvui/callback/desktop/${B}`,
      `/gvui/callback/desktop/${A}/another`,
    ]) {
      expect(() =>
        policy.assertUiResourceAccess(session, context(), path),
      ).toThrow(ForbiddenException);
    }
    const callback = `/gvui/callback/desktop/${A}`;
    const redirected = rewrite.rewrite(context(), 'https://proxy.invalid', {
      ...response(null),
      status: 302,
      url: `${ORIGIN}/identity/connect/authorize`,
      headers: { location: ORIGIN + callback },
      body: Buffer.alloc(0),
    });
    expect(redirected.headers.Location).toBe(
      `https://proxy.invalid/api/ampp-proxy/ui/${context()}${callback}`,
    );
    const embedded = `/app/wrapper/embedded/callback/embedded/single/GV.AMPP.Apps.MiniMixer/${W}`;
    const child = rewrite.rewrite(context(), 'https://proxy.invalid', {
      ...response(null),
      status: 302,
      url: `${ORIGIN}/gvui/desktop/${A}`,
      headers: { location: ORIGIN + embedded },
      body: Buffer.alloc(0),
    });
    expect(child.headers.Location).toBe(
      `https://proxy.invalid/api/ampp-proxy/ui/${W}${embedded}`,
    );
    expect(policy.assertUiResourceAccess(session, W, embedded)).toBe(embedded);
  });

  it('keeps authorized siblings and metadata when one embedded workload is denied', async () => {
    const { service, session, policy } = setup();
    session.allowedWorkloads[0].child_workloads = [];
    session.amppAllowedWorkloadIds = [P, S];
    await service.launch(session, A);
    const filtered = service.filterApiResponse(
      session,
      context(),
      CATALOG,
      response([record(), record(B)]),
    );
    const items = JSON.parse(filtered.body.toString()) as ReturnType<
      typeof record
    >[];
    expect(items).toHaveLength(1);
    expect(items[0].configuration.version).toBe(7);
    expect(JSON.parse(items[0].configuration.value)).toMatchObject({
      theme: 'dark',
      components: [component(S)],
    });
    expect(filtered.headers.etag).toBeUndefined();
    expect(filtered.headers['last-modified']).toBeUndefined();
    expect(() =>
      policy.assertUiResourceAccess(
        session,
        W,
        `/app/wrapper/embedded/single/GV.AMPP.Apps.MiniMixer/${W}`,
      ),
    ).toThrow(ForbiddenException);
    expect(policy.assertApiAccess(session, context(), 'GET', CATALOG)).toBe(
      CATALOG,
    );
    expect(() => policy.assertApiAccess(session, S, 'GET', CATALOG)).toThrow(
      ForbiddenException,
    );
  });

  it.each([
    'external',
    'dashboard',
    'empty',
    'package',
    'duplicate',
    'missing',
  ])('fails closed for %s layouts', async (kind) => {
    const { ampp, service, session } = setup();
    const values =
      kind === 'external'
        ? [record(A, [{ type: 'web', url: 'https://outside.invalid/' }])]
        : kind === 'dashboard'
          ? [
              record(A, [
                {
                  type: 'web',
                  url: `${ORIGIN}/cluster/systemdashboard/dashboard/${B}`,
                },
              ]),
            ]
          : kind === 'empty'
            ? [record(A, [])]
            : kind === 'package'
              ? [record(A, [component(W, 'Wrong.Package')])]
              : kind === 'duplicate'
                ? [record(), record()]
                : [];
    ampp.getGvuiConfigurations.mockResolvedValue(values);
    await expect(service.launch(session, A)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('does not select an unrelated assigned workload when every component is denied', async () => {
    const { service, session } = setup();
    session.amppAllowedWorkloadIds = [P];
    await expect(service.launch(session, A)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('reports AMPP outages without changing stored grants', async () => {
    const { service, session, ampp } = setup();
    ampp.getGvuiConfigurations.mockRejectedValue(new Error('Unavailable'));
    await expect(service.launch(session, A)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(session.allowedGvuiLayoutIds).toEqual([A, B]);
  });

  it('rejects open contexts after grant or component revocation', async () => {
    const { service, session, policy } = setup();
    await service.launch(session, A);
    session.allowedGvuiLayoutIds = [B];
    expect(() =>
      policy.assertWebSocketAccess(session, context(), '/pushnotificationshub'),
    ).toThrow(ForbiddenException);
    session.allowedGvuiLayoutIds = [A, B];
    session.amppAllowedWorkloadIds = [];
    expect(service.isAllowed(session, context())).toBe(false);
    expect(() =>
      policy.assertUiResourceAccess(session, context(), '/gvui/dist/app.js'),
    ).toThrow(ForbiddenException);
  });

  it('namespaces mailbox aliases upstream and enforces per-layout/session ownership', async () => {
    const { service, session, policy } = setup();
    await service.launch(session, A);
    await service.launch(session, B);
    const body = Buffer.from(
      JSON.stringify({
        id: MAIL,
        durable: false,
        mailboxTTL: 1500000,
        maximumLength: 10000,
        subscription: 'gv',
      }),
    );
    const path = '/notifications/api/v1/mailbox';
    expect(policy.assertApiAccess(session, context(), 'POST', path, body)).toBe(
      path,
    );
    // Keep support for the proxied alias used by the GV.UI bootstrap.
    const alias = `ts-api.ampp-proxy.ui.${context()}.gvui--dddddddd-dddd-4ddd-8ddd-dddddddddddd`;
    const proxiedBody = Buffer.from(body.toString().replace(MAIL, alias));
    expect(
      policy.assertApiAccess(session, context(), 'POST', path, proxiedBody),
    ).toBe(path);
    expect(() =>
      policy.assertApiAccess(session, context(B), 'POST', path, proxiedBody),
    ).toThrow(ForbiddenException);
    const prepared = service.prepareApiRequest(
      session,
      context(),
      'POST',
      path,
      body,
    );
    expect(prepared.mailbox.upstreamId).not.toBe(MAIL);
    const returned = service.completeApiRequest(
      session,
      context(),
      prepared,
      response({ id: prepared.mailbox.upstreamId }),
    );
    expect((JSON.parse(returned.body.toString()) as { id: string }).id).toBe(
      MAIL,
    );
    const poll = `/notifications/api/v1/notifications/${MAIL}?count=100&timeout=10000`;
    const subscription = `/notifications/api/v1/mailbox/${MAIL}/subscribe/gv.ui.notifications.%23`;
    expect(
      policy.assertApiAccess(session, context(), 'POST', subscription),
    ).toBe(subscription);
    expect(policy.assertApiAccess(session, context(), 'GET', poll)).toBe(poll);
    expect(
      service.prepareApiRequest(session, context(), 'GET', poll).path,
    ).toContain(prepared.mailbox.upstreamId);
    expect(() =>
      policy.assertApiAccess(session, context(B), 'GET', poll),
    ).toThrow(ForbiddenException);
    expect(() =>
      policy.assertApiAccess(
        { ...session, gvuiMailboxes: {} },
        context(),
        'GET',
        poll,
      ),
    ).toThrow(ForbiddenException);
    expect(() => policy.assertApiAccess(session, S, 'GET', poll)).toThrow(
      ForbiddenException,
    );
  });

  // Synthetic complete-configuration notifications: a real non-empty AMPP
  // update capture is still needed before claiming delta-event support.
  it('filters non-empty HTTP configuration events and drops unknown/cross-layout payloads', async () => {
    const { service, session } = setup();
    await service.launch(session, A);
    const event = {
      topic: `gv.ui.notifications.${A}`,
      content: JSON.stringify(record()),
    };
    const value = service.filterApiResponse(
      session,
      context(),
      `/notifications/api/v1/notifications/${MAIL}`,
      response([
        event,
        {
          ...event,
          topic: `gv.ui.notifications.${B}`,
          content: JSON.stringify(record(B)),
        },
        {
          topic: 'gv.ui.notifications.unknown',
          content: '{"delta":"unknown"}',
        },
      ]),
    );
    expect(JSON.parse(value.body.toString())).toEqual([event]);
    expect(
      JSON.parse(
        service
          .filterApiResponse(
            session,
            S,
            `/notifications/api/v1/notifications/${MAIL}`,
            response([event]),
          )
          .body.toString(),
      ),
    ).toEqual([]);
  });

  it('checks JSON and binary hub notifications and restricts outbound subscriptions', async () => {
    const { service, session, matrix } = setup();
    await service.launch(session, A);
    const frame = (id: string) =>
      Buffer.from(
        JSON.stringify({
          type: 1,
          target: 'ReceiveNotification',
          arguments: [
            {
              topic: `gv.ui.notifications.${id}`,
              content: JSON.stringify(record(id)),
            },
          ],
        }) + '\x1e',
      );
    const validate = (strings: string[]) =>
      service.isHubMessageAllowed(session, context(), strings);
    for (const length of [91, 123]) {
      const binaryPrefix = Buffer.concat([
        Buffer.from([length, 0xd9, length - 2]),
        Buffer.from('x'.repeat(length - 2)),
      ]);
      expect(
        matrix.filterWebSocketMessage(session, S, binaryPrefix, (strings) =>
          service.isHubMessageAllowed(session, S, strings),
        ),
      ).toEqual(binaryPrefix);
    }
    expect(
      matrix.filterWebSocketMessage(session, context(), frame(A), validate),
    ).toEqual(frame(A));
    expect(
      matrix.filterWebSocketMessage(session, context(), frame(B), validate),
    ).toBeUndefined();
    const text = JSON.stringify(record());
    const topic = `gv.ui.notifications.${A}`;
    const str = (v: string) => {
      const b = Buffer.from(v);
      return b.length < 32
        ? Buffer.concat([Buffer.from([0xa0 | b.length]), b])
        : Buffer.concat([
            Buffer.from([0xda, b.length >> 8, b.length & 255]),
            b,
          ]);
    };
    const message = Buffer.concat([Buffer.from([0x92]), str(topic), str(text)]);
    const size = message.length,
      bytes: number[] = [];
    let n = size;
    do {
      const v = n & 127;
      n >>>= 7;
      bytes.push(v | (n ? 128 : 0));
    } while (n);
    const binary = Buffer.concat([Buffer.from(bytes), message]);
    expect(
      matrix.filterWebSocketMessage(session, context(), binary, validate),
    ).toEqual(binary);
    expect(
      service.isHubMessageAllowed(
        session,
        context(),
        ['Subscribe', 'Subscriptions', 'gv.ui.notifications.#'],
        true,
      ),
    ).toBe(true);
    expect(
      service.isHubMessageAllowed(
        session,
        context(),
        ['Subscribe', `gv.ui.notifications.${B}`],
        true,
      ),
    ).toBe(false);
    expect(
      service.isHubMessageAllowed(
        session,
        context(),
        ['Subscribe', 'gv.ui.notifications.#', 'other.secret.topic'],
        true,
      ),
    ).toBe(false);
    expect(
      service.isHubMessageAllowed(
        session,
        context(),
        ['PublishNotification'],
        true,
      ),
    ).toBe(false);
    expect(
      service.isHubMessageAllowed(
        session,
        S,
        ['Subscribe', '["gv.ui.notifications.#"]'],
        true,
      ),
    ).toBe(false);
    expect(
      service.isHubMessageAllowed(session, context(), [
        '["gv.ui.notifications.#","unknown payload"]',
      ]),
    ).toBe(false);
    expect(
      service.isHubMessageAllowed(session, context(), ['unknown payload']),
    ).toBe(false);
    const subscription = Buffer.from(
      JSON.stringify({
        type: 1,
        target: 'Subscribe',
        arguments: ['gv.cluster.matrix.producer.#'],
      }) + '\x1e',
    );
    expect(
      matrix.filterWebSocketMessage(
        session,
        S,
        subscription,
        (strings) => service.isHubMessageAllowed(session, S, strings, true),
        false,
      ),
    ).toEqual(subscription);
  });

  it('retains per-layout OAuth rewriting and adds live access checks to the GVUI document only', () => {
    const { config } = setup();
    const rewrite = new AmppResponseRewriterService(config);
    const html = rewrite.rewrite(context(), 'https://proxy.invalid', {
      ...response(null),
      url: `${ORIGIN}/gvui/callback/desktop/${A}`,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from('<html><head></head><body></body></html>'),
    });
    expect(html.body.toString()).toContain(`"gvuiLayoutId":"${A}"`);
    expect(html.body.toString()).toContain('/access');
    expect(html.body.toString()).toContain(
      'if(!c.gvuiDocument||config.clusterUri)',
    );
  });

  it('removes embedded frames when the emitted document check sees revocation', async () => {
    const { config } = setup();
    const rewrite = new AmppResponseRewriterService(config);
    const html = rewrite.rewrite(context(), 'https://proxy.invalid', {
      ...response(null),
      url: `${ORIGIN}/gvui/desktop/${A}`,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from(
        '<html><head></head><body><iframe></iframe></body></html>',
      ),
    });
    const source = html.body
      .toString()
      .match(/if\(c.gvuiLayoutId\)\{[\s\S]*?(?=\nconst nativeOpen)/)[0];
    let verify!: () => Promise<void>;
    let allowed = true;
    const fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ allowed }),
      }),
    );
    const body = {
      replaceChildren: jest.fn(),
      appendChild: jest.fn((notice: { textContent: string }) => notice),
    };
    runInNewContext(source, {
      c: { gvuiLayoutId: A },
      nativeFetch: fetch,
      window: {
        setInterval: (fn: () => Promise<void>, ms: number) => {
          verify = fn;
          expect(ms).toBe(10000);
        },
        addEventListener: jest.fn(),
      },
      document: {
        readyState: 'loading',
        addEventListener: jest.fn(),
        body,
        createElement: () => ({ textContent: '' }),
      },
    });
    await verify();
    expect(body.replaceChildren).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(`/api/ampp-proxy/gvui/${A}/access`, {
      credentials: 'include',
      cache: 'no-store',
    });
    allowed = false;
    await verify();
    expect(body.replaceChildren).toHaveBeenCalledTimes(1);
    expect(body.appendChild.mock.calls[0][0].textContent).toContain(
      'Reopen the layout',
    );
  });
});
