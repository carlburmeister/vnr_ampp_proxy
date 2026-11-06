// Run after the API build: node test/clip-recorder-scroll.cjs
// Real Chromium, local fixture only; no AMPP session or credentials.
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

const workload = '11111111-1111-4111-8111-111111111111';
const fixture = `<html><head><style>
input { width:149px; padding:0; font:16px Arial; color:white; background:#222; }
</style></head><body>
<div class="MuiAutocomplete-root"><input id="root_source" role="combobox"
value="Production source - a very long selected graphics engine source label"></div>
<input id="other_field" value="A different form field with a sufficiently long value for scrolling">
<script>
(async () => {
  const results = {};
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const settled = async () => { await frame(); await frame(); await frame(); };
  let input = document.getElementById('root_source');
  const other = document.getElementById('other_field');
  let inputEvents = 0, changeEvents = 0, focusEvents = 0;
  input.addEventListener('input', () => inputEvents++);
  input.addEventListener('change', () => changeEvents++);
  input.addEventListener('focus', () => focusEvents++);
  await settled();
  other.focus();
  input.scrollLeft = 177;
  other.scrollLeft = 100;
  results.initialOffset = input.scrollLeft;
  await settled();
  results.correctedOffset = input.scrollLeft;
  results.focusPreserved = document.activeElement === other;
  results.otherOffset = other.scrollLeft;
  results.initialValue = input.value;
  results.initialEvents = { inputEvents, changeEvents, focusEvents };

  const nextValue = 'Updated production source - another long selected source label';
  input.value = nextValue;
  input.setAttribute('value', nextValue);
  input.scrollLeft = 177;
  await settled();
  results.updatedOffset = input.scrollLeft;
  results.updatedValue = input.value;

  input.focus();
  await settled();
  input.setSelectionRange(12, 12);
  input.scrollLeft = 120;
  input.setAttribute('value', input.value);
  await settled();
  results.editingOffset = input.scrollLeft;
  results.editingCaret = input.selectionStart;
  input.blur();
  await settled();
  results.blurredOffset = input.scrollLeft;
  results.finalEvents = { inputEvents, changeEvents, focusEvents };

  const replacement = input.cloneNode();
  input.replaceWith(replacement);
  input = replacement;
  input.scrollLeft = 177;
  await settled();
  results.replacedOffset = input.scrollLeft;
  results.replacedValue = input.value;

  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted:true }));
  input.scrollLeft = 177;
  await settled();
  results.stoppedOffset = input.scrollLeft;
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted:true }));
  await settled();
  results.resumedOffset = input.scrollLeft;
  await fetch('/scroll-result', { method:'POST', body:JSON.stringify(results) });
})().catch(error => fetch('/scroll-result', {method:'POST', body:JSON.stringify({error:String(error)})}));
</script></body></html>`;

let finish;
const result = new Promise((resolve) => {
  finish = resolve;
});
const server = http.createServer(async (req, res) => {
  if (req.url.endsWith('/scroll-result') && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.writeHead(204).end();
    finish(JSON.parse(body));
    return;
  }
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = new AmppResponseRewriterService(
    new ConfigService({ PLATFORM_URL: 'https://ampp.invalid' }),
  ).rewrite(
    workload,
    origin,
    {
      url: `https://ampp.invalid/mocha/application/${workload}/embedded/`,
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from(fixture),
    },
    true,
  );
  res.writeHead(200, { 'content-type': 'text/html' }).end(response.body);
});

(async () => {
  let browser, timer;
  const profile = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ampp-recorder-scroll-'),
  );
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    browser = spawn(
      process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
        '--user-data-dir=' + profile,
        `http://127.0.0.1:${server.address().port}/recorder`,
      ],
      { detached: true, stdio: 'ignore' },
    );
    const failure = new Promise((_, reject) => {
      browser.once('error', reject);
      timer = setTimeout(
        () => reject(Error('Recorder scroll check timed out')),
        15000,
      );
    });
    const observed = await Promise.race([result, failure]);
    console.log(JSON.stringify(observed, null, 2));
    assert.equal(observed.error, undefined);
    assert.equal(
      observed.initialOffset,
      177,
      'fixture must reproduce stale scrolling',
    );
    assert.equal(observed.correctedOffset, 0, 'unfocused source resets');
    assert.equal(
      observed.focusPreserved,
      true,
      'focus stays on the other field',
    );
    assert.equal(
      observed.otherOffset,
      100,
      'other fields retain their scrolling',
    );
    assert.deepEqual(observed.initialEvents, {
      inputEvents: 0,
      changeEvents: 0,
      focusEvents: 0,
    });
    assert.equal(
      observed.updatedOffset,
      0,
      'controlled value updates reset scrolling',
    );
    assert.equal(
      observed.updatedValue,
      'Updated production source - another long selected source label',
    );
    assert.equal(
      observed.editingOffset,
      120,
      'active editing keeps its scroll position',
    );
    assert.equal(observed.editingCaret, 12, 'caret remains untouched');
    assert.equal(
      observed.blurredOffset,
      0,
      'blur restores the start of the label',
    );
    assert.deepEqual(observed.finalEvents, {
      inputEvents: 0,
      changeEvents: 0,
      focusEvents: 1,
    });
    assert.equal(observed.replacedOffset, 0, 'replacement inputs are handled');
    assert.equal(observed.replacedValue, observed.updatedValue);
    assert.equal(
      observed.stoppedOffset,
      177,
      'pagehide removes observers/listeners',
    );
    assert.equal(
      observed.resumedOffset,
      0,
      'pageshow resumes after bfcache restoration',
    );
  } finally {
    clearTimeout(timer);
    if (browser?.pid) {
      try {
        process.kill(-browser.pid, 'SIGTERM');
      } catch {}
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
