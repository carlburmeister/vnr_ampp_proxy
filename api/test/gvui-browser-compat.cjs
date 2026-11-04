// Run after the API build: node test/gvui-browser-compat.cjs
// Requires Chromium and local socket permission; no live AMPP or credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ConfigService } = require('@nestjs/config');
const {
  AmppResponseRewriterService,
} = require('../dist/ampp-proxy/ampp-response-rewriter.service');
const {
  AmppApiProxyController,
} = require('../dist/ampp-proxy/ampp-api-proxy.controller');
const layout = '11111111-1111-4111-8111-111111111111';
const runner = `<script>
(async function () {
  const results = {};
  const poll = name => 'https://ampp.invalid/notifications/api/v1/notifications/' + name;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const bounded = promise => Promise.race([promise, sleep(250).then(() => 'pending')]);
  try {
    await fetch(poll('same-alias'));
    await fetch('https://ampp.invalid/notifications/api/v1/mailbox', { method: 'POST', body: JSON.stringify({ id: 'same-alias' }) });
    const recreated = new AbortController();
    results.sameAliasRecovery = await bounded(fetch(poll('same-alias'), { signal: recreated.signal }).then(r => r.status, e => e.name));
    recreated.abort();
    await fetch(poll('timeout'));
    const timed = new XMLHttpRequest(); timed.open('GET', poll('timeout')); timed.timeout = 50;
    let timeout = false; timed.addEventListener('timeout', () => { timeout = true; }); timed.send();
    await sleep(200); results.nativeTimeout = timeout; timed.abort();
    await fetch(poll('abort'));
    const aborted = new XMLHttpRequest(); aborted.open('GET', poll('abort'));
    results.abortEvents = [];
    for (const event of ['readystatechange', 'abort', 'loadend'])
      aborted.addEventListener(event, () => results.abortEvents.push([event, aborted.readyState]));
    aborted.send(); await sleep(20); aborted.abort();
    for (let i = 0; i < 6; i++) await fetch(poll('outage'));
    const recovered = new AbortController();
    results.outageRecovery = await bounded(fetch(poll('outage'), { signal: recovered.signal }).then(r => r.status, e => e.name));
    recovered.abort();
  } catch (error) { results.error = String(error); }
  await fetch('/compat-result', { method: 'POST', body: JSON.stringify(results) });
})();
</script>`;
const page = new AmppResponseRewriterService(
  new ConfigService({ PLATFORM_URL: 'https://ampp.invalid' }),
)
  .rewrite(`gvui-${layout}`, 'http://127.0.0.1', {
    url: `https://ampp.invalid/gvui/desktop/${layout}`,
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: Buffer.from('<html><head></head><body></body></html>'),
  })
  .body.toString()
  .replace('</body>', runner + '</body>');
const counts = new Map();
// Exercise the real API controller and retry logic through a thin Node HTTP
// adapter. The HTTP e2e suite separately exercises the real guard/policy/store.
const controller = new AmppApiProxyController(
  { assertApiAccess: (_session, _context, _method, path) => path },
  {
    proxyApiRequest: async (_sid, _session, _context, method, path) => {
      if (method === 'POST')
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from('{"id":"same-alias"}'),
        };
      const key = path.split('/notifications/').at(-1).split('?')[0];
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      let status = 204;
      if (key === 'same-alias' && count === 1) status = 404;
      if (key === 'outage' && count <= 6) status = 503;
      if (['timeout', 'abort'].includes(key)) {
        if (count === 1) status = 503;
        else await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return {
        status,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('[]'),
      };
    },
  },
  { snapshot: () => ({}), saveIfChanged: () => Promise.resolve() },
);
let finish;
const result = new Promise((resolve) => {
  finish = resolve;
});
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST') {
    let body = '';
    for await (const data of req) body += data;
    if (req.url.endsWith('/compat-result')) {
      res.writeHead(204).end();
      finish(JSON.parse(body));
      return;
    }
    req.body = Buffer.from(body);
  }
  if (req.url.startsWith('/api/ampp-proxy/api/')) {
    req.originalUrl = req.url;
    req.sessionID = 'browser-session';
    req.session = {};
    req.protocol = 'http';
    req.get = (name) => req.headers[name.toLowerCase()];
    res.status = (status) => {
      res.statusCode = status;
      return res;
    };
    res.send = (body) => res.end(body);
    try {
      await controller.proxyApiRequest(`gvui-${layout}`, req, res);
    } catch (error) {
      if (!res.destroyed)
        res.writeHead(error.getStatus?.() || 500).end(String(error));
    }
    return;
  }
  if (req.url.endsWith('/access')) {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end('{"allowed":true}');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end(page);
});
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gvui-compat-'));
  let browser;
  let deadline;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    browser = spawn(
      process.env.CHROMIUM_PATH || 'chromium',
      [
        '--headless',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=0',
        '--user-data-dir=' + profile,
        'http://127.0.0.1:' +
          server.address().port +
          '/api/ampp-proxy/ui/gvui-' +
          layout +
          '/gvui/desktop/' +
          layout,
      ],
      { detached: true, stdio: 'ignore' },
    );
    const failure = new Promise((_, reject) => {
      browser.once('error', reject);
      deadline = setTimeout(
        () => reject(new Error('Browser compatibility check timed out')),
        55000,
      );
    });
    const observed = await Promise.race([result, failure]);
    console.log(
      JSON.stringify(
        { apiController: true, observed, requests: Object.fromEntries(counts) },
        null,
        2,
      ),
    );
    assert.equal(observed.sameAliasRecovery, 204, 'same-alias recovery');
    assert.equal(observed.nativeTimeout, true, 'native XHR timeout');
    assert.deepEqual(
      observed.abortEvents,
      [
        ['readystatechange', 4],
        ['abort', 4],
        ['loadend', 4],
      ],
      'native abort events',
    );
    assert.equal(
      observed.outageRecovery,
      204,
      'recovery after six transient failures',
    );
  } finally {
    clearTimeout(deadline);
    if (browser?.pid) {
      try {
        process.kill(-browser.pid, 'SIGTERM');
      } catch {}
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    // Chromium may still be releasing its profile files when it receives SIGTERM.
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
