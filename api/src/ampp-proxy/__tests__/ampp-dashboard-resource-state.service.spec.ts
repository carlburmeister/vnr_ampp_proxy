import type { SessionData } from 'express-session';
import { ForbiddenException } from '@nestjs/common';

import { AmppDashboardFilterService } from '../ampp-dashboard-filter.service';
import { AmppProxyPolicyService } from '../ampp-proxy-policy.service';
import { AmppMatrixFilterService } from '../ampp-matrix-filter.service';

const PLATFORM = 'https://us-east-1.gvampp.com';
const PARENT = 'fb37856d-f3c3-483c-8114-857923e3878f';
const SRT1 = 'fbab1aa9-405b-460d-abfa-83a239981f5e';
const SRT2 = '19876769-99e5-4685-a7e2-95d8c0720284';
const RECEIVER1 = 'a1111111-1111-4111-8111-111111111111';
const RECEIVER2 = 'a2222222-2222-4222-8222-222222222222';
const UNRELATED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FABRIC = '24319621-6be3-411c-923f-a12c2b1eca48';
const CONFIG = { getOrThrow: () => PLATFORM } as any;

const response = (value: unknown) => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(value)),
  url: PLATFORM,
});
const decode = (value: { body: Buffer }) => JSON.parse(value.body.toString('utf8'));
const record = (id: string, parentId = PARENT) => ({
  workload: {
    id,
    name: 'Source',
    parentId,
    fabricId: FABRIC,
    packageName: 'GV.AMPP.Apps.SrtInput',
    state: { nodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', state: 'Running', isWorkloadAssigned: true, owner: 'internal' },
    states: [{ state: 'Running', isWorkloadAssigned: true, secret: 'do-not-expose' }],
    desiredState: { state: 'Ready', startProperties: { token: 'secret' } },
    properties: { password: 'secret' },
    configurationPath: 'internal/configuration',
    billingProperties: { key: 'secret' },
  },
  eTag: 'internal-etag',
});

describe('dashboard read-only state of denied child workloads', () => {
  const filter = new AmppDashboardFilterService(CONFIG);
  const policy = new AmppProxyPolicyService(new AmppMatrixFilterService(CONFIG));
  const url = '/cluster/state/api/v1/workloads';
  let session: SessionData;

  beforeEach(() => {
    session = {
      allowedWorkloads: [{
        id: PARENT, name: 'Production', is_parent: 1, pageType: 'ampp-ui', fabricId: FABRIC,
        child_workloads: [],
      }],
      amppAllowedWorkloadIds: [PARENT],
      amppResourceWorkloadIds: [PARENT, SRT1, SRT2, RECEIVER1, RECEIVER2],
    } as SessionData;
  });

  it('retains both denied SRT Inputs and their receivers but excludes unrelated workloads', () => {
    const records = [record(PARENT), record(SRT1), record(RECEIVER1, SRT1),
      record(SRT2), record(RECEIVER2, SRT2), record(UNRELATED)];
    const result = decode(filter.filterApiResponse(session, PARENT, url, response({ workloads: records })));
    expect(result.workloads.map((item: any) => item.workload.id))
      .toEqual([PARENT, SRT1, RECEIVER1, SRT2, RECEIVER2]);
    expect(result.workloads[0]).toEqual(records[0]);
    expect(result.workloads[1].workload.parentId).toBe(PARENT);
    expect(result.workloads[2].workload.parentId).toBe(SRT1);
  });

  it('exposes only read-only identifiers and runtime status for denied workloads', () => {
    const result = decode(filter.filterApiResponse(session, PARENT, url,
      response({ workloads: [record(SRT1)] })));
    const item = result.workloads[0];
    expect(item.workload.state).toEqual({
      nodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      state: 'Running', isWorkloadAssigned: true,
    });
    expect(item.workload.states).toEqual([{ state: 'Running', isWorkloadAssigned: true }]);
    expect(item.workload.desiredState).toEqual({ state: 'Ready' });
    expect(item.workload).not.toHaveProperty('properties');
    expect(item.workload).not.toHaveProperty('configurationPath');
    expect(item.workload).not.toHaveProperty('billingProperties');
    expect(item).not.toHaveProperty('eTag');
  });

  it('preserves the old UI-only behavior if no resource permissions exist', () => {
    session.amppResourceWorkloadIds = undefined;
    const result = decode(filter.filterApiResponse(session, PARENT, url,
      response({ workloads: [record(PARENT), record(SRT1)] })));
    expect(result.workloads.map((item: any) => item.workload.id)).toEqual([PARENT]);
  });

  it('passes normal workload notifications unchanged, but sanitizes denied child events', () => {
    const events = [
      { topic: `gv.cluster.workload.${PARENT}.changed`, content: JSON.stringify(record(PARENT).workload) },
      { topic: `gv.cluster.workload.${SRT1}.changed`, content: JSON.stringify(record(SRT1)) },
      { topic: `gv.cluster.workload.${UNRELATED}.changed`, content: JSON.stringify(record(UNRELATED)) },
      { topic: 'gv.cluster.workload.created', content: JSON.stringify(record(RECEIVER1, SRT1)) },
      { topic: `gv.cluster.workload.${SRT2}.changed`, content: 'unparseable' },
    ];
    const result = decode(filter.filterApiResponse(session, PARENT,
      '/notifications/api/v1/notifications/example', response(events)));
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(events[0]);
    const first = JSON.parse(result[1].content).workload;
    const created = JSON.parse(result[2].content).workload;
    expect(first.id).toBe(SRT1);
    expect(created.id).toBe(RECEIVER1);
    expect(first.properties).toBeUndefined();
    expect(created.properties).toBeUndefined();
  });

  it('rejects notification IDs that do not match the topic or resource scope', () => {
    const events = [
      { topic: `gv.cluster.workload.${SRT1}.changed`, content: JSON.stringify(record(SRT2)) },
      { topic: 'gv.cluster.workload.created', content: JSON.stringify(record(UNRELATED)) },
      { topic: `gv.cluster.workload.${SRT1}.changed`, content: JSON.stringify({ id: SRT1, state: 'Running', properties: { password: 'secret' } }) },
    ];
    const result = decode(filter.filterApiResponse(session, PARENT,
      '/notifications/api/v1/notifications/example', response(events)));
    expect(result).toHaveLength(1);
    expect(JSON.parse(result[0].content)).toEqual({ id: SRT1, state: 'Running' });
  });

  it('does not allow direct UI or control of the denied SRT workload', () => {
    expect(() => policy.assertUiResourceAccess(session, PARENT,
      `/app/wrapper/single/GV.AMPP.Apps.SrtInput/${SRT1}`))
      .toThrow(ForbiddenException);
    expect(() => policy.assertApiAccess(session, PARENT, 'POST',
      `/cluster/control/api/v1/workload/${SRT1}/stop`))
      .toThrow(ForbiddenException);
  });

  it('keeps unrelated Dashboard API response filters unchanged', () => {
    const filtered = decode(filter.filterApiResponse(session, PARENT,
      '/cluster/snapshot/api/v1/snapshots',
      response({ snapshots: [
        { snapshot: { id: '1', fabricId: FABRIC } },
        { snapshot: { id: '2', fabricId: UNRELATED } },
      ] })));
    expect(filtered.snapshots.map((entry: any) => entry.snapshot.id)).toEqual(['1']);
  });
});
