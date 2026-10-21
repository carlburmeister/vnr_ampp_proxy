import type { SessionData } from 'express-session';

import { filterDiscoveryNodeResponse, getDiscoveryNodeWorkloads } from '../ampp-discovery-filter';

const nodeId = '14ff3382-dc0e-4dd4-a0c0-8c13eac08c88';
const childId = 'cbda2ccd-a99f-4c6a-8e82-1e0948858441';
const otherId = 'b0000000-0000-4000-8000-000000000000';
const session = {
  allowedWorkloads: [{
    id: childId, name: 'MiniMixer', is_parent: 0, pageType: 'ampp-ui', nodeId,
  }],
} as unknown as SessionData;

const services = [
  { serviceId: childId, serviceInstance: childId, serviceName: 'Allowed' },
  { serviceId: otherId, serviceInstance: otherId, serviceName: 'Denied' },
  { serviceInstance: null, serviceName: 'Unknown' },
];
const response = {
  status: 200,
  headers: { 'content-type': 'application/json', etag: '"original"', 'content-length': '123' },
  body: Buffer.from(JSON.stringify(services)),
  url: 'https://us-east-1.gvampp.com/discovery/api/v1/services',
};

describe('node-scoped discovery response filtering', () => {
  it('removes services without authorized workload instances and drops stale validators', () => {
    const result = filterDiscoveryNodeResponse(
      session, childId, `/discovery/api/v1/services?instance=${nodeId}`, response,
    );
    expect(JSON.parse(result.body.toString())).toEqual([services[0]]);
    expect(result.headers.etag).toBeUndefined();
    expect(result.headers['content-length']).toBeUndefined();
  });

  it('leaves existing workload-instance queries intact', () => {
    const result = filterDiscoveryNodeResponse(
      session, childId, `/discovery/api/v1/services?instance=${childId}`, response,
    );
    expect(result).toBe(response);
  });

  it('does not authorize node discovery on behalf of an unrelated route', () => {
    expect(getDiscoveryNodeWorkloads(session, otherId, nodeId).size).toBe(0);
  });

  it('fails closed if a node-scoped upstream response cannot be parsed', () => {
    const result = filterDiscoveryNodeResponse(session, childId,
      `/discovery/api/v1/services?instance=${nodeId}`,
      { ...response, body: Buffer.from('invalid') },
    );
    expect(JSON.parse(result.body.toString())).toEqual([]);
  });
});
