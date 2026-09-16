import type { SessionData } from 'express-session';

import { AmppDashboardFilterService } from '../ampp-dashboard-filter.service';
import { AmppMatrixFilterService } from '../ampp-matrix-filter.service';

const PLATFORM_URL = 'https://us-east-1.gvampp.com';
const DASHBOARD_SCOPE_ID = 'fb37856d-f3c3-483c-8114-857923e3878f';
const OTHER_SCOPE_ID = '11111111-2222-4333-8444-555555555555';
const DASHBOARD_ID = 'c3a232b3-cbcd-42f5-b767-d2b62fdf3f1d';
const FABRIC_ID = '24319621-6be3-411c-923f-a12c2b1eca48';
const ALLOWED_WORKLOAD_ID = 'cbda2ccd-a99f-4c6a-8e82-1e0948858441';
const DASHBOARD_ONLY_WORKLOAD_ID = 'a89d7b25-1111-4222-8333-eeeeeeeeeeee';
const UNRELATED_WORKLOAD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DASHBOARD_PRODUCER_ID = '9ee76b39-e963-4225-b8d3-3e6c094ebf73';
const DASHBOARD_CONSUMER_ID = 'd31547c2-e226-4509-a8ad-797a91951370';

describe('dashboard Matrix visibility', () => {
  const config = { getOrThrow: () => PLATFORM_URL } as any;
  const dashboardFilter = new AmppDashboardFilterService(config);
  const matrixFilter = new AmppMatrixFilterService(config);
  let session: SessionData;

  beforeEach(() => {
    session = {
      allowedWorkloads: [
        {
          id: DASHBOARD_SCOPE_ID,
          name: 'Dashboard scope',
          is_parent: 0,
          pageType: 'ampp-ui',
          fabricId: FABRIC_ID,
        },
        {
          id: ALLOWED_WORKLOAD_ID,
          name: 'Allowed workload',
          is_parent: 0,
          pageType: 'ampp-ui',
          fabricId: FABRIC_ID,
        },
      ],
      allowedDashboardIds: [DASHBOARD_ID],
      allowedDashboards: [
        {
          id: DASHBOARD_ID,
          associatedWorkloadId: DASHBOARD_SCOPE_ID,
          name: 'Dashboard',
          pageType: 'ampp-ui',
        },
      ],
      amppAllowedWorkloadIds: [DASHBOARD_SCOPE_ID, ALLOWED_WORKLOAD_ID],
    } as SessionData;
  });

  it('captures only the authorized dashboard Matrix references', () => {
    dashboardFilter.filterApiResponse(
      session,
      DASHBOARD_SCOPE_ID,
      `/configuration/api/v1/configuration/gv/systemdashboards/dashboards/${DASHBOARD_ID}`,
      jsonResponse({
        key: `gv/systemdashboards/dashboards/${DASHBOARD_ID}`,
        value: JSON.stringify({
          nodes: {
            producer: {
              config: {
                fabricId: FABRIC_ID,
                producerName: 'HPz6: TSG',
              },
            },
            consumer: {
              config: {
                fabricId: FABRIC_ID,
                consumerName: 'HPz6L:CKB Test Prod - Virtual Crosspoint-04',
              },
            },
            workload: {
              config: {
                fabricId: FABRIC_ID,
                workloadId: DASHBOARD_ONLY_WORKLOAD_ID,
              },
            },
          },
        }),
      }),
    );

    const references =
      session.amppDashboardMatrixAccess?.[DASHBOARD_SCOPE_ID]?.dashboards?.[
        DASHBOARD_ID
      ]?.[FABRIC_ID];

    expect(references).toEqual({
      workloadIds: [DASHBOARD_ONLY_WORKLOAD_ID],
      producerNames: ['HPz6: TSG'],
      consumerNames: ['HPz6L:CKB Test Prod - Virtual Crosspoint-04'],
    });
  });

  it('shows dashboard-only Matrix entities without adding them to write access', () => {
    session.amppDashboardMatrixAccess = {
      [DASHBOARD_SCOPE_ID]: {
        dashboards: {
          [DASHBOARD_ID]: {
            [FABRIC_ID]: {
              producerNames: ['HPz6: TSG'],
              consumerNames: [
                'HPz6L:CKB Test Prod - Virtual Crosspoint-04',
              ],
            },
          },
        },
      },
    };

    const producers = matrixFilter.filterApiResponse(
      session,
      DASHBOARD_SCOPE_ID,
      `/cluster/matrix/api/v1/producers?fabricId=${FABRIC_ID}&type=Fabric`,
      jsonResponse({
        producers: [
          wrapped('producer', {
            id: '00000000-0000-4000-8000-000000000001',
            name: 'Authorized producer',
            workloadId: ALLOWED_WORKLOAD_ID,
            fabricId: FABRIC_ID,
          }),
          wrapped('producer', {
            id: DASHBOARD_PRODUCER_ID,
            name: 'HPz6: TSG',
            workloadId: DASHBOARD_ONLY_WORKLOAD_ID,
            fabricId: FABRIC_ID,
          }),
          wrapped('producer', {
            id: '00000000-0000-4000-8000-000000000003',
            name: 'Unrelated producer',
            workloadId: UNRELATED_WORKLOAD_ID,
            fabricId: FABRIC_ID,
          }),
        ],
      }),
    );
    const producerBody = JSON.parse(producers.body.toString('utf8'));

    expect(producerBody.producers).toHaveLength(2);
    expect(
      producerBody.producers.map((item: any) => item.producer.id),
    ).toContain(DASHBOARD_PRODUCER_ID);
    expect(
      session.amppMatrixAccess?.[FABRIC_ID]?.producerIds,
    ).not.toContain(DASHBOARD_PRODUCER_ID);
    expect(
      session.amppDashboardMatrixAccess?.[DASHBOARD_SCOPE_ID]?.producerIds,
    ).toContain(DASHBOARD_PRODUCER_ID);

    const consumers = matrixFilter.filterApiResponse(
      session,
      DASHBOARD_SCOPE_ID,
      `/cluster/matrix/api/v1/consumers?fabricId=${FABRIC_ID}&type=Fabric`,
      jsonResponse({
        consumers: [
          wrapped('consumer', {
            id: DASHBOARD_CONSUMER_ID,
            name: 'HPz6L:CKB Test Prod - Virtual Crosspoint-04',
            workloadId: UNRELATED_WORKLOAD_ID,
            fabricId: FABRIC_ID,
            routedProducerId: DASHBOARD_PRODUCER_ID,
          }),
        ],
      }),
    );
    const consumerBody = JSON.parse(consumers.body.toString('utf8'));

    expect(consumerBody.consumers[0].consumer.routedProducerId).toBe(
      DASHBOARD_PRODUCER_ID,
    );
    expect(
      session.amppMatrixAccess?.[FABRIC_ID]?.consumerIds ?? [],
    ).not.toContain(DASHBOARD_CONSUMER_ID);
  });

  it('does not apply dashboard-only Matrix visibility to another proxy scope', () => {
    session.amppDashboardMatrixAccess = {
      [DASHBOARD_SCOPE_ID]: {
        dashboards: {
          [DASHBOARD_ID]: {
            [FABRIC_ID]: { producerNames: ['HPz6: TSG'] },
          },
        },
      },
    };

    const response = matrixFilter.filterApiResponse(
      session,
      OTHER_SCOPE_ID,
      `/cluster/matrix/api/v1/producers?fabricId=${FABRIC_ID}&type=Fabric`,
      jsonResponse({
        producers: [
          wrapped('producer', {
            id: DASHBOARD_PRODUCER_ID,
            name: 'HPz6: TSG',
            workloadId: DASHBOARD_ONLY_WORKLOAD_ID,
            fabricId: FABRIC_ID,
          }),
        ],
      }),
    );

    expect(JSON.parse(response.body.toString('utf8')).producers).toEqual([]);
  });
});

function wrapped(key: string, value: Record<string, unknown>) {
  return { [key]: value };
}

function jsonResponse(value: unknown) {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(value)),
    url: PLATFORM_URL,
  };
}
