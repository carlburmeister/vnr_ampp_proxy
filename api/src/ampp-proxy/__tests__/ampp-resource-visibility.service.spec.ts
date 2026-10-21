import { ForbiddenException } from '@nestjs/common';
import type { SessionData } from 'express-session';

import { AmppMatrixFilterService } from '../ampp-matrix-filter.service';
import { AmppProxyPolicyService } from '../ampp-proxy-policy.service';
import { AmppProxySessionService } from '../ampp-proxy-session.service';

const PARENT = 'fb37856d-f3c3-483c-8114-857923e3878f';
const MIXER = 'cbda2ccd-a99f-4c6a-8e82-1e0948858441';
const VXP = 'a2210855-56f1-4559-9dca-0de1eb96f2c3';
const UNRELATED = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const FABRIC = '24319621-6be3-411c-923f-a12c2b1eca48';
const DENIED_PRODUCER = '00000000-0000-4000-8000-000000000001';
const ALLOWED_PRODUCER = '00000000-0000-4000-8000-000000000002';
const OTHER_PRODUCER = '00000000-0000-4000-8000-000000000003';
const ALLOWED_CONSUMER = '00000000-0000-4000-8000-000000000004';
const mailbox = 'ts-app.wrapper--00000000-0000-4000-8000-000000000005';

const producer = (id: string, workloadId: string, name: string) => ({
  producer: { id, workloadId, fabricId: FABRIC, name },
});
const response = (body: unknown) => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(body)),
  url: 'https://us-east-1.gvampp.com',
});

describe('denied workload UI with readable producer resources', () => {
  const matrix = new AmppMatrixFilterService({
    getOrThrow: () => 'https://us-east-1.gvampp.com',
  } as any);
  const policy = new AmppProxyPolicyService(matrix);
  let session: SessionData;

  beforeEach(() => {
    session = {
      allowedWorkloads: [{
        id: PARENT,
        name: 'Production',
        is_parent: 1,
        pageType: 'ampp-ui',
        fabricId: FABRIC,
        child_workloads: [{ id: MIXER, name: 'MiniMixer', is_parent: 0, pageType: 'ampp-ui', fabricId: FABRIC }],
      }],
      amppAllowedWorkloadIds: [PARENT, MIXER],
      amppResourceWorkloadIds: [PARENT, MIXER, VXP],
    } as SessionData;
  });

  const populate = (session: SessionData) => {
    const result = matrix.filterApiResponse(session, MIXER,
      `/cluster/matrix/api/v1/producers?fabricId=${FABRIC}`,
      response({ producers: [
        producer(DENIED_PRODUCER, VXP, 'VXP 01'),
        producer(ALLOWED_PRODUCER, MIXER, 'MiniMixer output'),
        producer(OTHER_PRODUCER, UNRELATED, 'Unrelated producer'),
      ] }),
    );
    return JSON.parse(result.body.toString('utf8')).producers;
  };

  it('shows denied-child producers but excludes unrelated producers', () => {
    const result = populate(session);
    expect(result.map((item: any) => item.producer.id)).toEqual([
      DENIED_PRODUCER, ALLOWED_PRODUCER,
    ]);
    expect(matrix.isProducerNameAllowed(session, 'VXP 01', FABRIC)).toBe(true);
    expect(matrix.isProducerIdAllowed(session, DENIED_PRODUCER)).toBe(true);
    expect(matrix.isProducerWritable(session, DENIED_PRODUCER)).toBe(false);
    expect(matrix.isProducerWritable(session, ALLOWED_PRODUCER)).toBe(true);
  });

  it('keeps denied UI launches and direct workload control blocked', () => {
    populate(session);
    expect(() => policy.assertUiResourceAccess(session, VXP, `/app/wrapper/single/GV.AMPP.Apps.VirtualCrosspoint/${VXP}`))
      .toThrow(ForbiddenException);
    expect(() => policy.assertUiResourceAccess(session, PARENT, `/app/wrapper/single/GV.AMPP.Apps.VirtualCrosspoint/${VXP}`))
      .toThrow(ForbiddenException);
    expect(() => policy.assertApiAccess(session, MIXER, 'POST', `/cluster/control/api/v1/workload/${VXP}/stop`))
      .toThrow(ForbiddenException);
    expect(() => policy.assertApiAccess(session, MIXER, 'POST', `/mocha/application/${VXP}/api/v1/app/input/1`, Buffer.from('{}')))
      .toThrow(ForbiddenException);
    expect(() => policy.assertApiAccess(session, MIXER, 'PUT', `/cluster/matrix/api/v1/producer/${DENIED_PRODUCER}`, Buffer.from('{"alias":"wrong"}')))
      .toThrow(ForbiddenException);
    expect(policy.assertApiAccess(session, MIXER, 'PUT', `/cluster/matrix/api/v1/producer/${ALLOWED_PRODUCER}`, Buffer.from('{"alias":"fine"}')))
      .toBe(`/cluster/matrix/api/v1/producer/${ALLOWED_PRODUCER}`);
  });

  it('permits source assignment only to an authorized mixer consumer', () => {
    populate(session);
    matrix.filterApiResponse(session, MIXER, `/cluster/matrix/api/v1/consumers?fabricId=${FABRIC}`,
      response({ consumers: [{ consumer: { id: ALLOWED_CONSUMER, workloadId: MIXER, fabricId: FABRIC } }] }));
    const path = `/mocha/application/${MIXER}/api/v1/app/sourceselect`;
    const body = Buffer.from(JSON.stringify({
      Producer: { id: DENIED_PRODUCER, workloadId: VXP },
      Consumer: { id: ALLOWED_CONSUMER, workloadId: MIXER },
    }));
    expect(policy.assertApiAccess(session, MIXER, 'POST', path, body)).toBe(path);
    expect(() => policy.assertApiAccess(session, MIXER, 'POST', path,
      Buffer.from(JSON.stringify({
        Producer: { id: DENIED_PRODUCER, workloadId: VXP },
        Consumer: { id: ALLOWED_CONSUMER, workloadId: VXP },
      })))).toThrow(ForbiddenException);
  });

  it('allows read-only WebRTC subscriptions without extending workload topics', () => {
    const preview = `gv.webrtc.${VXP}.00000000-0000-4000-8000-000000000006`;
    const subscribe = (topic: string) => `/notifications/api/v1/mailbox/${mailbox}/subscribe/${topic}`;
    expect(policy.assertApiAccess(session, MIXER, 'POST', subscribe(preview))).toBe(subscribe(preview));
    expect(() => policy.assertApiAccess(session, MIXER, 'POST',
      subscribe(`gv.ampp.apps.MiniMixer.${VXP}.#`))).toThrow(ForbiddenException);
    expect(() => policy.assertApiAccess(session, MIXER, 'POST',
      subscribe(`gv.webrtc.${UNRELATED}.00000000-0000-4000-8000-000000000006`)))
      .toThrow(ForbiddenException);
  });

  it('permits only scoped preview signaling, never denied-workload control messages', () => {
    const path = '/notifications/api/v1/notifications';
    const source = `/api/ampp-proxy/ui/${MIXER}/mocha/application/${MIXER}`;
    const valid = Buffer.from(JSON.stringify({
      Source: source,
      topic: `gv.engine.${VXP}.senders`,
      content: JSON.stringify({
        type: 'discovery',
        receiverTopic: `gv.webrtc.${VXP}.00000000-0000-4000-8000-000000000006`,
      }),
    }));
    expect(policy.assertApiAccess(session, MIXER, 'POST', path, valid)).toBe(path);
    const forbidden = Buffer.from(JSON.stringify({
      Source: source,
      topic: `gv.engine.${UNRELATED}.senders`,
      content: JSON.stringify({ type: 'discovery', receiverTopic: `gv.webrtc.${UNRELATED}.00000000-0000-4000-8000-000000000006` }),
    }));
    expect(() => policy.assertApiAccess(session, MIXER, 'POST', path, forbidden))
      .toThrow(ForbiddenException);
    const command = Buffer.from(JSON.stringify({
      Source: source,
      topic: `gv.engine.${VXP}.senders`,
      content: JSON.stringify({ type: 'stop' }),
    }));
    expect(() => policy.assertApiAccess(session, MIXER, 'POST', path, command))
      .toThrow(ForbiddenException);
  });

  it('does not promote dashboard-only or unrelated producers to write access', () => {
    const result = populate(session);
    expect(result).toHaveLength(2);
    expect(matrix.isProducerWritable(session, OTHER_PRODUCER)).toBe(false);
  });

  it('merges readable and writable Matrix caches independently', () => {
    const service = new AmppProxySessionService();
    const merged = (service as any).mergeMatrixAccess(
      { [FABRIC]: { producerIds: [ALLOWED_PRODUCER], writableProducerIds: [ALLOWED_PRODUCER] } },
      { [FABRIC]: { producerIds: [ALLOWED_PRODUCER, DENIED_PRODUCER], writableProducerIds: [ALLOWED_PRODUCER] } },
      { [FABRIC]: { producerIds: [ALLOWED_PRODUCER], writableProducerIds: [ALLOWED_PRODUCER] } },
    );
    expect(merged[FABRIC].producerIds).toContain(DENIED_PRODUCER);
    expect(merged[FABRIC].writableProducerIds).toEqual([ALLOWED_PRODUCER]);
  });

  it('falls back to UI grants when no resource scope is available', () => {
    session.amppResourceWorkloadIds = undefined;
    const result = populate(session);
    expect(result.map((item: any) => item.producer.id)).toEqual([ALLOWED_PRODUCER]);
  });
});
