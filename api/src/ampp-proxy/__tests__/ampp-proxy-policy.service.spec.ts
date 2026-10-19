import { ForbiddenException } from '@nestjs/common';
import type { SessionData } from 'express-session';

import { AmppMatrixFilterService } from '../ampp-matrix-filter.service';
import { AmppProxyPolicyService } from '../ampp-proxy-policy.service';

describe('AmppProxyPolicyService', () => {
  const workloadId = 'fb37856d-f3c3-483c-8114-857923e3878f';
  const secondWorkloadId = '11111111-2222-4333-8444-555555555555';
  const unauthorizedWorkloadId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const dashboardId = 'c3a232b3-cbcd-42f5-b767-d2b62fdf3f1d';
  const mailboxId = 'e1990678-d124-4bef-8910-d3b532181278';
  let service: AmppProxyPolicyService;
  let session: SessionData;

  beforeEach(() => {
    service = new AmppProxyPolicyService({} as unknown as AmppMatrixFilterService);
    session = {
      allowedWorkloads: [
        {
          id: workloadId,
          name: 'Primary workload',
          is_parent: 0,
          pageType: 'ampp-ui',
        },
        {
          id: secondWorkloadId,
          name: 'Second workload',
          is_parent: 0,
          pageType: 'ampp-ui',
        },
      ],
      allowedDashboardIds: [dashboardId],
      allowedDashboards: [
        {
          id: dashboardId,
          associatedWorkloadId: workloadId,
          name: 'System Dashboard',
          pageType: 'ampp-ui',
        },
      ],
      amppAllowedWorkloadIds: [workloadId, secondWorkloadId],
    } as unknown as SessionData;
  });

  it('allows existing workload UI paths that reference the proxy workload', () => {
    const launchPath = `/app/wrapper/single/GV.AMPP.Apps.FlowMonitor/${workloadId}`;
    const callbackPath = `/app/wrapper/callback/${workloadId}`;
    const queryPath = `/app/wrapper/callback?workloadId=${workloadId}`;

    expect(service.assertUiAccess(session, workloadId, launchPath)).toBe(
      launchPath,
    );
    expect(service.assertUiAccess(session, workloadId, callbackPath)).toBe(
      callbackPath,
    );
    expect(service.assertUiAccess(session, workloadId, queryPath)).toBe(
      queryPath,
    );
  });

  it('rejects workload UI paths that do not reference the proxy workload', () => {
    expect(() =>
      service.assertUiAccess(session, workloadId, '/app/wrapper/callback'),
    ).toThrow(ForbiddenException);
  });

  it('allows dashboard navigation only to an authorized target workload', () => {
    const allowedPath = `/app/wrapper/single/GV.AMPP.Apps.FlowMonitor/${secondWorkloadId}`;
    const deniedPath = `/app/wrapper/single/GV.AMPP.Apps.FlowMonitor/${unauthorizedWorkloadId}`;

    expect(
      service.assertUiResourceAccess(session, workloadId, allowedPath),
    ).toBe(allowedPath);
    expect(() =>
      service.assertUiResourceAccess(session, workloadId, deniedPath),
    ).toThrow(ForbiddenException);
  });

  it('allows original and proxied System Dashboard mailbox IDs', () => {
    const originalMailbox = Buffer.from(
      JSON.stringify({
        durable: false,
        id: `ts-cluster.systemdashboard--${mailboxId}`,
        mailboxTTL: 1500000,
        maximumLength: 10000,
        subscription: 'gv',
      }),
    );
    const proxiedMailbox = Buffer.from(
      JSON.stringify({
        durable: false,
        id: `ts-api.ampp-proxy.ui.${workloadId}.cluster.systemdashboard--${mailboxId}`,
        mailboxTTL: 1500000,
        maximumLength: 10000,
        subscription: 'gv',
      }),
    );

    expect(
      service.assertApiAccess(
        session,
        workloadId,
        'POST',
        '/notifications/api/v1/mailbox',
        originalMailbox,
      ),
    ).toBe('/notifications/api/v1/mailbox');
    expect(
      service.assertApiAccess(
        session,
        workloadId,
        'POST',
        '/notifications/api/v1/mailbox',
        proxiedMailbox,
      ),
    ).toBe('/notifications/api/v1/mailbox');
  });

  it('rejects a proxied System Dashboard mailbox for a different workload scope', () => {
    const body = Buffer.from(
      JSON.stringify({
        durable: false,
        id: `ts-api.ampp-proxy.ui.${secondWorkloadId}.cluster.systemdashboard--${mailboxId}`,
        mailboxTTL: 1500000,
        maximumLength: 10000,
        subscription: 'gv',
      }),
    );

    expect(() =>
      service.assertApiAccess(
        session,
        workloadId,
        'POST',
        '/notifications/api/v1/mailbox',
        body,
      ),
    ).toThrow(ForbiddenException);
  });

  it('preserves the existing proxied workload mailbox rule', () => {
    const body = Buffer.from(
      JSON.stringify({
        durable: false,
        id: `ts-api.ampp-proxy.ui.${workloadId}.app.wrapper--${mailboxId}`,
        mailboxTTL: 1500000,
        maximumLength: 10000,
        subscription: 'gv',
      }),
    );

    expect(
      service.assertApiAccess(
        session,
        workloadId,
        'POST',
        '/notifications/api/v1/mailbox',
        body,
      ),
    ).toBe('/notifications/api/v1/mailbox');
  });
  it('grants only dashboard-referenced node and fabric reads after configuration capture', () => {
    const dashboardNode = '551e9fe2-b2d2-4e59-b725-0fa283f3b170';
    const dashboardFabric = 'ec449300-edb3-41ce-96ec-96a13bdfdcdb';
    const otherNode = 'f4aeba94-fe1d-4cd5-b5f1-387d33b0ea98';
    const nodePath = `/cluster/state/api/v2/node/${dashboardNode}`;
    const fabricPath = `/cluster/matrix/api/v1/producers?fabricId=${dashboardFabric}&type=Fabric`;

    expect(() => service.assertApiAccess(session, workloadId, 'GET', nodePath))
      .toThrow(ForbiddenException);
    expect(() => service.assertApiAccess(session, workloadId, 'GET', fabricPath))
      .toThrow(ForbiddenException);

    session.amppDashboardMatrixAccess = {
      [workloadId]: {
        dashboards: { [dashboardId]: { [dashboardFabric]: {} } },
        dashboardNodeIds: { [dashboardId]: [dashboardNode] },
      },
    };

    expect(service.assertApiAccess(session, workloadId, 'GET', nodePath)).toBe(nodePath);
    expect(service.assertApiAccess(session, workloadId, 'GET', fabricPath)).toBe(fabricPath);
    expect(() => service.assertApiAccess(session, workloadId, 'GET',
      `/cluster/state/api/v2/node/${otherNode}`)).toThrow(ForbiddenException);
    expect(() => service.assertApiAccess(session, secondWorkloadId, 'GET', nodePath))
      .toThrow(ForbiddenException);
    expect(() => service.assertApiAccess(session, secondWorkloadId, 'GET', fabricPath))
      .toThrow(ForbiddenException);
    expect(() => service.assertApiAccess(session, workloadId, 'POST', nodePath))
      .toThrow(ForbiddenException);
    expect(() => service.assertApiAccess(session, workloadId, 'PUT', fabricPath))
      .toThrow(ForbiddenException);

    session.allowedDashboardIds = [];
    expect(() => service.assertApiAccess(session, workloadId, 'GET', nodePath))
      .toThrow(ForbiddenException);
  });

  it('permits node notifications only for dashboard-referenced nodes', () => {
    const nodeId = '551e9fe2-b2d2-4e59-b725-0fa283f3b170';
    const otherNode = 'f4aeba94-fe1d-4cd5-b5f1-387d33b0ea98';
    const topic = (id: string) =>
      `/notifications/api/v1/mailbox/dashboard-mailbox/subscribe/gv.cluster.node.${id}.%23`;
    session.amppNotificationMailboxIds = ['dashboard-mailbox'];
    session.amppDashboardMatrixAccess = {
      [workloadId]: {
        dashboards: { [dashboardId]: {} },
        dashboardNodeIds: { [dashboardId]: [nodeId] },
      },
    };

    expect(service.assertApiAccess(session, workloadId, 'POST', topic(nodeId)))
      .toBe(topic(nodeId));
    expect(() => service.assertApiAccess(session, workloadId, 'POST', topic(otherNode)))
      .toThrow(ForbiddenException);
    expect(() => service.assertApiAccess(session, secondWorkloadId, 'POST', topic(nodeId)))
      .toThrow(ForbiddenException);
  });

  it('allows standalone dashboards from an authorized workload scope', () => {
    session.allowedDashboards = [
      {
        id: dashboardId,
        associatedWorkloadId: null,
        name: 'Standalone Dashboard',
        pageType: 'ampp-ui',
      },
    ];
    const dashboardPath = `/cluster/systemdashboard/dashboard/${dashboardId}`;
    const dashboardApiPath =
      `/configuration/api/v1/configuration/gv/systemdashboards/dashboards/${dashboardId}`;

    expect(service.assertUiResourceAccess(session, workloadId, dashboardPath)).toBe(dashboardPath);
    expect(service.assertUiResourceAccess(session, secondWorkloadId, dashboardPath)).toBe(dashboardPath);
    expect(service.assertApiAccess(session, workloadId, 'GET', dashboardApiPath)).toBe(dashboardApiPath);
    expect(() =>
      service.assertUiResourceAccess(session, unauthorizedWorkloadId, dashboardPath),
    ).toThrow(ForbiddenException);
  });

  it('does not expose workload-associated dashboards to other workloads', () => {
    const dashboardPath = `/cluster/systemdashboard/dashboard/${dashboardId}`;

    expect(service.assertUiResourceAccess(session, workloadId, dashboardPath)).toBe(dashboardPath);
    expect(() =>
      service.assertUiResourceAccess(session, secondWorkloadId, dashboardPath),
    ).toThrow(ForbiddenException);
  });

});
