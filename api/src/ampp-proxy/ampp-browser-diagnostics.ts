/* eslint-disable @typescript-eslint/unbound-method -- Native methods are saved
 * and invoked with their original receiver by the diagnostic wrappers. */
// Temporary GVUI diagnostics. This function is serialized into the browser;
// keep all runtime dependencies inside it so the module can be removed intact.
function installAmppBrowserDiagnostics(contextId: string): void {
  type Frame = {
    frameId: string;
    parentFrameId?: string;
    intendedWorkloadId?: string;
  };
  type State = {
    runId: string;
    sequence: number;
    frames: WeakMap<HTMLIFrameElement, Frame>;
    workloadIds: Set<string>;
    records: Record<string, unknown>[];
  };
  type DiagnosticWindow = Window & {
    __AMPP_GVUI_DIAGNOSTICS__?: {
      state: State;
      frame: Frame;
      documentId: string;
    };
  };
  type UrlInfo = {
    path: string;
    proxyContext?: string;
    workloadId?: string;
    redirect?: UrlInfo;
    restore?: UrlInfo;
    route?: UrlInfo;
  };

  const top = window.top as DiagnosticWindow;
  if (
    !/^\/api\/ampp-proxy\/ui\/gvui-[0-9a-f-]{36}\//i.test(
      top.location.pathname,
    ) ||
    (window as DiagnosticWindow).__AMPP_GVUI_DIAGNOSTICS__
  )
    return;
  const uuid = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi;
  const isId = (value: string) =>
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
  const id = () =>
    window.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const parent = (window.parent as DiagnosticWindow).__AMPP_GVUI_DIAGNOSTICS__;
  const state: State = top.__AMPP_GVUI_DIAGNOSTICS__?.state ?? {
    runId: id(),
    sequence: 0,
    frames: new WeakMap(),
    workloadIds: new Set(),
    records: [],
  };

  // URLs expose only route segments and workload references, never query/hash
  // contents. In particular, OAuth tokens, nonce and state are not logged raw.
  function urlInfo(value: unknown, depth = 0): UrlInfo | undefined {
    if (typeof value !== 'string') return undefined;
    try {
      const url = new URL(value, window.location.href);
      const path = url.pathname.replace(
        /^\/api\/ampp-proxy\/(?:ui|api|ws)\/[^/]+/i,
        '',
      );
      const target =
        path.match(
          /\/(?:single\/[^/]+|mocha\/application|cluster\/state\/api\/v1\/workload)\/([0-9a-f-]{36})(?:\/|$)/i,
        )?.[1] ??
        ['instance', 'parentId', 'workloadId', 'workload_id']
          .map((key) => url.searchParams.get(key))
          .find((value) => value && isId(value));
      const workloadId =
        target && isId(target) ? target.toLowerCase() : undefined;
      const proxyContext = url.pathname.match(
        /^\/api\/ampp-proxy\/(?:ui|api|ws)\/((?:gvui-)?[0-9a-f-]{36})(?:\/|$)/i,
      )?.[1];
      const safePath = url.pathname
        .split('/')
        .map((segment) =>
          isId(segment) ||
          /^gvui-[0-9a-f-]{36}$/i.test(segment) ||
          /^(?:api|ampp-proxy|ui|ws|app|wrapper|single|embedded|callback|mocha|application|cluster|state|v1|workload|workloads|discovery|services|identity|connect|authorize|gvui|desktop|refresh|dist|main\.bundle\.js|vendor\.bundle\.js)$/.test(
            segment,
          ) ||
          /^GV\.AMPP\.[\w.]+$/.test(segment) ||
          !segment
            ? segment
            : ':segment',
        )
        .join('/');
      let redirect: UrlInfo | undefined;
      let restore: UrlInfo | undefined;
      let route: UrlInfo | undefined;
      if (depth === 0) {
        redirect = urlInfo(url.searchParams.get('redirect_uri'), 1);
        if (url.hash.startsWith('#/')) route = urlInfo(url.hash.slice(1), 1);
        try {
          const saved = JSON.parse(url.searchParams.get('state') ?? 'null') as {
            to?: unknown;
          } | null;
          restore = urlInfo(saved?.to, 1);
        } catch {
          /* Non-JSON OAuth state is intentionally omitted. */
        }
      }
      return {
        path: safePath,
        proxyContext,
        workloadId,
        redirect,
        restore,
        route,
      };
    } catch {
      return undefined;
    }
  }

  function registerFrame(element: HTMLIFrameElement, value: unknown): Frame {
    let entry = state.frames.get(element);
    if (!entry) {
      entry = { frameId: id(), parentFrameId: frame.frameId };
      state.frames.set(element, entry);
    }
    entry.intendedWorkloadId ??=
      frame.intendedWorkloadId ?? urlInfo(value)?.workloadId;
    if (entry.intendedWorkloadId)
      state.workloadIds.add(entry.intendedWorkloadId);
    return entry;
  }

  // Frame identity lives on its DOM element, surviving its document/callback
  // reloads. Inner application frames inherit their wrapper's original intent.
  const element = window.frameElement as HTMLIFrameElement | null;
  const frame: Frame = element
    ? (state.frames.get(element) ?? {
        frameId: id(),
        parentFrameId: parent?.frame.frameId,
      })
    : { frameId: id() };
  if (element) state.frames.set(element, frame);
  if (element)
    frame.intendedWorkloadId ??=
      parent?.frame.intendedWorkloadId ??
      urlInfo(element.getAttribute('src'))?.workloadId ??
      (isId(contextId) ? contextId.toLowerCase() : undefined);
  if (frame.intendedWorkloadId) state.workloadIds.add(frame.intendedWorkloadId);
  const documentId = id();
  Object.defineProperty(window, '__AMPP_GVUI_DIAGNOSTICS__', {
    configurable: true,
    value: { state, frame, documentId },
  });

  // Extract only already observed workload IDs. Do not serialize storage/message
  // values or invoke application getters/toJSON while examining objects.
  function references(
    value: unknown,
    depth = 0,
    seen = new Set<object>(),
  ): string[] {
    if (typeof value === 'string') {
      const matches: string[] = value.match(uuid) ?? [];
      return [
        ...new Set(
          matches
            .map((value) => value.toLowerCase())
            .filter((value) => state.workloadIds.has(value)),
        ),
      ];
    }
    if (!value || typeof value !== 'object' || depth >= 3 || seen.has(value))
      return [];
    seen.add(value);
    return [
      ...new Set(
        Object.entries(Object.getOwnPropertyDescriptors(value))
          .slice(0, 50)
          .filter(
            ([key, descriptor]) =>
              'value' in descriptor &&
              !/token|password|secret|credential|cookie|authorization|nonce|^code$|^sid$/i.test(
                key,
              ),
          )
          .flatMap(([, descriptor]) =>
            references(descriptor.value, depth + 1, seen),
          ),
      ),
    ];
  }

  function emit(
    event: string,
    details: Record<string, unknown> = {},
    trace = false,
  ) {
    try {
      const stack = trace
        ? (new Error().stack?.match(/https?:\/\/[^\s)]+/g) ?? [])
            .slice(0, 8)
            .map((value) => {
              const location = value.match(/:(\d+):(\d+)$/);
              return {
                source: urlInfo(
                  location ? value.slice(0, -location[0].length) : value,
                )?.path,
                line: location?.[1],
                column: location?.[2],
              };
            })
        : undefined;
      const record = {
        time: new Date().toISOString(),
        sequence: ++state.sequence,
        runId: state.runId,
        ...frame,
        documentId,
        contextId,
        event,
        ...details,
        stack,
      };
      state.records.push(record);
      if (state.records.length > 3000) state.records.shift();
      console.info('[AMPP GVUI diagnostics] ' + JSON.stringify(record));
    } catch {
      /* Diagnostics must not prevent an application operation. */
    }
  }

  function observeUrl(
    event: string,
    value: unknown,
    extra: Record<string, unknown> = {},
  ) {
    try {
      const url = urlInfo(value);
      if (!url) return;
      emit(
        event,
        {
          url,
          differentWorkload: !!(
            frame.intendedWorkloadId &&
            url.workloadId &&
            frame.intendedWorkloadId !== url.workloadId
          ),
          ...extra,
        },
        true,
      );
    } catch {
      /* Preserve native behavior even if diagnostics fail. */
    }
  }

  observeUrl('document', window.location.href);
  const fetch = window.fetch;
  window.fetch = function (input, init) {
    const value =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input;
    // Only workload/bootstrap traffic; avoid logging periodic polls and assets.
    if (
      urlInfo(value)?.workloadId ||
      (typeof value === 'string' &&
        /\/identity\/connect\/authorize/.test(value))
    )
      observeUrl('fetch', value);
    return Reflect.apply(fetch, this, [input, init]);
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    ...options: unknown[]
  ): void {
    const value = url instanceof URL ? url.href : url;
    if (
      urlInfo(value)?.workloadId ||
      (typeof value === 'string' &&
        /\/identity\/connect\/authorize/.test(value))
    )
      observeUrl('xhr', value);
    Reflect.apply(open, this, [method, url, ...options]);
  };

  function observeFrame(
    element: HTMLIFrameElement,
    value: unknown,
    operation: string,
  ) {
    try {
      const target = registerFrame(element, value);
      observeUrl('iframe.' + operation, value, {
        targetFrameId: target.frameId,
        targetIntendedWorkloadId: target.intendedWorkloadId,
        differentWorkload: !!(
          target.intendedWorkloadId &&
          urlInfo(value)?.workloadId &&
          target.intendedWorkloadId !== urlInfo(value)?.workloadId
        ),
      });
    } catch {
      /* Do not interfere with frame navigation. */
    }
  }
  const src = Object.getOwnPropertyDescriptor(
    HTMLIFrameElement.prototype,
    'src',
  );
  if (src?.set && src.configurable)
    Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
      ...src,
      set(this: HTMLIFrameElement, value: string) {
        observeFrame(this, value, 'src');
        src.set.call(this, value);
      },
    });
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (this: Element, name, value): void {
    if (
      this instanceof HTMLIFrameElement &&
      typeof name === 'string' &&
      name.toLowerCase() === 'src'
    )
      observeFrame(this, value, 'setAttribute');
    setAttribute.call(this, name, value);
  };
  const scanFrames = (root: ParentNode) =>
    root
      .querySelectorAll('iframe')
      .forEach((element) =>
        observeFrame(element, element.getAttribute('src'), 'observed'),
      );
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (
        record.type === 'attributes' &&
        record.target instanceof HTMLIFrameElement
      )
        observeFrame(
          record.target,
          record.target.getAttribute('src'),
          'observed',
        );
      for (const node of record.addedNodes) {
        if (node instanceof HTMLIFrameElement)
          observeFrame(node, node.getAttribute('src'), 'inserted');
        if (node instanceof Element) scanFrames(node);
      }
    }
  });
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });
  scanFrames(document);
  document.addEventListener(
    'load',
    (event) => {
      if (event.target instanceof HTMLIFrameElement) {
        const element = event.target;
        try {
          observeFrame(element, element.contentWindow?.location.href, 'load');
        } catch {
          emit('iframe.load.unavailable', {
            targetFrameId: state.frames.get(element)?.frameId,
          });
        }
      }
    },
    true,
  );

  for (const operation of ['pushState', 'replaceState'] as const) {
    const native = history[operation];
    history[operation] = function (...args: Parameters<typeof native>) {
      const result = Reflect.apply(native, this, args);
      observeUrl('history.' + operation, window.location.href);
      return result;
    };
  }
  for (const event of ['pageshow', 'pagehide', 'popstate', 'hashchange'])
    window.addEventListener(event, () =>
      observeUrl(event, window.location.href),
    );

  // Stable fingerprints correlate keys across frames without disclosing keys or
  // values, either of which can contain credentials. Diagnostics never write here.
  function storageInfo(
    area: string,
    operation: string,
    key: unknown,
    value?: unknown,
  ) {
    try {
      if (typeof key !== 'string') return;
      const secret =
        /token|password|secret|credential|cookie|authorization|nonce/i.test(
          key,
        );
      const workloadIds = secret ? [] : references(value);
      if (
        !workloadIds.length &&
        !/workload|select|rout|navigation|auth|oidc|state|token/i.test(key)
      )
        return;
      let hash = 2166136261;
      for (let i = 0; i < key.length; i++)
        hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
      emit(
        'storage.' + operation,
        { area, keyId: (hash >>> 0).toString(16), workloadIds },
        operation !== 'initial',
      );
    } catch {
      /* Preserve storage return values and exceptions. */
    }
  }
  try {
    const local = window.localStorage,
      session = window.sessionStorage;
    const get = Storage.prototype.getItem;
    for (const [area, storage] of [
      ['local', local],
      ['session', session],
    ] as const) {
      for (let i = 0; i < Math.min(storage.length, 100); i++) {
        const key = storage.key(i);
        if (key !== null)
          storageInfo(area, 'initial', key, get.call(storage, key));
      }
    }
    for (const operation of [
      'getItem',
      'setItem',
      'removeItem',
      'clear',
    ] as const) {
      const native = Storage.prototype[operation];
      Object.defineProperty(Storage.prototype, operation, {
        configurable: true,
        writable: true,
        value: function (this: Storage, ...args: string[]) {
          const result: unknown = Reflect.apply(native, this, args);
          const area =
            this === local ? 'local' : this === session ? 'session' : 'other';
          if (operation === 'clear') emit('storage.clear', { area }, true);
          else
            storageInfo(
              area,
              operation,
              args[0],
              operation === 'getItem' ? result : args[1],
            );
          return result;
        },
      });
    }
    window.addEventListener('storage', (event) =>
      storageInfo(
        event.storageArea === local ? 'local' : 'session',
        'event',
        event.key,
        { previous: event.oldValue, current: event.newValue },
      ),
    );
  } catch {
    emit('storage.unavailable');
  }
  window.addEventListener('message', (event) => {
    try {
      const workloadIds = references(event.data);
      if (!workloadIds.length) return;
      let sourceFrameId: string | undefined;
      try {
        sourceFrameId = (event.source as DiagnosticWindow | null)
          ?.__AMPP_GVUI_DIAGNOSTICS__?.frame.frameId;
      } catch {
        /* Cross-origin sources are not inspected. */
      }
      emit('message.received', { sourceFrameId, workloadIds });
    } catch {
      /* Never serialize arbitrary message payloads. */
    }
  });
}

export function createAmppBrowserDiagnosticsScript(contextId: string): string {
  return `<script data-ampp-proxy-diagnostics>try{(${installAmppBrowserDiagnostics.toString()})(${JSON.stringify(contextId)});}catch{console.info('[AMPP GVUI diagnostics] setup failed');}</script>`;
}
