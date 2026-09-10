import 'express-session';

import type { AllowedWorkload } from '../../ampp/types/workload_types';
import type { CookieJar } from 'tough-cookie';
import type { AuthenticatedUser } from '../auth.service';

export type AmppMatrixAccess = Record<
  string,
  {
    producerIds?: string[];
    consumerIds?: string[];
  }
>;

declare module 'express-session' {
  interface SessionData {
    user?: AuthenticatedUser;
    parentWorkloadId?: string;
    fabricId?: string;
    nodeId?: string;
    allowedWorkloads?: AllowedWorkload[];
    amppAllowedWorkloadIds?: string[];
    amppCookieJar?: ReturnType<CookieJar['toJSON']>;
    amppAccessToken?: string;
    amppMatrixAccess?: AmppMatrixAccess;
  }
}

export {};
