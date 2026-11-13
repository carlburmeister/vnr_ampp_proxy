// Real Chromium and the real proxy pipeline; all upstream data is a local fixture.
require('ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  setupPanelFixture,
  W,
  OTHER,
  ui,
} = require('./helpers/maverikx-panel-fixture.ts');

(async () => {
  const fixture = await setupPanelFixture();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'maverikx-panel-'));
  let browser, timer;
  let browserLogs = '';
  try {
    await fixture.app.listen(0, '127.0.0.1');
    const origin = await fixture.app.getUrl();
    browser = spawn(
      process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      [
        '--headless',
        '--enable-logging=stderr',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--no-first-run',
        '--no-default-browser-check',
        '--user-data-dir=' + profile,
        origin + ui(`/mocha/application/${W}/embedded/`),
      ],
      { detached: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    browser.stderr.on('data', (data) => {
      browserLogs += data.toString();
    });
    const failure = new Promise((_, reject) => {
      browser.once('error', reject);
      timer = setTimeout(
        () => reject(Error('Panel browser fixture timed out')),
        20000,
      );
    });
    const observed = await Promise.race([fixture.result, failure]);
    console.log(JSON.stringify(observed, null, 2));
    assert.equal(observed.error, undefined);
    assert.equal(observed.panels, 1);
    assert.match(
      observed.frame,
      new RegExp(
        '/api/ampp-proxy/ui/' + W + '/ampp/control/embedded/panelControl/',
      ),
    );
    assert.equal(observed.cutCount, 1);
    assert.equal(observed.denied, 403);
    assert(
      !fixture.requests.some((item) =>
        item.path.includes('/workload/' + OTHER),
      ),
    );
  } catch (error) {
    console.error(
      browserLogs
        .split('\n')
        .filter((line) => line.includes('CONSOLE'))
        .join('\n'),
    );
    console.error('Upstream fixture requests:', fixture.requests);
    throw error;
  } finally {
    clearTimeout(timer);
    if (browser?.pid) {
      try {
        process.kill(-browser.pid, 'SIGTERM');
      } catch {}
    }
    await fixture.app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
