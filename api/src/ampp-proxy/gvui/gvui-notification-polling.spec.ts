import { ConfigService } from '@nestjs/config';
import { runInNewContext } from 'node:vm';
import { AmppResponseRewriterService } from '../ampp-response-rewriter.service';
import { createGvuiNotificationPollingScript } from './gvui-notification-polling';

const LAYOUT = '11111111-1111-4111-8111-111111111111';
const CONTEXT = `gvui-${LAYOUT}`;
const ORIGIN = 'https://proxy.invalid';
const BASE = `/api/ampp-proxy/api/${CONTEXT}`;
const POLL = `${ORIGIN}${BASE}/notifications/api/v1/notifications/mailbox?count=100&timeout=10000`;

function browser(fullBootstrap = false) {
  const fetch = jest
    .fn<typeof globalThis.fetch>()
    .mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
  const send = jest.fn();
  class Xhr extends EventTarget {
    readyState = 0;
    status = 0;
    method = '';
    url: string | URL = '';
    async = true;
    open(method: string, url: string | URL, async = true) {
      this.method = method;
      this.url = url;
      this.async = async;
      this.readyState = 1;
    }
    send(body?: unknown) {
      send(this, body);
    }
    abort() {
      this.readyState = 0;
    }
    complete(status: number) {
      this.status = status;
      this.readyState = 4;
      this.dispatchEvent(new Event('readystatechange'));
      this.dispatchEvent(new Event('loadend'));
    }
  }
  const notices: { id: string; textContent: string }[] = [];
  const window = {
    location: new URL(
      `${ORIGIN}/api/ampp-proxy/ui/${CONTEXT}/gvui/desktop/${LAYOUT}`,
    ),
    fetch: fetch as typeof globalThis.fetch,
    setTimeout,
    clearTimeout,
    setInterval: jest.fn(),
    addEventListener: jest.fn(),
    open: jest.fn(),
  };
  const document = {
    readyState: 'loading',
    addEventListener: jest.fn(),
    getElementById: (id: string) => notices.find((notice) => notice.id === id),
    createElement: () => ({
      id: '',
      textContent: '',
      style: { cssText: '' },
      setAttribute: jest.fn(),
    }),
    body: {
      appendChild: (notice: (typeof notices)[number]) => notices.push(notice),
    },
  };
  const math = Object.create(Math) as Math;
  math.random = () => 0.5;
  const script = fullBootstrap
    ? new AmppResponseRewriterService(
        new ConfigService({ PLATFORM_URL: 'https://ampp.invalid' }),
      )
        .rewrite(CONTEXT, ORIGIN, {
          url: `https://ampp.invalid/gvui/desktop/${LAYOUT}`,
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: Buffer.from('<html><head></head></html>'),
        })
        .body.toString()
    : createGvuiNotificationPollingScript(CONTEXT, '/gvui/desktop/' + LAYOUT);
  class Element {
    setAttribute() {}
  }
  const globals = {
    window,
    document,
    Element,
    XMLHttpRequest: Xhr,
    URL,
    Request,
    DOMException,
    ProgressEvent: Event,
    Date,
    Math: math,
  };
  for (const match of script.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))
    runInNewContext(match[1], globals);
  return { window, fetch, Xhr, send, notices };
}

describe('emitted GVUI notification polling protection', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('executes the complete bootstrap and protects rewritten upstream fetch and XHR URLs', async () => {
    const { window, fetch, Xhr, send } = browser(true);
    const upstream =
      'https://ampp.invalid/notifications/api/v1/notifications/mailbox';
    fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await window.fetch(upstream);
    expect(fetch).toHaveBeenCalledWith(
      `${ORIGIN}${BASE}/notifications/api/v1/notifications/mailbox`,
      undefined,
    );
    const xhr = new Xhr();
    xhr.open('GET', upstream);
    xhr.send();
    await jest.advanceTimersByTimeAsync(120000);
    expect(xhr.url).toBe(
      `${ORIGIN}${BASE}/notifications/api/v1/notifications/mailbox`,
    );
    expect(send).not.toHaveBeenCalled();
    xhr.abort();
  });

  it('injects protection before URL rewriting, exclusively in GVUI layout documents', () => {
    const rewrite = new AmppResponseRewriterService(
      new ConfigService({ PLATFORM_URL: 'https://ampp.invalid' }),
    );
    for (const [context, path, enabled] of [
      [CONTEXT, `/gvui/desktop/${LAYOUT}`, true],
      [CONTEXT, `/gvui/callback/desktop/${LAYOUT}`, true],
      [LAYOUT, `/app/wrapper/single/Test/${LAYOUT}`, false],
      [CONTEXT, '/identity/connect/authorize', false],
    ] as const) {
      const html = rewrite
        .rewrite(context, ORIGIN, {
          url: 'https://ampp.invalid' + path,
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: Buffer.from('<html><head></head></html>'),
        })
        .body.toString();
      const protection = html.indexOf(
        '<script data-ampp-gvui-notification-polling>',
      );
      expect(protection >= 0).toBe(enabled);
      if (enabled)
        expect(protection).toBeLessThan(
          html.indexOf('<script data-ampp-proxy-bootstrap>'),
        );
    }
  });

  it('passes successful polls and unrelated requests without delaying or consuming responses', async () => {
    const { window, fetch } = browser();
    const result = new Response('[{"topic":"test"}]', { status: 200 });
    fetch.mockResolvedValueOnce(result);
    expect(await window.fetch(POLL)).toBe(result);
    expect(await result.json()).toEqual([{ topic: 'test' }]);
    const urls = [
      POLL.replace(CONTEXT, `gvui-${'2'.repeat(36)}`),
      POLL.replace(ORIGIN, 'https://external.invalid'),
      `${ORIGIN}${BASE}/configuration/api/v1/configurations`,
    ];
    for (const url of urls) await window.fetch(url);
    await window.fetch(POLL, { method: 'POST' });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([401, 403, 404, 410])(
    'stops a rejected mailbox after HTTP %s while allowing another mailbox',
    async (status) => {
      const { window, fetch, notices } = browser();
      fetch.mockResolvedValueOnce(new Response(null, { status }));
      expect((await window.fetch(POLL)).status).toBe(status);
      const controller = new AbortController();
      const stopped = window.fetch(POLL + '&different=query', {
        signal: controller.signal,
      });
      const cancelled = expect(stopped).rejects.toMatchObject({
        name: 'AbortError',
      });
      await jest.advanceTimersByTimeAsync(120000);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(notices).toHaveLength(1);
      expect(notices[0].textContent).toContain('Reopen the layout');
      await window.fetch(POLL.replace('/mailbox?', '/new-mailbox?'));
      expect(fetch).toHaveBeenCalledTimes(2);
      controller.abort();
      await cancelled;
    },
  );

  it('backs off transient failures, shares state between query variants, and stops after six failures', async () => {
    const { window, fetch, notices } = browser();
    fetch.mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 503 })),
    );
    for (let i = 0; i < 6; i++) {
      const result = window.fetch(POLL + `&attempt=${i}`);
      if (i) {
        await jest.advanceTimersByTimeAsync(1000 * 2 ** (i - 1) - 1);
        expect(fetch).toHaveBeenCalledTimes(i);
        await jest.advanceTimersByTimeAsync(1);
      }
      await result;
      expect(fetch).toHaveBeenCalledTimes(i + 1);
    }
    expect(notices).toHaveLength(1);
    const controller = new AbortController();
    const stopped = window.fetch(POLL, { signal: controller.signal });
    const cancelled = expect(stopped).rejects.toMatchObject({
      name: 'AbortError',
    });
    await jest.advanceTimersByTimeAsync(300000);
    expect(fetch).toHaveBeenCalledTimes(6);
    controller.abort();
    await cancelled;
  });

  it('resets backoff after success and preserves Request input and cancellation while queued', async () => {
    const { window, fetch } = browser();
    fetch.mockResolvedValueOnce(new Response(null, { status: 502 }));
    await window.fetch(new Request(POLL));
    const controller = new AbortController();
    const cancelled = window.fetch(
      new Request(POLL, { signal: controller.signal }),
    );
    const rejected = expect(cancelled).rejects.toMatchObject({
      name: 'AbortError',
    });
    controller.abort();
    await rejected;
    await jest.advanceTimersByTimeAsync(1000);
    await window.fetch(POLL);
    fetch.mockResolvedValueOnce(new Response(null, { status: 502 }));
    await window.fetch(POLL);
    const next = window.fetch(POLL);
    await jest.advanceTimersByTimeAsync(1000);
    await next;
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('backs off network errors without treating caller cancellation as another failure', async () => {
    const { window, fetch } = browser();
    fetch.mockRejectedValueOnce(new TypeError('Network unavailable'));
    await expect(window.fetch(POLL)).rejects.toThrow('Network unavailable');
    const next = window.fetch(POLL);
    await jest.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await next;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('protects XMLHttpRequest polls, shares fetch backoff, and permits aborting a delayed send', async () => {
    const { window, fetch, Xhr, send } = browser();
    const xhr = new Xhr();
    xhr.open('GET', POLL);
    xhr.send();
    expect(send).toHaveBeenCalledTimes(1);
    xhr.complete(503);
    const next = window.fetch(POLL);
    await jest.advanceTimersByTimeAsync(999);
    expect(fetch).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await next;
    xhr.open('GET', POLL);
    xhr.send();
    xhr.complete(503);
    xhr.open('GET', POLL);
    xhr.send();
    expect(send).toHaveBeenCalledTimes(2);
    const aborted = jest.fn();
    xhr.addEventListener('abort', aborted);
    xhr.abort();
    await jest.advanceTimersByTimeAsync(60000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stops an XHR retry loop before its completion handler can issue more network requests', () => {
    const { Xhr, send, notices } = browser();
    const first = new Xhr();
    first.open('GET', POLL);
    const second = new Xhr();
    first.addEventListener('readystatechange', () => {
      second.open('GET', POLL);
      second.send();
    });
    first.send();
    first.complete(403);
    expect(send).toHaveBeenCalledTimes(1);
    expect(notices).toHaveLength(1);
    second.abort();
  });

  it('cancels a queued send when an XHR instance is reopened for an unrelated request', async () => {
    const { Xhr, send } = browser();
    const xhr = new Xhr();
    xhr.open('GET', POLL);
    xhr.send();
    xhr.complete(502);
    xhr.open('GET', POLL);
    xhr.send();
    xhr.open('POST', `${ORIGIN}${BASE}/notifications/api/v1/mailbox`);
    xhr.send('create');
    await jest.advanceTimersByTimeAsync(60000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(xhr, 'create');
  });
});
