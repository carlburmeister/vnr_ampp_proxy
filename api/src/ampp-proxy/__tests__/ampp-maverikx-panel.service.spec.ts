import { BadGatewayException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SessionData } from 'express-session';

import { AmppDashboardFilterService } from '../ampp-dashboard-filter.service';
import { AmppMatrixFilterService } from '../ampp-matrix-filter.service';
import { AmppProxyPolicyService } from '../ampp-proxy-policy.service';

const W = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PANEL = '33333333-3333-4333-8333-333333333333';
const PARENT = '44444444-4444-4444-8444-444444444444';
const catalog = '/ampp/control/api/v1/panel/panels';
const embedded = (id = W, panel = PANEL) =>
  `/ampp/control/embedded/panelControl/${panel}/workload/${id}`;
const config = new ConfigService({ PLATFORM_URL: 'https://ampp.invalid' });
const json = (value: unknown, status = 200) => ({
  status,
  url: 'https://ampp.invalid',
  headers: { 'content-type': 'application/json', etag: '"upstream"' },
  body: Buffer.from(JSON.stringify(value)),
});
const panel = (extra = {}) => ({
  id: PANEL,
  name: 'MaverikX',
  applicationType: 'MaverikX',
  ...extra,
});

describe('MaverikX Panel workload authorization', () => {
  const policy = new AmppProxyPolicyService(
    new AmppMatrixFilterService(config),
  );
  const filter = new AmppDashboardFilterService(config);
  let session: SessionData;

  beforeEach(() => {
    session = {
      allowedWorkloads: [
        {
          id: W,
          name: 'Maverik X',
          is_parent: 0,
          pageType: 'ampp-ui',
          packageName: 'GV.AMPP.Apps.ProdSwitcher',
        },
      ],
      amppAllowedWorkloadIds: [W],
      amppResourceWorkloadIds: [W, OTHER],
    } as SessionData;
  });

  function loadPanels(value: unknown = { panels: { [PANEL]: panel() } }) {
    return filter.filterApiResponse(session, W, catalog, json(value));
  }

  it.each([
    catalog,
    '/ampp/control/api/v1/macro',
    '/ampp/control/api/v1/control/application/references',
    '/cluster/state/api/v1/workloads',
    `/configuration/api/v1/configurations/startsWith/gv/app/${W}/image-library`,
  ])(
    'allows captured read %s for a single assigned workload without dashboards',
    (path) => {
      expect(policy.assertApiAccess(session, W, 'GET', path)).toBe(path);
      expect(() => policy.assertApiAccess(session, W, 'POST', path)).toThrow(
        ForbiddenException,
      );
      expect(() =>
        policy.assertApiAccess(session, W, 'GET', path + '?extra=1'),
      ).toThrow(ForbiddenException);
    },
  );

  it('preserves dictionary keys and metadata while removing incompatible or unauthorized panels', () => {
    const result = loadPanels({
      version: 1,
      panels: {
        [PANEL]: panel(),
        otherApp: panel({ id: 'other-app', applicationType: 'MiniMixer' }),
        denied: panel({ id: 'denied', workloadId: OTHER }),
        serialized: panel({
          id: 'serialized',
          config: JSON.stringify({ workload: OTHER }),
        }),
        allowed: panel({ id: 'allowed', workloadId: W }),
      },
    });
    expect(JSON.parse(result.body.toString())).toEqual({
      version: 1,
      panels: {
        [PANEL]: panel(),
        allowed: panel({ id: 'allowed', workloadId: W }),
      },
    });
    expect(result.headers.etag).toBeUndefined();
    expect(policy.assertUiResourceAccess(session, W, embedded())).toBe(
      embedded(),
    );
    expect(
      policy.assertApiAccess(
        session,
        W,
        'GET',
        `/ampp/control/api/v1/panel/${PANEL}`,
      ),
    ).toBe(`/ampp/control/api/v1/panel/${PANEL}`);
  });

  it('rejects malformed catalogues rather than returning unfiltered data', () => {
    expect(() => loadPanels({ panels: [] })).toThrow(BadGatewayException);
    expect(() => loadPanels({})).toThrow(BadGatewayException);
  });

  it('requires a discovered compatible panel and checks the embedded target separately from its proxy prefix', () => {
    expect(() => policy.assertUiResourceAccess(session, W, embedded())).toThrow(
      ForbiddenException,
    );
    loadPanels();
    expect(() =>
      policy.assertUiResourceAccess(session, W, embedded(OTHER)),
    ).toThrow(ForbiddenException);
    expect(() =>
      policy.assertUiResourceAccess(session, W, embedded(W, OTHER)),
    ).toThrow(ForbiddenException);
    expect(() =>
      policy.assertApiAccess(
        session,
        W,
        'GET',
        `/ampp/control/api/v1/panel/${OTHER}`,
      ),
    ).toThrow(ForbiddenException);
  });

  it('uses the same rules for an authorized child of a parent assignment', () => {
    const child = session.allowedWorkloads[0];
    session.allowedWorkloads = [
      {
        id: PARENT,
        name: 'Production',
        is_parent: 1,
        pageType: 'ampp-ui',
        child_workloads: [{ ...child, is_parent: 0 } as never],
      },
    ];
    session.amppAllowedWorkloadIds = [PARENT, W];
    expect(policy.assertApiAccess(session, W, 'GET', catalog)).toBe(catalog);
    loadPanels();
    expect(policy.assertUiResourceAccess(session, W, embedded())).toBe(
      embedded(),
    );
    expect(() =>
      policy.assertApiAccess(session, PARENT, 'GET', catalog),
    ).toThrow(ForbiddenException);
  });

  it('does not enable panel APIs for other applications or resource-only workloads', () => {
    session.allowedWorkloads[0].packageName = 'GV.AMPP.Apps.MiniMixer';
    expect(() => policy.assertApiAccess(session, W, 'GET', catalog)).toThrow(
      ForbiddenException,
    );
    expect(() =>
      policy.assertApiAccess(session, OTHER, 'GET', catalog),
    ).toThrow(ForbiddenException);
  });

  it('filters application references without changing existing dashboard-only contexts', () => {
    const path = '/ampp/control/api/v1/control/application/references';
    const data = [{ name: 'MaverikX' }, { name: 'MiniMixer' }];
    const result = filter.filterApiResponse(session, W, path, json(data));
    expect(JSON.parse(result.body.toString())).toEqual([{ name: 'MaverikX' }]);
    session.allowedDashboards = [
      {
        id: PANEL,
        associatedWorkloadId: W,
        name: 'Dashboard',
        pageType: 'ampp-ui',
      },
    ];
    expect(filter.filterApiResponse(session, W, path, json(data)).body).toEqual(
      json(data).body,
    );
    session.allowedWorkloads[0].packageName = 'GV.AMPP.Apps.MiniMixer';
    expect(filter.filterApiResponse(session, W, path, json(data)).body).toEqual(
      json(data).body,
    );
  });

  it('revalidates panel definitions instead of trusting a cached ID alone', () => {
    loadPanels();
    const path = `/ampp/control/api/v1/panel/${PANEL}`;
    expect(
      filter.filterApiResponse(session, W, path, json(panel())).body,
    ).toEqual(json(panel()).body);
    expect(() =>
      filter.filterApiResponse(
        session,
        W,
        path,
        json(panel({ workload: { id: OTHER } })),
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      filter.filterApiResponse(session, W, path, json(panel({ id: OTHER }))),
    ).toThrow(ForbiddenException);
    expect(() =>
      filter.filterApiResponse(
        session,
        W,
        path,
        json(panel({ applicationType: 'MiniMixer' })),
      ),
    ).toThrow(ForbiddenException);
    loadPanels({ panels: {} });
    expect(() => policy.assertUiResourceAccess(session, W, embedded())).toThrow(
      ForbiddenException,
    );
  });

  it('rejects encoded, unbound and resource-only iframe targets', () => {
    loadPanels();
    expect(
      policy.assertUiResourceAccess(session, W, embedded() + '?t=123456789'),
    ).toBe(embedded() + '?t=123456789');
    expect(() =>
      policy.assertUiResourceAccess(
        session,
        W,
        embedded() + '?workloadId=' + OTHER,
      ),
    ).toThrow(ForbiddenException);
    const encoded = embedded(OTHER).replace('panelControl', '%70anelControl');
    expect(() => policy.assertUiResourceAccess(session, W, encoded)).toThrow(
      ForbiddenException,
    );
    expect(() =>
      policy.assertUiResourceAccess(
        session,
        W,
        `/ampp/control/embedded/panelControl/${PANEL}`,
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      policy.assertApiAccess(
        session,
        W,
        'GET',
        `/configuration/api/v1/configurations/startsWith/gv/app/${OTHER}/image-library`,
      ),
    ).toThrow(ForbiddenException);
  });

  it('binds commands and serialized payload references to control permissions', () => {
    const path = '/ampp/control/api/v1/control/commit';
    const command = {
      application: 'MaverikX',
      command: 'cut',
      workload: W,
      reconKey: 'panel-cut',
      formData: JSON.stringify({ bankIndex: 0 }),
    };
    const send = (data: unknown) =>
      policy.assertApiAccess(
        session,
        W,
        'POST',
        path,
        Buffer.from(JSON.stringify(data)),
      );
    expect(send(command)).toBe(path);
    expect(send({ ...command, application: 'any', command: 'getstate' })).toBe(
      path,
    );
    for (const change of [
      { workload: OTHER },
      { application: 'MiniMixer' },
      { application: 'any' },
      { formData: JSON.stringify({ workloadId: OTHER }) },
      { formData: JSON.stringify({ workload: { id: OTHER } }) },
      { formData: 'not JSON' },
      { formData: '[]' },
      { FormData: '{}' },
      { command: '' },
      { reconKey: 'dashboard-spoof' },
      { extra: true },
    ])
      expect(() => send({ ...command, ...change })).toThrow(ForbiddenException);
    const { formData, ...rest } = command;
    expect(send({ ...rest, FormData: formData })).toBe(path);
    expect(() =>
      policy.assertApiAccess(session, W, 'POST', path, Buffer.from('invalid')),
    ).toThrow(ForbiddenException);
  });

  it('scopes control subscriptions, publications and panel mailboxes to the active workload', () => {
    const mailbox = `ts-api.ampp-proxy.ui.${W}.app.wrapper--${PANEL}`;
    const subscribe = (topic: string) =>
      `/notifications/api/v1/mailbox/${mailbox}/subscribe/${topic}`;
    const topic = `gv.ampp.control.${W}.*.*`;
    expect(policy.assertApiAccess(session, W, 'POST', subscribe(topic))).toBe(
      subscribe(topic),
    );
    for (const forbidden of [
      `gv.ampp.control.${OTHER}.*.*`,
      'gv.ampp.control.*.*.*',
    ]) {
      expect(() =>
        policy.assertApiAccess(session, W, 'POST', subscribe(forbidden)),
      ).toThrow(ForbiddenException);
    }
    const path = '/notifications/api/v1/notifications';
    const content = { Key: 'panel-cut', Payload: { bankIndex: 0 } };
    const publish = (changes = {}) =>
      policy.assertApiAccess(
        session,
        W,
        'POST',
        path,
        Buffer.from(
          JSON.stringify({
            Source: '/ampp/control',
            topic: `gv.ampp.control.${W}.cut`,
            content: JSON.stringify(content),
            ...changes,
          }),
        ),
      );
    expect(publish()).toBe(path);
    expect(() => publish({ topic: `gv.ampp.control.${OTHER}.cut` })).toThrow(
      ForbiddenException,
    );
    expect(() =>
      publish({
        content: JSON.stringify({ ...content, Payload: { workload: OTHER } }),
      }),
    ).toThrow(ForbiddenException);
    expect(() => publish({ Source: '/unrelated' })).toThrow(ForbiddenException);
    const create = '/notifications/api/v1/mailbox';
    const mailboxBody = (id: string) =>
      Buffer.from(
        JSON.stringify({
          id,
          durable: false,
          mailboxTTL: 1500000,
          maximumLength: 10000,
          subscription: 'gv',
        }),
      );
    expect(
      policy.assertApiAccess(
        session,
        W,
        'POST',
        create,
        mailboxBody(`ts-app-${W}--${PANEL}`),
      ),
    ).toBe(create);
    expect(() =>
      policy.assertApiAccess(
        session,
        W,
        'POST',
        create,
        mailboxBody(`ts-app-${OTHER}--${PANEL}`),
      ),
    ).toThrow(ForbiddenException);
  });
});
