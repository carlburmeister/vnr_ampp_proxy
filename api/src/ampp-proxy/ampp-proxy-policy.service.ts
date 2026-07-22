import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { SessionData } from 'express-session';

import type { AllowedWorkload } from '../ampp/types/workload_types';

@Injectable()
export class AmppProxyPolicyService {
  assertUiAccess(
    session: SessionData,
    workloadId: string,
    upstreamPath: string,
  ): string {
    this.assertWorkloadAllowed(session.allowedWorkloads ?? [], workloadId);

    if (!upstreamPath?.startsWith('/') || upstreamPath.startsWith('//')) {
      throw new BadRequestException('A relative AMPP path is required');
    }

    const target = new URL(upstreamPath, 'http://ampp-proxy.local');
    const pathSegments = target.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
    const queryValues = [...target.searchParams.values()];

    if (
      !pathSegments.includes(workloadId) &&
      !queryValues.includes(workloadId)
    ) {
      throw new ForbiddenException(
        'AMPP UI path does not reference the allowed workload',
      );
    }

    return `${target.pathname}${target.search}`;
  }

  private assertWorkloadAllowed(
    allowedWorkloads: AllowedWorkload[],
    workloadId: string,
  ): void {
    const allowedIds = allowedWorkloads.flatMap((workload) => [
      workload.id,
      ...(workload.child_workloads ?? []).map(
        (childWorkload) => childWorkload.id,
      ),
    ]);

    if (!allowedIds.length) {
      throw new ForbiddenException(
        'No allowed workloads found for this session',
      );
    }

    if (!allowedIds.includes(workloadId)) {
      throw new ForbiddenException('Workload is not allowed for this session');
    }
  }
}
