import request from 'supertest';
import {
  setupPanelFixture,
  W,
  OTHER,
  PANEL,
  catalog,
  embedded,
  api,
  ui,
} from './helpers/maverikx-panel-fixture';

describe('MaverikX panel HTTP proxy', () => {
  let fixture: Awaited<ReturnType<typeof setupPanelFixture>>;
  beforeEach(async () => {
    fixture = await setupPanelFixture();
  });
  afterEach(async () => {
    await fixture.app.close();
  });

  it('loads an assigned individual workload panel without dashboard assignments', async () => {
    const server = fixture.app.getHttpServer();
    await request(server).get(ui(embedded)).expect(403);
    expect(fixture.requests).toHaveLength(0);
    const response = await request(server).get(api(catalog)).expect(200);
    const catalogue = JSON.parse(response.text) as {
      panels: Record<string, unknown>;
    };
    expect(Object.keys(catalogue.panels)).toEqual([PANEL]);
    expect(response.headers['cache-control']).toBe('no-store');
    await request(server)
      .get(ui(embedded))
      .expect(200)
      .expect(/data-ampp-proxy-bootstrap/);
    await request(server)
      .get(api(`/ampp/control/api/v1/panel/${PANEL}`))
      .expect(200);
    const state = await request(server)
      .get(api('/cluster/state/api/v1/workloads'))
      .expect(200);
    const states = JSON.parse(state.text) as {
      workloads: { workload: { id: string; secret?: string } }[];
    };
    expect(states.workloads.map((item) => item.workload.id)).toEqual([
      W,
      OTHER,
    ]);
    expect(states.workloads[1].workload.secret).toBeUndefined();
    const macros = await request(server)
      .get(api('/ampp/control/api/v1/macro'))
      .expect(200);
    expect(
      (JSON.parse(macros.text) as { uuid: string }[]).map((item) => item.uuid),
    ).toEqual([PANEL]);
    const references = await request(server)
      .get(api('/ampp/control/api/v1/control/application/references'))
      .expect(200);
    expect(references.body).toEqual([{ name: 'MaverikX' }]);
  });

  it('blocks tampered targets and resource-only control before forwarding', async () => {
    const server = fixture.app.getHttpServer();
    await request(server).get(api(catalog)).expect(200);
    fixture.requests.length = 0;
    await request(server)
      .get(ui(embedded.replace(W, OTHER)))
      .expect(403);
    await request(server)
      .get(api(`/ampp/control/api/v1/panel/${OTHER}`))
      .expect(403);
    const command = {
      application: 'MaverikX',
      command: 'cut',
      workload: OTHER,
      reconKey: 'panel-cut',
      formData: '{}',
    };
    await request(server)
      .post(api('/ampp/control/api/v1/control/commit'))
      .send(command)
      .expect(403);
    expect(fixture.requests).toHaveLength(0);
    await request(server)
      .post(api('/ampp/control/api/v1/control/commit'))
      .send({ ...command, workload: W })
      .expect(204);
    expect(fixture.requests).toHaveLength(1);
  });

  it('denies subsequent panel requests after the assignment is revoked', async () => {
    const server = fixture.app.getHttpServer();
    await request(server).get(api(catalog)).expect(200);
    fixture.revoke();
    fixture.requests.length = 0;
    await request(server).get(ui(embedded)).expect(403);
    await request(server).get(api(catalog)).expect(403);
    expect(fixture.requests).toHaveLength(0);
  });
});
