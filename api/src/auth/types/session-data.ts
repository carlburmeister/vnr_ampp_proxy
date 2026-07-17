import 'express-session';

import type { AllowedWorkload } from '../../ampp/types/workload_types';
import type { AuthenticatedUser } from '../auth.service';

declare module 'express-session' {
  interface SessionData {
    user?: AuthenticatedUser;
    parentWorkloadId?: string;
    fabricId?: string;
    nodeId?: string; 
    allowedWorkloads?: AllowedWorkload[];
  }
}

export {};