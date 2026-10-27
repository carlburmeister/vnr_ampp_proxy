import 'express-session';

import type { AllowedDashboard } from '../../ampp/types/dashboard_types';
import type { AllowedGvuiLayout } from '../../ampp-proxy/gvui/gvui.types';
import type { GvuiMailbox } from '../../ampp-proxy/gvui/gvui-proxy.service';
import type { AllowedWorkload } from '../../ampp/types/workload_types';
import type { CookieJar } from 'tough-cookie';
import type { AuthenticatedUser } from '../auth.service';

export type AmppMatrixAccess = Record<
  string,
  {
    producerIds?: string[];
    writableProducerIds?: string[];
    producerNames?: Record<string, string>;
    consumerIds?: string[];
  }
>;

export type AmppDashboardMatrixReferences = {
  workloadIds?: string[];
  producerNames?: string[];
  consumerNames?: string[];
};

export type AmppDashboardMatrixAccess = Record<
  string,
  {
    dashboards?: Record<
      string,
      Record<string, AmppDashboardMatrixReferences>
    >;
    dashboardNodeIds?: Record<string, string[]>;
    producerIds?: string[];
    consumerIds?: string[];
  }
>;

declare module 'express-session' {
  interface SessionData {
    user?: AuthenticatedUser;
    authorizationFingerprint?: string;
    authorizationCheckedAt?: number;
    parentWorkloadId?: string;
    fabricId?: string;
    nodeId?: string;
    allowedWorkloads?: AllowedWorkload[];
    allowedDashboardIds?: string[];
    allowedDashboards?: AllowedDashboard[];
    allowedGvuiLayoutIds?: string[];
    allowedGvuiLayouts?: AllowedGvuiLayout[];
    gvuiMailboxes?: Record<string, GvuiMailbox>;
    amppAllowedWorkloadIds?: string[];
    amppResourceWorkloadIds?: string[];
    amppUserId?: string;
    amppCookieJar?: ReturnType<CookieJar['toJSON']>;
    amppAccessToken?: string;
    amppMatrixAccess?: AmppMatrixAccess;
    amppDashboardMatrixAccess?: AmppDashboardMatrixAccess;
    amppNotificationMailboxIds?: string[];
  }
}

export {};
