import { ConfigService } from '@nestjs/config';
import { runInNewContext } from 'node:vm';
import { AmppResponseRewriterService } from '../ampp-response-rewriter.service';

const ORIGIN = 'https://proxy.invalid';
const PLATFORM = 'https://ampp.invalid';
const LAYOUT = 'f8106b06-9ff0-424d-b6dc-5df246f3ee2f';
const CLIENT = 'a0c8bd360f1c4ca79bc298adf2a720e6';
const WORKLOADS = [
  '6ac0ee96-f6cb-46d2-be4e-00034ad72943',
  'bc8a392e-f043-467b-8358-7dfab9d13ea0',
  'cbda2ccd-a99f-4c6a-8e82-1e0948858441',
  'fbab1aa9-405b-460d-abfa-83a239981f5e',
];
const redirectKey = `gv_redirect_${CLIENT}`;
const fallbackKey = `gv_redirect_fallback_${CLIENT}`;
const route = (id: string) => `/embedded/single/GV.AMPP.Apps.Test/${id}`;
const wrapper = (id: string) => `/app/wrapper${route(id)}`;

function frame(
  workloadId: string,
  session = new Map<string, string>(),
  options: {
    path?: string;
    standalone?: boolean;
    blockedStorage?: boolean;
    clientId?: string;
  } = {},
) {
  // Each frame has its own Storage prototype and shares the tab's session data.
  class WebStorage {
    failure?: Error;
    constructor(readonly values: Map<string, string>) {}
    getItem(key: string): string | null {
      if (this.failure) throw this.failure;
      return this.values.get(String(key)) ?? null;
    }
    setItem(key: string, value: string): void {
      if (this.failure) throw this.failure;
      this.values.set(String(key), String(value));
    }
    removeItem(key: string): void {
      if (this.failure) throw this.failure;
      this.values.delete(String(key));
    }
  }
  class Element {
    setAttribute() {}
  }
  class Xhr {
    open() {}
  }
  const path = options.path ?? wrapper(workloadId);
  const config = {
    clientId: options.clientId ?? CLIENT,
    proxyPath: '/app/wrapper',
  };
  const window = {
    location: new URL(`${ORIGIN}/api/ampp-proxy/ui/${workloadId}${path}`),
    top: {
      location: new URL(
        options.standalone
          ? ORIGIN + '/'
          : `${ORIGIN}/api/ampp-proxy/ui/gvui-${LAYOUT}/gvui/desktop/${LAYOUT}`,
      ),
    },
    sessionStorage: new WebStorage(session),
    localStorage: new WebStorage(new Map()),
    __GVCONFIG__: undefined as typeof config | undefined,
    fetch: jest.fn(),
    open: jest.fn(),
  };
  if (options.blockedStorage)
    Object.defineProperty(window, 'sessionStorage', {
      get() {
        throw new Error('Storage is unavailable');
      },
    });
  const globals = {
    window,
    Storage: WebStorage,
    URL,
    Request,
    XMLHttpRequest: Xhr,
    Element,
    document: { addEventListener: jest.fn() },
  };
  const html = new AmppResponseRewriterService(
    new ConfigService({ PLATFORM_URL: PLATFORM }),
  )
    .rewrite(workloadId, ORIGIN, {
      status: 200,
      url: PLATFORM + path,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from('<html><head></head><body></body></html>'),
    })
    .body.toString();
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))
    runInNewContext(match[1], globals);
  // Upstream config is assigned after the injected scripts in real documents.
  window.__GVCONFIG__ = config;
  return {
    window,
    html,
    storage: options.blockedStorage ? undefined : window.sessionStorage,
  };
}

// Behavioral fixture from AMPP's getRedirect/storeToken: a callback uses the
// saved redirect before the one-shot fallback. Token keys use the same client ID.
function auth(storage: ReturnType<typeof frame>['storage']) {
  return {
    login(location: string) {
      storage.setItem(fallbackKey, location);
    },
    storeToken(location: string) {
      storage.setItem(`gv_token_${CLIENT}`, 'shared-access-token');
      storage.setItem(`gv_id_token_${CLIENT}`, 'shared-id-token');
      storage.setItem(`gv_token_expiry_${CLIENT}`, '1234567890');
      storage.setItem(redirectKey, location);
    },
    getRedirect() {
      const saved = storage.getItem(redirectKey);
      if (saved) {
        storage.removeItem(fallbackKey);
        return saved;
      }
      const fallback = storage.getItem(fallbackKey);
      if (fallback) storage.removeItem(fallbackKey);
      return fallback;
    },
  };
}

function permutations<T>(items: T[]): T[][] {
  return items.length
    ? items.flatMap((item, i) =>
        permutations(items.filter((_, j) => i !== j)).map((rest) => [
          item,
          ...rest,
        ]),
      )
    : [[]];
}

describe('GVUI wrapper redirect storage', () => {
  it.each(permutations(WORKLOADS).map((order) => [order]))(
    'restores every workload with a shared valid token, callback order %j',
    (order) => {
      const session = new Map<string, string>();
      for (const id of WORKLOADS)
        auth(frame(id, session).storage).login(route(id));
      for (const [index, id] of order.entries()) {
        const callback = frame(id, session, {
          path: `/app/wrapper/embedded/callback${route(id)}`,
        });
        const client = auth(callback.storage);
        // The first response authenticates the shared client. Later callbacks
        // can reuse that token without storing their own response/redirect.
        if (index === 0) client.storeToken(route(id));
        expect(callback.storage.getItem(`gv_token_${CLIENT}`)).toBe(
          'shared-access-token',
        );
        expect(client.getRedirect()).toBe(route(id));
        expect(callback.window.__GVCONFIG__.clientId).toBe(CLIENT);
      }
      expect(session.get(`gv_id_token_${CLIENT}`)).toBe('shared-id-token');
      expect(session.get(`gv_token_expiry_${CLIENT}`)).toBe('1234567890');
    },
  );

  it('keeps saved redirects and fallback consumption independent across all four wrappers', () => {
    const session = new Map<string, string>();
    const frames = WORKLOADS.map((id) => frame(id, session));
    frames.forEach((item, i) => {
      auth(item.storage).login(route(WORKLOADS[i]));
      auth(item.storage).storeToken(route(WORKLOADS[i]));
    });
    frames.forEach((item, i) =>
      expect(auth(item.storage).getRedirect()).toBe(route(WORKLOADS[i])),
    );
    frames[0].storage.removeItem(redirectKey);
    expect(auth(frames[0].storage).getRedirect()).toBeNull();
    expect(auth(frames[1].storage).getRedirect()).toBe(route(WORKLOADS[1]));
  });

  it('does not reuse or delete a legacy shared redirect while consuming scoped fallbacks', () => {
    const session = new Map([
      [redirectKey, route(WORKLOADS[0])],
      [fallbackKey, route(WORKLOADS[0])],
    ]);
    const first = frame(WORKLOADS[1], session);
    const second = frame(WORKLOADS[2], session);
    expect(auth(first.storage).getRedirect()).toBeNull();
    auth(first.storage).login(route(WORKLOADS[1]));
    auth(second.storage).login(route(WORKLOADS[2]));
    expect(auth(first.storage).getRedirect()).toBe(route(WORKLOADS[1]));
    expect(auth(first.storage).getRedirect()).toBeNull();
    expect(auth(second.storage).getRedirect()).toBe(route(WORKLOADS[2]));
    expect(session.get(redirectKey)).toBe(route(WORKLOADS[0]));
    expect(session.get(fallbackKey)).toBe(route(WORKLOADS[0]));
  });

  it('uses the same scope for callback/renewal documents and normalized workload IDs', () => {
    const session = new Map<string, string>();
    auth(frame(WORKLOADS[0], session).storage).storeToken(route(WORKLOADS[0]));
    for (const path of [
      `/app/wrapper/embedded/callback${route(WORKLOADS[0])}`,
      '/app/wrapper/refresh.html',
    ]) {
      const callback = frame(WORKLOADS[0].toUpperCase(), session, { path });
      expect(auth(callback.storage).getRedirect()).toBe(route(WORKLOADS[0]));
    }
  });

  it('leaves local storage, other clients, ordinary keys and native errors unchanged', () => {
    const session = new Map<string, string>();
    const item = frame(WORKLOADS[0], session);
    const local = item.window.localStorage;
    local.setItem(redirectKey, 'local redirect');
    expect(local.getItem(redirectKey)).toBe('local redirect');
    local.removeItem(redirectKey);
    expect(local.getItem(redirectKey)).toBeNull();
    for (const key of [
      'ordinary',
      'gv_redirect_other-client',
      'gv_redirect_fallback_other-client',
      `gv_token_${CLIENT}`,
    ]) {
      expect(item.storage.setItem(key, 'unchanged')).toBeUndefined();
      expect(session.get(key)).toBe('unchanged');
      expect(item.storage.getItem(key)).toBe('unchanged');
      item.storage.removeItem(key);
      expect(session.has(key)).toBe(false);
    }
    const failure = new Error('Native storage failure');
    item.storage.failure = failure;
    expect(() => item.storage.getItem(redirectKey)).toThrow(failure);
    expect(() => item.storage.setItem(redirectKey, 'value')).toThrow(failure);
    expect(() => item.storage.removeItem(redirectKey)).toThrow(failure);
  });

  it('does not change standalone wrapper, dashboard or inner application redirects', () => {
    for (const options of [
      { standalone: true },
      { path: `/cluster/systemdashboard/dashboard/${LAYOUT}` },
      { path: `/mocha/application/${WORKLOADS[0]}/embedded/` },
    ]) {
      const session = new Map<string, string>();
      const item = frame(WORKLOADS[0], session, options);
      auth(item.storage).storeToken('original behavior');
      expect(session.get(redirectKey)).toBe('original behavior');
      expect(auth(item.storage).getRedirect()).toBe('original behavior');
    }
  });

  it('does not break document bootstrap when browser storage is unavailable', () => {
    expect(() =>
      frame(WORKLOADS[0], new Map(), { blockedStorage: true }),
    ).not.toThrow();
  });
});
