import { AmppResponseRewriterService } from '../ampp-response-rewriter.service';

const SOURCE_WORKLOAD_ID = 'fb37856d-f3c3-483c-8114-857923e3878f';
const TARGET_WORKLOAD_ID = '6ac0ee96-f6cb-46d2-be4e-00034ad72943';
const PLATFORM_URL = 'https://us-east-1.gvampp.com';
const PUBLIC_ORIGIN = 'http://localhost:8081';

describe('AmppResponseRewriterService', () => {
  const service = new AmppResponseRewriterService({
    getOrThrow: () => PLATFORM_URL,
    get: () => undefined,
  } as any);

  it('caches unmodified wrapper JavaScript privately and preserves validators', () => {
    const body = Buffer.from('window.ok = true;');
    const result = service.rewrite(SOURCE_WORKLOAD_ID, PUBLIC_ORIGIN, {
      status: 200,
      headers: {
        'content-type': 'text/javascript',
        'cache-control': 'public, max-age=0',
        etag: '"bundle-1"',
        'last-modified': 'Mon, 19 Oct 2026 10:00:00 GMT',
      },
      body,
      url: `${PLATFORM_URL}/app/wrapper/main.bundle.js`,
    });

    expect(result.body).toBe(body);
    expect(result.headers['Cache-Control']).toContain('private, max-age=300');
    expect(result.headers.ETag).toBe('W/"bundle-1"');
    expect(result.headers['Last-Modified']).toBe('Mon, 19 Oct 2026 10:00:00 GMT');
  });

  it('does not cache transformed HTML, API responses, or assets with cookies', () => {
    for (const [url, type, extra] of [
      [`${PLATFORM_URL}/app/wrapper/single/pkg/${SOURCE_WORKLOAD_ID}`, 'text/html', {}],
      [`${PLATFORM_URL}/discovery/api/v1/services`, 'text/javascript', {}],
      [`${PLATFORM_URL}/app/wrapper/main.bundle.js`, 'text/javascript', { 'set-cookie': 'sid=abc' }],
    ] as const) {
      const result = service.rewrite(SOURCE_WORKLOAD_ID, PUBLIC_ORIGIN, {
        status: 200,
        headers: { 'content-type': type, ...extra },
        body: Buffer.from(type === 'text/html' ? '<html><head></head></html>' : 'hello'),
        url,
      });
      expect(result.headers['Cache-Control']).toBe('no-store');
    }
  });

  it('rewrites CSS but does not forward the upstream validator for modified bytes', () => {
    const result = service.rewrite(SOURCE_WORKLOAD_ID, PUBLIC_ORIGIN, {
      status: 200,
      headers: { 'content-type': 'text/css', etag: '"upstream-css"' },
      body: Buffer.from('body {background: url("/app/wrapper/logo.png")}'),
      url: `${PLATFORM_URL}/app/wrapper/main.css`,
    });
    expect(result.headers['Cache-Control']).toContain('private');
    expect(result.headers.ETag).toBeUndefined();
  });

  it('keeps JavaScript 304 revalidations cacheable', () => {
    const result = service.rewrite(SOURCE_WORKLOAD_ID, PUBLIC_ORIGIN, {
      status: 304,
      headers: { etag: '"bundle-1"' },
      body: Buffer.alloc(0),
      url: `${PLATFORM_URL}/app/wrapper/main.bundle.js`,
    });
    expect(result.status).toBe(304);
    expect(result.headers['Cache-Control']).toContain('max-age=300');
  });

  it('re-scopes dashboard-launched workload UI redirects to the target workload', () => {
    const response = service.rewrite(SOURCE_WORKLOAD_ID, PUBLIC_ORIGIN, {
      status: 302,
      headers: {
        location: `${PLATFORM_URL}/app/wrapper/single/GV.AMPP.Apps.FlowMonitor/${TARGET_WORKLOAD_ID}`,
      },
      body: Buffer.alloc(0),
      url: `${PLATFORM_URL}/cluster/systemdashboard/dashboard/dashboard-id`,
    });

    expect(response.headers.Location).toBe(
      `${PUBLIC_ORIGIN}/api/ampp-proxy/ui/${TARGET_WORKLOAD_ID}` +
        `/app/wrapper/single/GV.AMPP.Apps.FlowMonitor/${TARGET_WORKLOAD_ID}`,
    );
  });

  it('leaves already proxied URLs unchanged', () => {
    const targetUrl =
      `${PUBLIC_ORIGIN}/api/ampp-proxy/ui/${TARGET_WORKLOAD_ID}` +
      `/app/wrapper/single/GV.AMPP.Apps.FlowMonitor/${TARGET_WORKLOAD_ID}`;
    const response = service.rewrite(SOURCE_WORKLOAD_ID, PUBLIC_ORIGIN, {
      status: 302,
      headers: { location: targetUrl },
      body: Buffer.alloc(0),
      url: `${PLATFORM_URL}/cluster/systemdashboard/dashboard/dashboard-id`,
    });

    expect(response.headers.Location).toBe(targetUrl);
  });

  it('keeps ordinary dashboard resources on the dashboard proxy scope', () => {
    const response = service.rewrite(SOURCE_WORKLOAD_ID, PUBLIC_ORIGIN, {
      status: 302,
      headers: { location: `${PLATFORM_URL}/cluster/systemdashboard/main.css` },
      body: Buffer.alloc(0),
      url: `${PLATFORM_URL}/cluster/systemdashboard/dashboard/dashboard-id`,
    });

    expect(response.headers.Location).toBe(
      `${PUBLIC_ORIGIN}/api/ampp-proxy/ui/${SOURCE_WORKLOAD_ID}` +
        '/cluster/systemdashboard/main.css',
    );
  });

  it('injects target-workload-aware runtime rewriting for window.open links', () => {
    const response = service.rewrite(SOURCE_WORKLOAD_ID, PUBLIC_ORIGIN, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: Buffer.from('<html><head></head><body></body></html>'),
      url: `${PLATFORM_URL}/cluster/systemdashboard/dashboard/dashboard-id`,
    });
    const html = response.body.toString('utf8');

    expect(html).toContain('const getUiTargetWorkloadId=function(path)');
    expect(html).toContain('const proxyBaseForPath=function(path)');
    expect(html).toContain('window.open=function(url)');
  });
});
