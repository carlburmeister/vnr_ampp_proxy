import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { appHarness } from './helpers/appHarness.mjs';
import { getCurrentSession } from '../src/services/amppSessionApi.ts';

const session = () => ({
  user: { id: 'test-user', username: 'test', displayName: 'Test', clientId: 1, userType: 'user' },
  allowedWorkloads: [], allowedDashboards: [], expiresAt: Date.now() + 8 * 60 * 60 * 1000,
});

async function signedIn(t: TestContext) {
  const app = appHarness();
  t.after(() => app.unmount());
  await app.flush();
  app.requests.at(-1)!.resolve(session());
  await app.flush();
  assert.ok(app.find('UserHomePage'));
  return app;
}

test('a visible poll detecting expiry replaces protected UI with login', async (t) => {
  const app = await signedIn(t);
  app.poll();
  app.requests.at(-1)!.resolve(null);
  await app.flush();
  assert.ok(app.find('LoginPage'));
  assert.equal(app.find('UserHomePage'), undefined);
});

test('a temporary verification failure restricts controls and recovers without logout', async (t) => {
  const app = await signedIn(t);
  app.poll();
  app.requests.at(-1)!.reject(new Error('Mocked network failure'));
  await app.flush();
  assert.equal(app.find('UserHomePage'), undefined);
  assert.equal(app.find('LoginPage'), undefined);
  assert.ok(app.findMounted('UserHomePage'));
  assert.equal(app.find('main').props.role, 'alert');
  app.poll();
  app.requests.at(-1)!.resolve(session());
  await app.flush();
  assert.ok(app.find('UserHomePage'));
});

for (const event of ['visibilitychange', 'focus', 'pageshow']) {
  test(`${event} revalidates before restoring protected controls`, async (t) => {
    const app = await signedIn(t);
    app.document.hidden = true;
    const count = app.requests.length;
    app.poll();
    assert.equal(app.requests.length, count);
    app.resume(event);
    await app.flush();
    assert.equal(app.find('UserHomePage'), undefined);
    assert.ok(app.findMounted('UserHomePage'));
    app.requests.at(-1)!.resolve(null);
    await app.flush();
    assert.ok(app.find('LoginPage'));
    assert.equal(app.findMounted('UserHomePage'), undefined);
  });
}

test('an expired poll cannot be undone by a late permissions-refresh response', async (t) => {
  const app = await signedIn(t);
  app.find('UserHomePage').props.onPermissionsSaved();
  const stale = app.requests.at(-1)!;
  app.resume();
  assert.equal(stale.signal.aborted, true);
  app.requests.at(-1)!.resolve(null);
  await app.flush();
  stale.resolve(session());
  await app.flush();
  assert.ok(app.find('LoginPage'));
  assert.equal(app.find('UserHomePage'), undefined);
});

test('logout immediately hides controls and rejects late responses; a fresh login still works', async (t) => {
  const app = await signedIn(t);
  app.poll();
  const stale = app.requests.at(-1)!;
  const logout = app.find('UserHomePage').props.onLogout();
  await app.flush();
  assert.equal(app.find('UserHomePage'), undefined);
  stale.resolve(session());
  await app.flush();
  assert.equal(app.find('UserHomePage'), undefined);
  app.finishLogout();
  await logout;
  await app.flush();
  const login = app.find('LoginPage').props.onLogin({ user: session().user });
  app.requests.at(-1)!.resolve(session());
  await login;
  await app.flush();
  assert.ok(app.find('UserHomePage'));
});

test('the known deadline triggers revalidation rather than assuming another tab did not renew', async (t) => {
  const app = await signedIn(t);
  app.deadline();
  await app.flush();
  assert.equal(app.find('UserHomePage'), undefined);
  app.requests.at(-1)!.resolve(session());
  await app.flush();
  assert.ok(app.find('UserHomePage'));
});

test('a hidden tab does not renew at the deadline and verifies when shown again', async (t) => {
  const app = await signedIn(t);
  app.document.hidden = true;
  const count = app.requests.length;
  app.deadline();
  await app.flush();
  assert.equal(app.requests.length, count);
  assert.equal(app.find('UserHomePage'), undefined);
  app.resume();
  app.requests.at(-1)!.resolve(null);
  await app.flush();
  assert.ok(app.find('LoginPage'));
});

test('server expiry is translated to the browser clock', async (t) => {
  const serverTime = Date.now() + 3600000;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    ...session(), serverTime, expiresAt: serverTime + 8 * 60 * 60 * 1000,
  })));
  const before = Date.now();
  const loaded = await getCurrentSession();
  assert.ok(loaded!.expiresAt >= before + 8 * 60 * 60 * 1000);
  assert.ok(loaded!.expiresAt <= Date.now() + 8 * 60 * 60 * 1000);
});

test('session checks bypass caches and distinguish 401 from server errors', async (t) => {
  const responses = [new Response(null, { status: 401 }), new Response(null, { status: 500 })];
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'include');
    return responses.shift()!;
  });
  assert.equal(await getCurrentSession(), null);
  await assert.rejects(getCurrentSession(), /500/);
});

test('a hanging check times out and releases the next check', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    calls++;
    if (calls > 1) return new Response(null, { status: 401 });
    return new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new Error('Mocked aborted request')));
    });
  });
  const rejected = assert.rejects(getCurrentSession(), /aborted/);
  t.mock.timers.tick(10000);
  await rejected;
  assert.equal(await getCurrentSession(), null);
});

test('replacement/unmount cancellation reaches the underlying fetch', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(new Error('Mocked cancelled request')));
  }));
  const controller = new AbortController();
  const rejected = assert.rejects(getCurrentSession(controller.signal), /cancelled/);
  controller.abort();
  await rejected;
});
