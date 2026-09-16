import { AmppResponseRewriterService } from '../ampp-response-rewriter.service';

const SOURCE_WORKLOAD_ID = 'fb37856d-f3c3-483c-8114-857923e3878f';
const TARGET_WORKLOAD_ID = '6ac0ee96-f6cb-46d2-be4e-00034ad72943';
const PLATFORM_URL = 'https://us-east-1.gvampp.com';
const PUBLIC_ORIGIN = 'http://localhost:8081';

describe('AmppResponseRewriterService', () => {
  const service = new AmppResponseRewriterService({
    getOrThrow: () => PLATFORM_URL,
  } as any);

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
