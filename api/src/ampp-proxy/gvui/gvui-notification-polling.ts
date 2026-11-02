// Serialized before the URL-rewriting bootstrap so both transports see the
// rewritten, same-origin notification URL. This function must be self-contained.
function protectNotificationPolling(apiProxyPath: string): void {
  type Poll = { failures: number; nextAt: number; stopped: boolean };
  const polls = new Map<string, Poll>();
  const prefix = `${apiProxyPath}/notifications/api/v1/notifications/`;
  const keyFor = (method: string, value: string | URL): string | undefined => {
    if (method.toUpperCase() !== 'GET') return;
    try {
      const url = new URL(String(value), window.location.href);
      if (
        url.origin === window.location.origin &&
        url.pathname.startsWith(prefix) &&
        /^[^/]+\/?$/.test(url.pathname.slice(prefix.length))
      )
        return url.pathname.replace(/\/$/, '');
    } catch {
      // Leave malformed URLs to the native transport.
    }
  };
  const pollFor = (key: string): Poll => {
    let poll = polls.get(key);
    if (!poll) {
      poll = { failures: 0, nextAt: 0, stopped: false };
      polls.set(key, poll);
    }
    return poll;
  };
  const completed = (poll: Poll, status: number): void => {
    if (status >= 200 && status < 300) {
      poll.failures = 0;
      poll.nextAt = 0;
      return;
    }
    poll.failures++;
    poll.stopped ||=
      [401, 403, 404, 410].includes(status) || poll.failures >= 6;
    const delay = Math.min(30000, 1000 * 2 ** (poll.failures - 1));
    poll.nextAt =
      Date.now() +
      Math.min(30000, Math.round(delay * (0.8 + Math.random() * 0.4)));
    if (
      poll.stopped &&
      !document.getElementById('ampp-gvui-notification-error')
    ) {
      const notice = document.createElement('p');
      notice.id = 'ampp-gvui-notification-error';
      notice.setAttribute('role', 'alert');
      notice.textContent =
        'GV.UI notifications have stopped. Reopen the layout from the application to reconnect.';
      notice.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:2147483647;margin:0;padding:12px;background:#fff3cd;color:#332701;';
      (document.body ?? document.documentElement).appendChild(notice);
    }
  };
  const waitForPoll = (
    poll: Poll,
    signal?: AbortSignal | null,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      let timer: number | undefined;
      const abort = () => {
        window.clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        // Fetch must preserve arbitrary caller-supplied AbortSignal reasons.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      const ready = () => {
        // A terminal poll stays pending until cancellation. Returning another
        // immediate rejection here would let an upstream retry loop spin again.
        if (poll.stopped) return;
        const remaining = poll.nextAt - Date.now();
        if (remaining > 0) timer = window.setTimeout(ready, remaining);
        else {
          signal?.removeEventListener('abort', abort);
          resolve();
        }
      };
      if (signal?.aborted) abort();
      else {
        signal?.addEventListener('abort', abort, { once: true });
        ready();
      }
    });

  const nativeFetch = window.fetch.bind(window) as typeof window.fetch;
  window.fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const request = input instanceof Request ? input : undefined;
    const key = keyFor(
      init?.method ?? request?.method ?? 'GET',
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (!key) return nativeFetch(input, init);
    const poll = pollFor(key);
    const signal = init?.signal ?? request?.signal;
    await waitForPoll(poll, signal);
    try {
      const response = await nativeFetch(input, init);
      completed(poll, response.status);
      return response;
    } catch (error) {
      if (!signal?.aborted) completed(poll, 0);
      throw error;
    }
  };

  type Pending = {
    key?: string;
    async: boolean;
    sent: boolean;
    done: boolean;
    aborted: boolean;
    waiting: boolean;
    timer?: number;
  };
  const pending = new WeakMap<XMLHttpRequest, Pending>();
  const observed = new WeakSet<XMLHttpRequest>();
  // Native methods below are always invoked with the original XHR receiver.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const nativeOpen = XMLHttpRequest.prototype.open;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const nativeSend = XMLHttpRequest.prototype.send;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const nativeAbort = XMLHttpRequest.prototype.abort;
  const cancel = (xhr: XMLHttpRequest) => {
    const request = pending.get(xhr);
    if (request) {
      request.aborted = true;
      window.clearTimeout(request.timer);
    }
  };
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...args: unknown[]
  ): void {
    cancel(this);
    Reflect.apply(nativeOpen, this, [method, url, ...args]);
    pending.set(this, {
      key: keyFor(method, url),
      async: args[0] === undefined || Boolean(args[0]),
      sent: false,
      done: false,
      aborted: false,
      waiting: false,
    });
    if (!observed.has(this)) {
      observed.add(this);
      this.addEventListener(
        'readystatechange',
        () => {
          const request = pending.get(this);
          if (
            this.readyState === 4 &&
            request?.key &&
            request.sent &&
            !request.done &&
            !request.aborted
          ) {
            request.done = true;
            completed(pollFor(request.key), this.status);
          }
        },
        true,
      );
    }
  };
  XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const request = pending.get(this);
    // Synchronous XHR cannot be delayed without changing its public contract.
    if (!request?.key || !request.async) {
      nativeSend.call(this, body);
      return;
    }
    if (request.sent || request.waiting)
      throw new DOMException(
        'The request has already been sent',
        'InvalidStateError',
      );
    const poll = pollFor(request.key);
    request.waiting = true;
    const send = () => {
      if (request.aborted || pending.get(this) !== request || poll.stopped)
        return;
      const remaining = poll.nextAt - Date.now();
      if (remaining > 0) request.timer = window.setTimeout(send, remaining);
      else {
        request.waiting = false;
        request.sent = true;
        nativeSend.call(this, body);
      }
    };
    send();
  };
  XMLHttpRequest.prototype.abort = function (this: XMLHttpRequest): void {
    const request = pending.get(this);
    const queued = request?.waiting && !request.aborted;
    cancel(this);
    nativeAbort.call(this);
    if (queued) {
      this.dispatchEvent(new ProgressEvent('abort'));
      this.dispatchEvent(new ProgressEvent('loadend'));
    }
  };
}

export function createGvuiNotificationPollingScript(
  workloadId: string,
  path: string,
): string {
  if (!/^gvui-[0-9a-f-]{36}$/i.test(workloadId) || !path.startsWith('/gvui/'))
    return '';
  const apiProxyPath = `/api/ampp-proxy/api/${encodeURIComponent(workloadId)}`;
  return `<script data-ampp-gvui-notification-polling>(${protectNotificationPolling.toString()})(${JSON.stringify(apiProxyPath)});</script>`;
}
