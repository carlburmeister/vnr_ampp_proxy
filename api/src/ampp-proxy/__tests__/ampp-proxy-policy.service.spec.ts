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
});
