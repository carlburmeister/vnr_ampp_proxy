import { ForbiddenException } from '@nestjs/common';
import type { SessionData } from 'express-session';

import { AmppProxyPolicyService } from '../ampp-proxy-policy.service';
import { AmppResponseRewriterService } from '../ampp-response-rewriter.service';
import { GvuiPhase1Service } from './gvui-phase1.service';

const PLATFORM_URL = 'https://us-east-1.gvampp.com';
const PARENT = 'fb37856d-f3c3-483c-8114-857923e3878f';
const LAYOUT = 'f8106b06-9ff0-424d-b6dc-5df246f3ee2f';
const CHILDREN = [
  ['GV.AMPP.Apps.FlowMonitor', '6ac0ee96-f6cb-46d2-be4e-00034ad72943'],
  ['GV.AMPP.Apps.MiniMixer', 'cbda2ccd-a99f-4c6a-8e82-1e0948858441'],
  ['GV.AMPP.Apps.AudioMixer', 'bc8a392e-f043-467b-8358-7dfab9d13ea0'],
  ['GV.AMPP.Apps.SrtInput', '19876769-99e5-4685-a7e2-95d8c0720284'],
  ['GV.AMPP.Apps.SrtInput', 'fbab1aa9-405b-460d-abfa-83a239981f5e'],
];
const config = {
  get: (key: string) => ({
    GVUI_PHASE1_ENABLED: 'true',
    GVUI_PHASE1_USER_ID: '1',
  })[key],
  getOrThrow: () => PLATFORM_URL,
} as any;

const session = {
  user: { id: '1', userType: 'admin' },
  allowedWorkloads: [{
    id: PARENT,
    is_parent: 1,
    child_workloads: CHILDREN.map(([packageName, id]) => ({ id, packageName })),
  }],
} as SessionData;

function catalogRecord() {
  return {
    configuration: {
      key: `gv-ui-l/${LAYOUT}`,
      value: JSON.stringify({
        name: 'CKB_Test_Prod',
        components: CHILDREN.map(([pkg, id]) => ({
          type: 'web',
          url: `${PLATFORM_URL}/app/wrapper/embedded/single/${pkg}/${id}`,
        })),
      }),
    },
  };
}

describe('GV.UI development-only integration', () => {
  const gvui = new GvuiPhase1Service(config);
  const policy = new AmppProxyPolicyService({} as any, gvui);
  const rewriter = new AmppResponseRewriterService(config);

  it('requires the configured administrator and a known authorized child workload', () => {
    expect(gvui.getLayout(session)?.id).toBe(LAYOUT);
    expect(gvui.getLayout({ ...session, user: { ...session.user!, id: '2' } })).toBeNull();
    const missingChild = {
      ...session,
      allowedWorkloads: [{ ...session.allowedWorkloads![0], child_workloads: [] }],
    } as SessionData;
    expect(gvui.getLayout(missingChild)).toBeNull();
    expect(new GvuiPhase1Service({
      ...config,
      get: () => undefined,
    } as any).getLayout(session)).toBeNull();
  });

  it('allows additional authorized embedded UIs without exposing other layouts', () => {
    const allowed = catalogRecord();
    const other = { configuration: { key: 'gv-ui-l/other', value: '{}' } };
    const response = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify([other, allowed])),
      url: `${PLATFORM_URL}/configuration/api/v1/configurations/startsWith/gv-ui-l`,
    };
    const path = '/configuration/api/v1/configurations/startsWith/gv-ui-l';
    expect(JSON.parse(gvui.filterCatalog(session, PARENT, path, response).body.toString()))
      .toEqual([allowed]);

    const changed = catalogRecord();
    const value = JSON.parse(changed.configuration.value);
    value.components.push({
      type: 'web',
      url: `${PLATFORM_URL}/app/wrapper/embedded/single/GV.AMPP.Apps.SrtInput/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`,
    });
    changed.configuration.value = JSON.stringify(value);
    const filtered = JSON.parse(gvui.filterCatalog(session, PARENT, path, {
      ...response,
      body: Buffer.from(JSON.stringify([changed])),
    }).body.toString());
    expect(filtered).toHaveLength(1);
    expect(JSON.parse(filtered[0].configuration.value).components).toEqual(
      JSON.parse(allowed.configuration.value).components,
    );

    value.components.pop();
    value.components.push({ type: 'web', url: 'https://example.com' });
    changed.configuration.value = JSON.stringify(value);
    expect(JSON.parse(gvui.filterCatalog(session, PARENT, path, {
      ...response,
      body: Buffer.from(JSON.stringify([changed])),
    }).body.toString())).toEqual([]);

    value.components.pop();
    value.components.push({
      type: 'web',
      url: `${PLATFORM_URL}/app/wrapper/embedded/single/GV.AMPP.Apps.MiniMixer/${CHILDREN[3][1]}`,
    });
    changed.configuration.value = JSON.stringify(value);
    expect(JSON.parse(gvui.filterCatalog(session, PARENT, path, {
      ...response,
      body: Buffer.from(JSON.stringify([changed])),
    }).body.toString())).toEqual([]);
  });

  it('keeps the layout and original component metadata when two SRT Input UIs are denied', () => {
    const deniedIds = new Set(CHILDREN.slice(3).map(([, id]) => id));
    const limitedSession = {
      ...session,
      allowedWorkloads: [{
        ...session.allowedWorkloads![0],
        child_workloads: session.allowedWorkloads![0].child_workloads!.filter(
          (child) => !deniedIds.has(child.id),
        ),
      }],
    } as SessionData;
    const item = catalogRecord();
    const layout = JSON.parse(item.configuration.value);
    layout.components.forEach((component: Record<string, unknown>, index: number) => {
      component.name = `Embedded UI ${index}`;
      component.x = index / 5;
      component.zoom = 0.5;
    });
    layout.backgroundImagePath = 'images/background1.jpg';
    item.configuration.value = JSON.stringify(layout);
    const response = {
      status: 200,
      headers: { 'content-type': 'application/json', etag: '"upstream"', 'last-modified': 'Mon, 19 Oct 2026 00:00:00 GMT' },
      body: Buffer.from(JSON.stringify([item])),
      url: `${PLATFORM_URL}/configuration/api/v1/configurations/startsWith/gv-ui-l`,
    };
    const result = gvui.filterCatalog(
      limitedSession, PARENT, '/configuration/api/v1/configurations/startsWith/gv-ui-l', response,
    );
    const selected = JSON.parse(result.body.toString());
    expect(selected).toHaveLength(1);
    expect(selected[0].configuration.key).toBe(`gv-ui-l/${LAYOUT}`);
    const filteredLayout = JSON.parse(selected[0].configuration.value);
    expect(filteredLayout.components).toEqual(layout.components.slice(0, 3));
    expect(filteredLayout.backgroundImagePath).toBe(layout.backgroundImagePath);
    expect(result.headers['content-length']).toBe(String(result.body.length));
    expect(result.headers.etag).toBeUndefined();
    expect(result.headers['last-modified']).toBeUndefined();
    // The original upstream response must remain unchanged.
    expect(response.headers.etag).toBe('"upstream"');
    expect(JSON.parse(JSON.parse(response.body.toString())[0].configuration.value).components)
      .toHaveLength(5);
    expect(gvui.getLayout(limitedSession)?.id).toBe(LAYOUT);
    for (const [, id] of CHILDREN.slice(3)) {
      expect(() => policy.assertUiResourceAccess(limitedSession, id,
        `/app/wrapper/embedded/single/GV.AMPP.Apps.SrtInput/${id}`))
        .toThrow(ForbiddenException);
    }
    for (const [pkg, id] of CHILDREN.slice(0, 3)) {
      expect(policy.assertUiResourceAccess(limitedSession, id,
        `/app/wrapper/embedded/single/${pkg}/${id}`))
        .toBe(`/app/wrapper/embedded/single/${pkg}/${id}`);
    }
  });

  it('still exposes authorized siblings when one original test component is denied', () => {
    const [deniedPackage, deniedId] = CHILDREN[1];
    const limitedSession = {
      ...session,
      allowedWorkloads: [{
        ...session.allowedWorkloads![0],
        child_workloads: session.allowedWorkloads![0].child_workloads!.filter(
          (child) => child.id !== deniedId,
        ),
      }],
    } as SessionData;
    expect(gvui.getLayout(limitedSession)?.id).toBe(LAYOUT);
    const response = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify([catalogRecord()])),
      url: `${PLATFORM_URL}/configuration/api/v1/configurations/startsWith/gv-ui-l`,
    };
    const result = gvui.filterCatalog(limitedSession, PARENT,
      '/configuration/api/v1/configurations/startsWith/gv-ui-l', response);
    const components = JSON.parse(JSON.parse(result.body.toString())[0].configuration.value).components;
    expect(components).toHaveLength(4);
    expect(components.every((component: { url: string }) => !component.url.includes(deniedId)))
      .toBe(true);
    expect(() => policy.assertUiResourceAccess(limitedSession, deniedId,
      `/app/wrapper/embedded/single/${deniedPackage}/${deniedId}`))
      .toThrow(ForbiddenException);
  });

  it('can still load a layout containing only authorized SRT Input components', () => {
    const srtOnlySession = {
      ...session,
      allowedWorkloads: [{
        ...session.allowedWorkloads![0],
        child_workloads: session.allowedWorkloads![0].child_workloads!.slice(3),
      }],
    } as SessionData;
    expect(gvui.getLayout(srtOnlySession)?.id).toBe(LAYOUT);
    const path = '/configuration/api/v1/configurations/startsWith/gv-ui-l';
    const result = gvui.filterCatalog(srtOnlySession, PARENT, path, {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify([catalogRecord()])),
      url: `${PLATFORM_URL}${path}`,
    });
    const components = JSON.parse(JSON.parse(result.body.toString())[0].configuration.value).components;
    expect(components).toHaveLength(2);
    expect(components.every((component: { url: string }) =>
      CHILDREN.slice(3).some(([, id]) => component.url.endsWith(id)))).toBe(true);
  });

  it('does not expose unrelated layouts or malformed/mismatched components', () => {
    const path = '/configuration/api/v1/configurations/startsWith/gv-ui-l';
    const response = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      url: `${PLATFORM_URL}${path}`,
      body: Buffer.alloc(0),
    };
    const original = catalogRecord();
    const invalidUrls = [
      'https://example.com/app/wrapper/embedded/single/GV.AMPP.Apps.MiniMixer/' + CHILDREN[1][1],
      `${PLATFORM_URL}/app/wrapper/embedded/single/GV.AMPP.Apps.AudioMixer/${CHILDREN[1][1]}`,
      `${PLATFORM_URL}/app/wrapper/embedded/single/GV.AMPP.Apps.MiniMixer/${CHILDREN[1][1]}?evil=1`,
      '/app/wrapper/embedded/single/GV.AMPP.Apps.MiniMixer/' + CHILDREN[1][1],
    ];
    for (const url of invalidUrls) {
      const item = catalogRecord();
      const layout = JSON.parse(item.configuration.value);
      layout.components[0].url = url;
      item.configuration.value = JSON.stringify(layout);
      const result = gvui.filterCatalog(session, PARENT, path, {
        ...response,
        body: Buffer.from(JSON.stringify([item])),
      });
      expect(JSON.parse(result.body.toString())).toEqual([]);
    }
    const noAllowed = catalogRecord();
    const layout = JSON.parse(noAllowed.configuration.value);
    layout.components = [{
      type: 'web',
      url: `${PLATFORM_URL}/app/wrapper/embedded/single/GV.AMPP.Apps.SrtInput/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`,
    }];
    noAllowed.configuration.value = JSON.stringify(layout);
    expect(JSON.parse(gvui.filterCatalog(session, PARENT, path, {
      ...response, body: Buffer.from(JSON.stringify([noAllowed])),
    }).body.toString())).toEqual([]);
    const other = { ...original, configuration: { ...original.configuration, key: 'gv-ui-l/other' } };
    expect(JSON.parse(gvui.filterCatalog(session, PARENT, path, {
      ...response, body: Buffer.from(JSON.stringify([other])),
    }).body.toString())).toEqual([]);
  });

  it('enforces layout authorization and accepts only permitted embedded workload URLs', () => {
    expect(policy.assertUiResourceAccess(session, PARENT, `/gvui/desktop/${LAYOUT}`))
      .toBe(`/gvui/desktop/${LAYOUT}`);
    // The GV.UI OAuth library redirects to these two paths during authentication.
    for (const path of ['/gvui/callback', '/gvui/refresh']) {
      for (const url of [path, `${path}/`, `${path}?code=test-code&state=test-state`]) {
        expect(policy.assertUiResourceAccess(session, PARENT, url)).toBe(url);
        expect(() => policy.assertUiResourceAccess(
          { ...session, user: { ...session.user!, id: '2' } }, PARENT, url,
        )).toThrow(ForbiddenException);
      }
    }
    for (const url of [
      `/gvui/desktop/${LAYOUT}/`,
      `/gvui/desktop/${LAYOUT}?state=oauth-state`,
      `/gvui/desktop/${LAYOUT}/?state=oauth-state`,
      // Exact OAuth-return URL from GVUI_proxy_test_403_error.har.
      `/gvui/callback/desktop/${LAYOUT}`,
      `/gvui/callback/desktop/${LAYOUT}/`,
      `/gvui/callback/desktop/${LAYOUT}?code=token&state=opaque`,
    ]) {
      expect(policy.assertUiResourceAccess(session, PARENT, url)).toBe(url);
    }
    expect(() => policy.assertUiResourceAccess(session, PARENT, '/gvui/layouts'))
      .toThrow(ForbiddenException);
    for (const url of [
      '/gvui/desktop/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      '/gvui/desktop/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee?state=oauth-state',
      '/gvui/callback/desktop/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      `/gvui/callback/desktop/${LAYOUT}/another`,
      '/gvui/callback/layouts',
      '/gvui/layouts?state=oauth-state',
    ]) {
      expect(() => policy.assertUiResourceAccess(session, PARENT, url))
        .toThrow(ForbiddenException);
    }
    for (const [pkg, id] of CHILDREN) {
      for (const path of [
        `/app/wrapper/embedded/single/${pkg}/${id}`,
        `/app/wrapper/embedded/callback/embedded/single/${pkg}/${id}`,
      ]) {
        expect(policy.assertUiResourceAccess(session, id, path)).toBe(path);
      }
    }
    expect(() => policy.assertUiResourceAccess(session, PARENT,
      '/app/wrapper/embedded/single/GV.AMPP.Apps.MiniMixer/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    )).toThrow(ForbiddenException);
  });

  it('authorizes the restricted catalog and GV.UI notification mailbox', () => {
    const path = '/configuration/api/v1/configurations/startsWith/gv-ui-l';
    expect(policy.assertApiAccess(session, PARENT, 'GET', path)).toBe(path);
    expect(() => policy.assertApiAccess({ ...session, user: { ...session.user!, id: '2' } }, PARENT, 'GET', path))
      .toThrow(ForbiddenException);

    const mailbox = 'ts-gvui--1c82daed-3a15-4858-bfec-6536adc46430';
    const body = Buffer.from(JSON.stringify({
      durable: false, id: mailbox, mailboxTTL: 1500000,
      maximumLength: 10000, subscription: 'gv',
    }));
    expect(policy.assertApiAccess(session, PARENT, 'POST', '/notifications/api/v1/mailbox', body))
      .toBe('/notifications/api/v1/mailbox');
    const proxied = `ts-api.ampp-proxy.ui.${PARENT}.gvui--1c82daed-3a15-4858-bfec-6536adc46430`;
    const proxiedBody = Buffer.from(JSON.stringify({
      durable: false, id: proxied, mailboxTTL: 1500000,
      maximumLength: 10000, subscription: 'gv',
    }));
    // This exact ID shape caused 47 HTTP 403s in GVUI_proxy_test_403_errors_2.har.
    expect(policy.assertApiAccess(session, PARENT, 'POST', '/notifications/api/v1/mailbox', proxiedBody))
      .toBe('/notifications/api/v1/mailbox');
    const otherParentBody = Buffer.from(JSON.stringify({
      durable: false,
      id: `ts-api.ampp-proxy.ui.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.gvui--1c82daed-3a15-4858-bfec-6536adc46430`,
      mailboxTTL: 1500000, maximumLength: 10000, subscription: 'gv',
    }));
    expect(() => policy.assertApiAccess(session, PARENT, 'POST', '/notifications/api/v1/mailbox', otherParentBody))
      .toThrow(ForbiddenException);
    const subscribed = { ...session, amppNotificationMailboxIds: [mailbox, proxied] };
    const subscriptionPath = `/notifications/api/v1/mailbox/${mailbox}/subscribe/gv.ui.notifications.%23`;
    expect(policy.assertApiAccess(subscribed, PARENT, 'POST', subscriptionPath))
      .toBe(subscriptionPath);
    const proxiedTopic = `/notifications/api/v1/mailbox/${proxied}/subscribe/gv.ui.notifications.%23`;
    expect(policy.assertApiAccess(subscribed, PARENT, 'POST', proxiedTopic))
      .toBe(proxiedTopic);
  });

  it('preserves and authorizes the GV.UI OAuth callback deep link', () => {
    const path = `/gvui/callback/desktop/${LAYOUT}`;
    const response = rewriter.rewrite(PARENT, 'https://proxy.local', {
      status: 302,
      headers: { location: `${PLATFORM_URL}${path}` },
      body: Buffer.alloc(0),
      url: `${PLATFORM_URL}/identity/connect/authorize`,
    });
    expect(response.headers.Location)
      .toBe(`https://proxy.local/api/ampp-proxy/ui/${PARENT}${path}`);
    expect(policy.assertUiResourceAccess(session, PARENT, path)).toBe(path);
    expect(() => policy.assertUiResourceAccess(session, PARENT,
      '/gvui/callback/desktop/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    )).toThrow(ForbiddenException);
  });

  it('re-scopes embedded redirects to their actual workload', () => {
    const [pkg, id] = CHILDREN[1];
    const path = `/app/wrapper/embedded/callback/embedded/single/${pkg}/${id}`;
    const response = rewriter.rewrite(PARENT, 'https://proxy.local', {
      status: 302,
      headers: { location: `${PLATFORM_URL}${path}` },
      body: Buffer.alloc(0),
      url: `${PLATFORM_URL}/gvui/desktop/${LAYOUT}`,
    });
    expect(response.headers.Location)
      .toBe(`https://proxy.local/api/ampp-proxy/ui/${id}${path}`);
  });
});
