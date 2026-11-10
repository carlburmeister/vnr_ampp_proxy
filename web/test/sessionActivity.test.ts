import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { startSessionActivityTracking } from '../public/session-activity.js';

function tracker(
  t: TestContext,
  responder: (signal: AbortSignal) => Promise<{ status: number }> = () =>
    Promise.resolve({ status: 204 }),
) {
  let now = 100000;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const listeners = new Map<
    string,
    Set<(event: { isTrusted?: boolean }) => void>
  >();
  const target = (prefix: string) => ({
    addEventListener(
      name: string,
      fn: (event: { isTrusted?: boolean }) => void,
    ) {
      const key = prefix + name;
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key)!.add(fn);
    },
    removeEventListener(
      name: string,
      fn: (event: { isTrusted?: boolean }) => void,
    ) {
      listeners.get(prefix + name)?.delete(fn);
    },
  });
  const document = { ...target('document:'), hidden: false };
  const window = {
    ...target('window:'),
    setTimeout(fn: () => void, delay: number) {
      timers.set(++id, { at: now + delay, fn });
      return id;
    },
    clearTimeout(key: number) {
      timers.delete(key);
    },
  };
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { document, window });
  t.mock.method(Date, 'now', () => now);
  const requests: {
    url: string;
    method: string;
    credentials: string;
    signal: AbortSignal;
    body?: unknown;
  }[] = [];
  const stop = startSessionActivityTracking((url, init) => {
    requests.push({ url, ...init });
    return responder(init.signal);
  });
  t.after(async () => {
    stop();
    await flush();
    Object.assign(globalThis, previous);
  });
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  return {
    document,
    requests,
    timers,
    stop,
    flush,
    emit(name = 'pointerdown', trusted = true, prefix = 'document:') {
      for (const fn of listeners.get(prefix + name) ?? [])
        fn({ isTrusted: trusted });
    },
    async advance(ms: number) {
      now += ms;
      for (const [key, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(key);
          timer.fn();
        }
      await flush();
    },
  };
}

test('idle polls, synthetic events and programmatic scrolling do not report interaction', async (t) => {
  const activity = tracker(t);
  activity.emit('pointerdown', false);
  activity.emit('scroll');
  activity.emit('focus');
  await activity.advance(120000);
  assert.equal(activity.requests.length, 0);
  assert.equal(activity.timers.size, 0);
});

test('trusted interaction sends immediately, then coalesces events with one trailing notification', async (t) => {
  const activity = tracker(t);
  activity.emit();
  await activity.flush();
  assert.equal(activity.requests.length, 1);
  assert.equal(activity.requests[0].url, '/api/auth/activity');
  assert.equal(activity.requests[0].method, 'POST');
  assert.equal(activity.requests[0].credentials, 'include');
  assert.equal(activity.requests[0].body, undefined);
  await activity.advance(1000);
  activity.emit('keydown');
  activity.emit('wheel');
  activity.emit('touchstart');
  await activity.advance(28999);
  assert.equal(activity.requests.length, 1);
  await activity.advance(1);
  assert.equal(activity.requests.length, 2);
  await activity.advance(120000);
  assert.equal(activity.requests.length, 2);
  activity.emit();
  assert.equal(activity.requests.length, 3);
});

test('temporary errors wait for fresh interaction instead of retrying while idle', async (t) => {
  const activity = tracker(t, () => Promise.reject(new Error('offline')));
  activity.emit();
  await activity.flush();
  await activity.advance(120000);
  assert.equal(activity.requests.length, 1);
  activity.emit();
  assert.equal(activity.requests.length, 2);
});

test('a rejected session stops reporting and cleanup cancels pending work', async (t) => {
  const activity = tracker(t, () => Promise.resolve({ status: 401 }));
  activity.emit();
  await activity.flush();
  await activity.advance(60000);
  activity.emit();
  assert.equal(activity.requests.length, 1);
  assert.equal(activity.timers.size, 0);
});

test('hidden tabs and pagehide discard queued interaction; resume does not invent activity', async (t) => {
  const activity = tracker(t);
  activity.emit();
  await activity.flush();
  activity.emit();
  activity.document.hidden = true;
  activity.emit('visibilitychange');
  await activity.advance(30000);
  activity.emit();
  assert.equal(activity.requests.length, 1);
  activity.document.hidden = false;
  activity.emit('visibilitychange');
  assert.equal(activity.requests.length, 1);
  activity.emit();
  await activity.flush();
  activity.emit();
  activity.emit('pagehide', true, 'window:');
  await activity.advance(30000);
  assert.equal(activity.requests.length, 2);
  activity.emit('pageshow', true, 'window:');
  activity.emit();
  assert.equal(activity.requests.length, 3);
});

test('a hanging request times out without overlap and logout cleanup aborts the next request', async (t) => {
  const activity = tracker(
    t,
    (signal) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  );
  activity.emit();
  activity.emit('keydown');
  assert.equal(activity.requests.length, 1);
  await activity.advance(10000);
  assert.equal(activity.requests[0].signal.aborted, true);
  await activity.advance(20000);
  assert.equal(activity.requests.length, 2);
  assert.equal(activity.requests[1].signal.aborted, false);
  activity.stop();
  await activity.flush();
  assert.equal(activity.requests[1].signal.aborted, true);
  await activity.advance(60000);
  assert.equal(activity.requests.length, 2);
  assert.equal(activity.timers.size, 0);
});
