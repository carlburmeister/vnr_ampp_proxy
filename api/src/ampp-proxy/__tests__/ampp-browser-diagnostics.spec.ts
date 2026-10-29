/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- Small browser doubles execute the emitted JavaScript in a VM. */
import { ConfigService } from '@nestjs/config';
import { runInNewContext } from 'node:vm';
import { createAmppBrowserDiagnosticsScript } from '../ampp-browser-diagnostics';
import { AmppResponseRewriterService } from '../ampp-response-rewriter.service';

const ORIGIN = 'https://proxy.invalid';
const UPSTREAM = 'https://ampp.invalid';
const LAYOUT = 'f8106b06-9ff0-424d-b6dc-5df246f3ee2f';
const WORKLOADS = [
  '6ac0ee96-f6cb-46d2-be4e-00034ad72943',
  'bc8a392e-f043-467b-8358-7dfab9d13ea0',
  'cbda2ccd-a99f-4c6a-8e82-1e0948858441',
  'fbab1aa9-405b-460d-abfa-83a239981f5e',
];
const wrapper = (id: string) =>
  `/app/wrapper/embedded/single/GV.AMPP.Apps.Test/${id}`;
const proxy = (id: string, path: string) =>
  `${ORIGIN}/api/ampp-proxy/ui/${id}${path}`;

function browser(
  contextId = `gvui-${LAYOUT}`,
  options: {
    parent?: ReturnType<typeof browser>;
    frame?: any;
    path?: string;
    local?: Map<string, string>;
  } = {},
) {
  const path =
    options.path ??
    (contextId.startsWith('gvui-')
      ? `/gvui/desktop/${LAYOUT}`
      : wrapper(contextId));
  const location = new URL(proxy(contextId, path));
  const listeners = new Map<string, ((event: any) => void)[]>();
  const listen = (name: string, fn: (event: any) => void) =>
    listeners.set(name, [...(listeners.get(name) ?? []), fn]);
  class Element {
    attributes = new Map<string, string>();
    setAttribute(name: string, value: string) {
      this.attributes.set(name.toLowerCase(), value);
    }
    getAttribute(name: string) {
      return this.attributes.get(name) ?? null;
    }
    querySelectorAll() {
      return [];
    }
  }
  class IFrame extends Element {
    contentWindow: any;
    get src() {
      return this.getAttribute('src') ?? '';
    }
    set src(value: string) {
      this.attributes.set('src', value);
    }
  }
  class Storage {
    constructor(readonly values = new Map<string, string>()) {}
    get length() {
      return this.values.size;
    }
    key(index: number) {
      return [...this.values.keys()][index] ?? null;
    }
    getItem(key: string) {
      return this.values.get(key) ?? null;
    }
    setItem(key: string, value: string) {
      if (key === 'quota') throw new Error('QuotaExceededError');
      this.values.set(key, value);
    }
    removeItem(key: string) {
      this.values.delete(key);
    }
    clear() {
      this.values.clear();
    }
  }
  const xhrOpen = jest.fn();
  class Xhr {}
  Object.defineProperty(Xhr.prototype, 'open', {
    configurable: true,
    writable: true,
    value: xhrOpen,
  });
  const observers: { callback: (records: any[]) => void }[] = [];
  class Observer {
    constructor(readonly callback: (records: any[]) => void) {
      observers.push(this);
    }
    observe() {}
  }
  const nativeFetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ allowed: true }),
    }),
  );
  const info = jest.fn();
  const history = {
    state: null as unknown,
    pushState: jest.fn(function (data: unknown, _unused: string, url?: string) {
      history.state = data;
      if (url) location.href = new URL(url, location.href).href;
    }),
    replaceState: jest.fn(),
  };
  const window: any = {
    location,
    history,
    fetch: nativeFetch,
    open: jest.fn(),
    localStorage: new Storage(options.local),
    sessionStorage: new Storage(),
    frameElement: options.frame ?? null,
    addEventListener: listen,
    setInterval: jest.fn(),
    HTMLIFrameElement: IFrame,
    crypto: { randomUUID: () => `diagnostic-${++browserId}` },
  };
  window.parent = options.parent?.window ?? window;
  window.top = options.parent?.window.top ?? window;
  const document = {
    readyState: 'loading',
    addEventListener: listen,
    querySelectorAll: () => [],
  };
  class StackError extends Error {
    stack = `Error\n at select (${ORIGIN}/app/wrapper/main.bundle.js?access_token=STACK_SECRET#id_token=STACK_FRAGMENT:12:34)`;
  }
  const sandbox = {
    window,
    document,
    history,
    console: { info },
    URL,
    Request,
    Error: StackError,
    XMLHttpRequest: Xhr,
    Element,
    HTMLIFrameElement: IFrame,
    Storage,
    MutationObserver: Observer,
  };
  function install(enabled = true, onlyDiagnostics = false) {
    const config = new ConfigService({
      PLATFORM_URL: UPSTREAM,
      AMPP_PROXY_BROWSER_DIAGNOSTICS: enabled ? 'true' : 'false',
    });
    const html = new AmppResponseRewriterService(config)
      .rewrite(contextId, ORIGIN, {
        status: 200,
        url: UPSTREAM + path,
        headers: { 'content-type': 'text/html' },
        body: Buffer.from('<html><head></head></html>'),
      })
      .body.toString();
    const scripts = onlyDiagnostics
      ? [createAmppBrowserDiagnosticsScript(contextId)]
      : [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map(
          (match) => match[0],
        );
    for (const script of scripts)
      runInNewContext(
        script.replace(/^<script[^>]*>|<\/script>$/g, ''),
        sandbox,
      );
    return html;
  }
  return {
    window,
    location,
    history,
    info,
    install,
    nativeFetch,
    xhrOpen,
    observers,
    frame: () => new IFrame(),
    xhr: () => Object.create(Xhr.prototype) as XMLHttpRequest,
    events: () =>
      info.mock.calls.map(([text]: [string]) =>
        JSON.parse(text.replace('[AMPP GVUI diagnostics] ', '')),
      ),
    dispatch: (name: string, event: any = {}) =>
      listeners.get(name)?.forEach((fn) => fn(event)),
  };
}
let browserId = 0;

describe('temporary GVUI browser diagnostics', () => {
  it('is opt-in, follows the production bootstrap, and leaves standalone pages alone', () => {
    const disabled = browser();
    expect(disabled.install(false)).not.toContain(
      'data-ampp-proxy-diagnostics',
    );
    expect(disabled.info).not.toHaveBeenCalled();
    const standalone = browser(WORKLOADS[0]);
    const fetch = standalone.window.fetch;
    standalone.install(true, true);
    expect(standalone.window.fetch).toBe(fetch);
    expect(standalone.window.__AMPP_GVUI_DIAGNOSTICS__).toBeUndefined();
    const top = browser();
    const html = top.install();
    expect(html.indexOf('data-ampp-proxy-bootstrap')).toBeLessThan(
      html.indexOf('data-ampp-proxy-diagnostics'),
    );
    expect(top.events()[0].event).toBe('document');
  });

  it.each(
    WORKLOADS.map((intended, index) => [
      intended,
      WORKLOADS[(index + 1) % WORKLOADS.length],
    ]),
  )(
    'records a substitution from %s to %s without changing the request',
    async (intended, selected) => {
      const top = browser();
      top.install();
      const frame = top.frame();
      frame.src = UPSTREAM + wrapper(intended);
      const child = browser(intended, { parent: top, frame });
      child.install();
      const url = `${UPSTREAM}/discovery/api/v1/services?instance=${selected}`;
      const init = { headers: { Authorization: 'Bearer REQUEST_SECRET' } };
      const response = await child.window.fetch(url, init);
      expect(response).toMatchObject({ ok: true });
      expect(child.nativeFetch).toHaveBeenCalledWith(
        `${ORIGIN}/api/ampp-proxy/api/${intended}/discovery/api/v1/services?instance=${selected}`,
        init,
      );
      expect(
        child.events().find((event) => event.event === 'fetch'),
      ).toMatchObject({
        intendedWorkloadId: intended,
        contextId: intended,
        differentWorkload: true,
        url: { workloadId: selected },
        stack: [{ line: '12', column: '34' }],
      });
      expect(JSON.stringify(child.info.mock.calls)).not.toContain(
        'REQUEST_SECRET',
      );
    },
  );

  it('retains intent and frame identity across callbacks and incorrectly re-scoped inner documents', () => {
    const [intended, selected] = WORKLOADS;
    const top = browser();
    top.install();
    const outer = top.frame();
    outer.setAttribute('src', UPSTREAM + wrapper(intended));
    const first = browser(intended, { parent: top, frame: outer });
    first.install();
    const callback = browser(intended, {
      parent: top,
      frame: outer,
      path: `/app/wrapper/embedded/callback/embedded/single/GV.AMPP.Apps.Test/${intended}`,
    });
    callback.install();
    const before = first.window.__AMPP_GVUI_DIAGNOSTICS__;
    const after = callback.window.__AMPP_GVUI_DIAGNOSTICS__;
    expect(after.frame.frameId).toBe(before.frame.frameId);
    expect(after.documentId).not.toBe(before.documentId);
    const inner = callback.frame();
    inner.src = `${UPSTREAM}/mocha/application/${selected}/embedded/`;
    expect(inner.src).toBe(
      proxy(selected, `/mocha/application/${selected}/embedded/`),
    );
    const application = browser(selected, {
      parent: callback,
      frame: inner,
      path: `/mocha/application/${selected}/embedded/`,
    });
    application.install();
    expect(application.events()[0]).toMatchObject({
      intendedWorkloadId: intended,
      contextId: selected,
    });
    expect(
      callback.events().find((event) => event.event === 'iframe.src'),
    ).toMatchObject({
      targetIntendedWorkloadId: intended,
      differentWorkload: true,
      url: { workloadId: selected },
    });
    outer.src = UPSTREAM + wrapper(selected);
    expect(
      top.window.__AMPP_GVUI_DIAGNOSTICS__.state.frames.get(outer)
        .intendedWorkloadId,
    ).toBe(intended);
  });

  it('observes parser-created frames and their actual loaded URL', () => {
    const top = browser();
    top.install();
    const frame = top.frame();
    frame.attributes.set('src', proxy(WORKLOADS[0], wrapper(WORKLOADS[0])));
    top.observers[0].callback([{ type: 'childList', addedNodes: [frame] }]);
    frame.contentWindow = {
      location: new URL(
        proxy(WORKLOADS[1], `/mocha/application/${WORKLOADS[1]}/embedded/`),
      ),
    };
    top.dispatch('load', { target: frame });
    expect(
      top.events().find((event) => event.event === 'iframe.load'),
    ).toMatchObject({
      targetIntendedWorkloadId: WORKLOADS[0],
      differentWorkload: true,
    });
  });

  it('records storage, navigation and message references without exposing credentials or invoking getters', () => {
    const top = browser();
    top.install();
    const frame = top.frame();
    frame.src = UPSTREAM + wrapper(WORKLOADS[0]);
    const local = new Map([
      [
        'auth-route-private-key',
        JSON.stringify({
          selected: WORKLOADS[0],
          access_token: 'STORED_SECRET',
        }),
      ],
    ]);
    const child = browser(WORKLOADS[0], { parent: top, frame, local });
    child.install();
    const storage = child.window.localStorage;
    expect(storage.getItem('auth-route-private-key')).toBe(
      local.get('auth-route-private-key'),
    );
    storage.setItem('selectedWorkload', WORKLOADS[0]);
    expect(local.get('selectedWorkload')).toBe(WORKLOADS[0]);
    expect(() => storage.setItem('quota', 'value')).toThrow(
      'QuotaExceededError',
    );
    storage.removeItem('selectedWorkload');
    expect(storage.getItem('selectedWorkload')).toBeNull();
    storage.setItem('access_token', 'TOKEN_SECRET');
    const getter = jest.fn();
    const toJSON = jest.fn();
    const message = {
      workloadId: WORKLOADS[0],
      access_token: 'MESSAGE_SECRET',
      toJSON,
      get secret() {
        getter();
        return 'GETTER_SECRET';
      },
    };
    child.dispatch('message', { data: message, source: top.window });
    child.dispatch('storage', {
      storageArea: storage,
      key: 'auth-route-private-key',
      oldValue: WORKLOADS[0],
      newValue: 'STORAGE_EVENT_SECRET',
    });
    const route = proxy(WORKLOADS[0], wrapper(WORKLOADS[0]));
    const auth = `${ORIGIN}/identity/connect/authorize?access_token=QUERY_SECRET&redirect_uri=${encodeURIComponent(route + '#id_token=FRAGMENT_SECRET')}&state=${encodeURIComponent(JSON.stringify({ to: route, secret: 'STATE_SECRET' }))}`;
    const xhr = child.xhr();
    xhr.open('GET', auth, true, 'USER_SECRET', 'PASSWORD_SECRET');
    expect(child.xhrOpen).toHaveBeenCalledWith(
      'GET',
      expect.any(String),
      true,
      'USER_SECRET',
      'PASSWORD_SECRET',
    );
    const data = { token: 'HISTORY_SECRET' };
    child.history.pushState(data, '', auth);
    expect(child.history.state).toBe(data);
    const events = child.events();
    expect(events.find((event) => event.event === 'xhr').url).toMatchObject({
      redirect: { workloadId: WORKLOADS[0] },
      restore: { workloadId: WORKLOADS[0] },
    });
    expect(
      events.find((event) => event.event === 'storage.initial'),
    ).toMatchObject({ area: 'local', workloadIds: [WORKLOADS[0]] });
    expect(
      events.find((event) => event.event === 'message.received'),
    ).toMatchObject({ workloadIds: [WORKLOADS[0]] });
    const initial = events.find((event) => event.event === 'storage.initial');
    expect(
      events.find((event) => event.event === 'storage.getItem').keyId,
    ).toBe(initial.keyId);
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(
      JSON.stringify([...top.info.mock.calls, ...child.info.mock.calls]),
    ).not.toMatch(/SECRET|FRAGMENT/);
    expect(JSON.stringify(child.info.mock.calls)).not.toContain(
      'auth-route-private-key',
    );
    storage.clear();
    expect(local.size).toBe(0);
  });

  it('works without secure-context UUIDs and survives unavailable storage and console failures', async () => {
    const top = browser();
    delete top.window.crypto;
    Object.defineProperty(top.window, 'localStorage', {
      get() {
        throw new Error('denied');
      },
    });
    top.install();
    expect(
      top.events().some((event) => event.event === 'storage.unavailable'),
    ).toBe(true);
    top.info.mockImplementation(() => {
      throw new Error('console failed');
    });
    const url = `${UPSTREAM}/discovery/api/v1/services?instance=${WORKLOADS[0]}`;
    await expect(top.window.fetch(url)).resolves.toMatchObject({ ok: true });
    const failure = new Error('native fetch failure');
    top.nativeFetch.mockRejectedValueOnce(failure);
    await expect(top.window.fetch(url)).rejects.toBe(failure);
  });

  it('keeps a bounded in-memory log without writing diagnostic state to storage', () => {
    const top = browser();
    top.install();
    for (let i = 0; i < 3005; i++) top.dispatch('pageshow');
    const records = top.window.__AMPP_GVUI_DIAGNOSTICS__.state.records;
    expect(records).toHaveLength(3000);
    expect(Number(records[2999].sequence)).toBeGreaterThan(
      Number(records[0].sequence),
    );
    expect(top.window.localStorage.length).toBe(0);
    expect(top.window.sessionStorage.length).toBe(0);
  });
});
