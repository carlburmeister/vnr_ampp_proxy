// Run after both builds: node test/session-metadata-browser.cjs
// Requires Playwright and Chromium. Local fixtures only; no live AMPP or DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { ConfigService } = require('@nestjs/config');
const {
  AmppResponseRewriterService,
} = require('../dist/ampp-proxy/ampp-response-rewriter.service');

const webRoot = path.resolve(__dirname, '../../web/dist');
const workload = '11111111-1111-4111-8111-111111111111';
const rewriter = new AmppResponseRewriterService(
  new ConfigService({ PLATFORM_URL: 'https://ampp.invalid' }),
);
const activity = [];
const errors = [];
let authenticated = true;
let polls = 0;
const user = {
  id: '42',
  username: 'fixture',
  displayName: 'Fixture',
  clientId: 1,
  userType: 'user',
};

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/api/auth/activity') {
    let body = '';
    for await (const chunk of req) body += chunk;
    activity.push({ path: pathname, method: req.method, body });
    res.writeHead(authenticated ? 204 : 401).end();
  } else if (pathname === '/api/ampp/session/current') {
    polls++;
    res
      .writeHead(authenticated ? 200 : 401, {
        'content-type': 'application/json',
      })
      .end(
        JSON.stringify({
          user,
          serverTime: Date.now(),
          expiresAt: Date.now() + 8 * 60 * 60 * 1000,
          allowedWorkloads: [],
          allowedDashboards: [],
          allowedGvuiLayouts: [],
        }),
      );
  } else if (pathname === '/api/auth/logout') {
    authenticated = false;
    res.writeHead(204).end();
  } else if (pathname.startsWith('/api/ampp-proxy/api/')) {
    res.writeHead(204).end();
  } else if (pathname === '/proxy' || pathname.endsWith('/embedded')) {
    const embedded = pathname.endsWith('/embedded');
    const html = `<html><head></head><body><button id="control">Control</button>
      ${embedded ? '' : '<iframe src="/embedded"></iframe>'}
      <script>setInterval(function(){fetch('/notifications/api/v1/notifications/fixture');},1000);</script>
      </body></html>`;
    const origin = `http://127.0.0.1:${server.address().port}`;
    const rewritten = rewriter.rewrite(workload, origin, {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from(html),
      url: `https://ampp.invalid/app/wrapper/${embedded ? 'embedded' : 'single'}/fixture/${workload}`,
    });
    res.writeHead(200, { 'content-type': 'text/html' }).end(rewritten.body);
  } else {
    const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
    const full = path.resolve(webRoot, filename);
    if (
      !full.startsWith(webRoot + path.sep) ||
      !fs.existsSync(full) ||
      !fs.statSync(full).isFile()
    ) {
      res.writeHead(404).end();
      return;
    }
    const type = full.endsWith('.js')
      ? 'text/javascript'
      : full.endsWith('.css')
        ? 'text/css'
        : 'text/html';
    res.writeHead(200, { 'content-type': type }).end(fs.readFileSync(full));
  }
});

(async () => {
  let browser;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox'],
    });
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.clock.install();
    await page.goto(origin, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Fixture', exact: true }).waitFor();
    assert.equal(
      activity.length,
      0,
      'mount/focus must not report user activity',
    );
    await page.evaluate(() => {
      document.dispatchEvent(new PointerEvent('pointerdown'));
      window.scrollTo(0, 100);
    });
    await page.clock.runFor(30000);
    assert.ok(polls > 1, 'the real SPA continues its idle session polling');
    assert.equal(
      activity.length,
      0,
      'idle polling and synthetic input are not interaction',
    );
    await Promise.all([
      page.waitForResponse(
        (response) => response.url() === origin + '/api/auth/activity',
      ),
      page.mouse.click(2, 2),
    ]);
    assert.equal(activity.length, 1);
    assert.deepEqual(activity[0], {
      path: '/api/auth/activity',
      method: 'POST',
      body: '',
    });
    await page.clock.runFor(60000);
    assert.equal(activity.length, 1, 'there is no idle activity heartbeat');
    await page.getByRole('button', { name: 'Actions ▾', exact: true }).click();
    await page.getByRole('button', { name: 'Sign Out', exact: true }).click();
    await page.locator('input[type=password]').waitFor();
    await page.waitForLoadState('networkidle');
    const afterLogout = activity.length;
    await page.mouse.click(2, 2);
    await page.clock.runFor(60000);
    assert.equal(
      activity.length,
      afterLogout,
      'logout removes listeners and queued work',
    );

    authenticated = true;
    const proxy = await browser.newPage();
    proxy.on('pageerror', (error) => errors.push(error.message));
    await proxy.clock.install();
    await proxy.goto(origin + '/proxy', { waitUntil: 'networkidle' });
    await proxy.bringToFront();
    const beforeProxy = activity.length;
    await proxy.clock.runFor(30000);
    assert.equal(
      activity.length,
      beforeProxy,
      'AMPP automatic polling is not user activity',
    );
    await Promise.all([
      proxy.waitForResponse(
        (response) => response.url() === origin + '/api/auth/activity',
      ),
      proxy.locator('#control').click(),
    ]);
    assert.equal(
      activity.length,
      beforeProxy + 1,
      'a separately opened AMPP page reports via native fetch',
    );
    await Promise.all([
      proxy.waitForResponse(
        (response) => response.url() === origin + '/api/auth/activity',
      ),
      proxy.frameLocator('iframe').locator('#control').click(),
    ]);
    assert.equal(
      activity.length,
      beforeProxy + 2,
      'embedded AMPP documents also report interaction',
    );
    assert.deepEqual(errors, []);
    console.log(
      'PASS: built SPA idle polling/input/logout; proxied page and iframe input; native activity route; no browser errors',
    );
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
