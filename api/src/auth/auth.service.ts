import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { SessionData } from 'express-session';
import * as bcrypt from 'bcrypt';

import { AmppControlService } from '../ampp/services/ampp-control.service';
import type { AllowedDashboard } from '../ampp/types/dashboard_types';
import type {
  AllowedWorkload,
  AmppChildWorkloadsResponse,
  ChildWorkload,
  ExtractedWorkload,
  UserDBWorkload,
  WorkloadPageType,
} from '../ampp/types/workload_types';
import { UserCredentialsRepository, type UserCredentialRecord } from '../users/services/user-credentials.repository';

export type AuthenticatedUser = {
  id: string;
  username: string;
  displayName: string;
  clientId: number;
  userType: 'admin' | 'user';
};

export type LoginResult = {
  user: AuthenticatedUser;
  parentWorkloadId?: string;
  fabricId: string;
  nodeId: string;
  allowedWorkloads: AllowedWorkload[];
  allowedDashboardIds: string[];
  allowedDashboards: AllowedDashboard[];
  amppAllowedWorkloadIds: string[];
  amppResourceWorkloadIds: string[];
  authorizationFingerprint: string;
};

// Define the precise structure of your data
type AmppWorkloadResponse = {
    applicationName: string;
    packageName: string;
    id: string;
    name: string;
    fabricId: string;
    state?: {
      nodeId?: string;
    };
};

@Injectable()
export class AuthService {
  constructor(
    private readonly userCredentials: UserCredentialsRepository,
    private readonly amppControl: AmppControlService,
    private readonly config?: ConfigService,
  ) {}

  /*-------------------------------------------------------------*/
  //  login()
  /*-------------------------------------------------------------*/
  async login(username: string, password: string): Promise<LoginResult> {
    
    const user = await this.userCredentials.findByUsername(username);

    if (!user || !(await this.verifyPassword(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid username or password');
    }


    return this.buildAuthorization(user);
  }
  /*-------------------------------------------------------------*/
  //  refreshSessionAuthorization()
  //  Recheck on a configurable interval; refresh permissions when changed.
  /*-------------------------------------------------------------*/
  async refreshSessionAuthorization(session: SessionData): Promise<boolean> {
    if (!session.user) {
      throw new UnauthorizedException('Login required');
    }

    const interval = Math.max(0, Number(
      this.config?.get<string>('AUTH_PERMISSION_REFRESH_INTERVAL_MS') ?? 10000,
    ) || 0);
    if (session.authorizationCheckedAt &&
        Date.now() - session.authorizationCheckedAt < interval) {
      return false;
    }

    const user = await this.userCredentials.findById(session.user.id);
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }

    const [workloads, dashboards, denials] = await Promise.all([
      this.getUserDBWorkloads(user.id),
      this.userCredentials.getUserDashboards(user.id),
      this.userCredentials.getWorkloadDenials(user.id),
    ]);
    const fingerprint = this.getFingerprint(user, workloads, dashboards, denials);
    session.authorizationCheckedAt = Date.now();
    if (session.authorizationFingerprint === fingerprint && session.amppResourceWorkloadIds) {
      // Refresh display labels without rebuilding authorization or changing access.
      const resolved = await this.withAmppDashboardNames(dashboards);
      const dashboardNames = new Map(resolved.map((item) => [item.id.toLowerCase(), item.name]));
      session.allowedDashboards = (session.allowedDashboards ?? []).map((dashboard) => ({
        ...dashboard,
        name: dashboardNames.get(dashboard.id.toLowerCase()) ?? dashboard.name,
      }));
      const registeredNames = new Map(await Promise.all(workloads.map(async (workload) => [
        workload.id.toLowerCase(),
        await this.amppControl.getWorkloadName(workload.id) || workload.name,
      ] as const)));
      session.allowedWorkloads = (session.allowedWorkloads ?? []).map((workload) => ({
        ...workload,
        name: registeredNames.get(workload.id.toLowerCase()) ?? workload.name,
        child_workloads: workload.child_workloads?.map((child) => ({
          ...child,
          name: registeredNames.get(child.id.toLowerCase()) ?? child.name,
        })),
      }));
      return true; // Persist the recheck time to avoid re-querying on every request.
    }

    const result = await this.buildAuthorization(user, workloads, dashboards, denials);
    const clientChanged = session.user.clientId !== result.user.clientId;
    this.applyAuthorization(session, result);
    session.amppMatrixAccess = undefined;
    session.amppDashboardMatrixAccess = undefined;
    session.amppNotificationMailboxIds = undefined;
    if (clientChanged) {
      session.amppUserId = undefined;
      session.amppAccessToken = undefined;
      session.amppCookieJar = undefined;
    }
    return true;
  }
  /*-------------------------------------------------------------*/
  //  applyAuthorization()
  /*-------------------------------------------------------------*/
  applyAuthorization(session: SessionData, result: LoginResult): void {
    session.user = result.user;
    session.parentWorkloadId = result.parentWorkloadId;
    session.fabricId = result.fabricId;
    session.nodeId = result.nodeId;
    session.allowedWorkloads = result.allowedWorkloads;
    session.allowedDashboardIds = result.allowedDashboardIds;
    session.allowedDashboards = result.allowedDashboards;
    session.amppAllowedWorkloadIds = result.amppAllowedWorkloadIds;
    session.amppResourceWorkloadIds = result.amppResourceWorkloadIds;
    session.authorizationFingerprint = result.authorizationFingerprint;
    session.authorizationCheckedAt = Date.now();
  }
  private async withAmppDashboardNames(dashboards: AllowedDashboard[]): Promise<AllowedDashboard[]> {
    if (!dashboards.some((dashboard) => dashboard.pageType === 'ampp-ui')) return dashboards;
    const names = await this.amppControl.getDashboardNames();
    return dashboards.map((dashboard) => ({
      ...dashboard,
      name: dashboard.pageType === 'ampp-ui'
        ? names.get(dashboard.id.toLowerCase()) || dashboard.name
        : dashboard.name,
    }));
  }

  /*-------------------------------------------------------------*/
  //  buildAuthorization()
  /*-------------------------------------------------------------*/
  private async buildAuthorization(
    user: UserCredentialRecord,
    suppliedWorkloads?: UserDBWorkload[],
    suppliedDashboards?: AllowedDashboard[],
    suppliedDenials?: string[],
  ): Promise<LoginResult> {
    /* Get user's assigned workloads from the DB */
    const [userDBWorkloads, assignedDashboards, deniedIds] = await Promise.all([
      suppliedWorkloads ?? this.getUserDBWorkloads(user.id),
      suppliedDashboards ?? this.userCredentials.getUserDashboards(user.id),
      suppliedDenials ?? this.userCredentials.getWorkloadDenials(user.id),
    ]);
    const denied = new Set(deniedIds.map((id) => id.toLowerCase()));
    const activeDBWorkloads = userDBWorkloads.filter(
      (workload) => !denied.has(workload.id.toLowerCase()),
    );
    const parentDBWorkloads = activeDBWorkloads.filter(
      (workload) => workload.is_parent === 1,
    );
    const individualDBWorkloads = activeDBWorkloads.filter(
      (workload) => workload.is_parent === 0,
    );

    // Parent workload access also permits read-only producer discovery for denied children.
    const resourceChildren = new Map<string, ChildWorkload[]>();
    const parentAllowedWorkloads = await Promise.all(
      parentDBWorkloads.map(async (workload) => {
        const workload_resp = await this.getWorkload(workload.id);
        const children = await this.getChildWorkloads(workload.id, workload.pageType);
        resourceChildren.set(workload.id.toLowerCase(), children);

        return {
          ...workload,
          name: workload_resp.name || workload.name,
          applicationName: workload_resp.applicationName,
          packageName: workload_resp.packageName,
          fabricId: workload_resp.fabricId,
          nodeId: workload_resp.nodeId,
          child_workloads: children.filter((child) => !denied.has(child.id.toLowerCase())),
        };
      }),
    );

    const parentChildWorkloadIds = new Set(
      parentAllowedWorkloads.flatMap((parentWorkload) =>
        parentWorkload.child_workloads.map((childWorkload) => childWorkload.id),
      ),
    );

    for (const individualWorkload of individualDBWorkloads) {
      for (const parentWorkload of parentAllowedWorkloads) {
        const matchingChildWorkload = parentWorkload.child_workloads.find(
          (childWorkload) => childWorkload.id === individualWorkload.id,
        );

        if (matchingChildWorkload) {
          // AMPP is authoritative for child display names; only override page type.
          matchingChildWorkload.pageType = individualWorkload.pageType;
        }
      }
    }

    const standaloneDBWorkloads = individualDBWorkloads.filter(
      (workload) => !parentChildWorkloadIds.has(workload.id),
    );

    const standaloneAllowedWorkloads = await Promise.all(
      standaloneDBWorkloads.map(async (workload) => {
        const workload_resp = await this.getWorkload(workload.id);

        return {
          ...workload,
          name: workload_resp.name || workload.name,
          applicationName: workload_resp.applicationName,
          packageName: workload_resp.packageName,
          fabricId: workload_resp.fabricId,
          nodeId: workload_resp.nodeId,
        };
      }),
    );

    const allowedWorkloads: AllowedWorkload[] = [
      ...parentAllowedWorkloads,
      ...standaloneAllowedWorkloads,
    ];

    const firstWorkload = this.getFirstResolvedWorkload(allowedWorkloads);
    const amppAllowedWorkloadIds = await this.getAmppAllowedWorkloadIds(
      allowedWorkloads, denied,
    );
    // Never expose these IDs through the SPA workload selector or UI authorization.
    // Include AMPP-discovered descendants of authorized parents, even if their UIs are denied.
    const resourceParents = parentAllowedWorkloads.map((parent) => ({
      ...parent,
      child_workloads: resourceChildren.get(parent.id.toLowerCase()) ?? [],
    }));
    const amppResourceWorkloadIds = await this.getAmppAllowedWorkloadIds([
      ...resourceParents,
      ...standaloneAllowedWorkloads,
    ]);
    const effectiveIds = new Set(amppAllowedWorkloadIds.map((id) => id.toLowerCase()));
    const allowedDashboards = await this.withAmppDashboardNames(assignedDashboards.filter(
      (dashboard) => dashboard.associatedWorkloadId === null ||
        effectiveIds.has(dashboard.associatedWorkloadId.toLowerCase()),
    ));

    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        clientId: user.clientId,
        userType: user.userType,
      },
      parentWorkloadId: allowedWorkloads.find((workload) => workload.is_parent)?.id,
      fabricId: firstWorkload?.fabricId ?? '',
      nodeId: firstWorkload?.nodeId ?? '',
      allowedWorkloads,
      allowedDashboardIds: allowedDashboards.map((dashboard) => dashboard.id),
      allowedDashboards,
      amppAllowedWorkloadIds,
      amppResourceWorkloadIds,
      authorizationFingerprint: this.getFingerprint(user, userDBWorkloads, assignedDashboards, deniedIds),
    };
  }
  /*-------------------------------------------------------------*/
  //  getFingerprint()
  /*-------------------------------------------------------------*/
  private getFingerprint(
    user: UserCredentialRecord,
    workloads: UserDBWorkload[],
    dashboards: AllowedDashboard[],
    denials: string[],
  ): string {
    const sorted = <T>(items: T[], selector: (item: T) => string) =>
      items.map(selector).sort();
    return createHash('sha256').update(JSON.stringify({
      clientId: user.clientId,
      userType: user.userType,
      username: user.username,
      displayName: user.displayName,
      workloads: sorted(workloads, (w) => `${w.id.toLowerCase()}:${w.is_parent}:${w.pageType}:${w.name}`),
      dashboards: sorted(dashboards, (d) => `${d.id.toLowerCase()}:${d.associatedWorkloadId?.toLowerCase() ?? ''}:${d.name}:${d.pageType}`),
      denials: denials.map((id) => id.toLowerCase()).sort(),
    })).digest('hex');
  }
  /*-------------------------------------------------------------*/
  //  verifyPassword()
  /*-------------------------------------------------------------*/
  private async verifyPassword(
    password: string,
    passwordHash: string,
  ): Promise<boolean> {
    const compatibleHash = passwordHash.startsWith('$2y$')
      ? '$2b$' + passwordHash.slice(4)
      : passwordHash;
    return bcrypt.compare(password, compatibleHash);
  }
  /*-------------------------------------------------------------*/
  //  getUserDBWorkloads()
  /*-------------------------------------------------------------*/
  private async getUserDBWorkloads(userId: string): Promise<UserDBWorkload[]> {
    return this.userCredentials.getUserDBWorkloads(userId);
  }
  /*-------------------------------------------------------------*/
  //  getWorkload()
  /*-------------------------------------------------------------*/
  private async getWorkload(
    workloadId?: string,
  ): Promise<ExtractedWorkload> {
    
    if (!workloadId) {
      throw new Error('workloadId is required');
    }

    const response = (await this.amppControl.getWorkload(
      workloadId,
    )) as unknown as AmppWorkloadResponse;

    // Map the array into the new object structure
    return {
      id: response.id,
      name: response.name,
      applicationName: response.applicationName,
      packageName: response.packageName,
      fabricId: response.fabricId,
      nodeId: response.state?.nodeId ?? '',
    };
  }
  /*-------------------------------------------------------------*/
  //  getChildWorkloads()
  /*-------------------------------------------------------------*/
  private async getChildWorkloads(
    parentWorkloadId: string | undefined,
    pageType: WorkloadPageType,
  ): Promise<ChildWorkload[]> {
    
    if (!parentWorkloadId) {
      return [];
    }

    const response = (await this.amppControl.listChildWorkloads(
      parentWorkloadId,
    )) as unknown as AmppChildWorkloadsResponse;

    // Map the array into the new object structure
    return (response?.workloads ?? []).map((item) => ({
      id: item.workload.id,
      name: item.workload.name,
      applicationName: item.workload.applicationName ?? '',
      packageName: item.workload.packageName ?? '',
      fabricId: item.workload.fabricId,
      nodeId: item.workload.state?.nodeId ?? '',
      is_parent: 0,
      pageType,
    }));
  }
  /*-------------------------------------------------------------*/
  //  getAmppAllowedWorkloadIds()
  /*-------------------------------------------------------------*/
  private async getAmppAllowedWorkloadIds(
    allowedWorkloads: AllowedWorkload[],
    denied = new Set<string>(),
  ): Promise<string[]> {
    const allowedIds = new Set<string>();

    const visit = async (
      workloadId: string,
      knownChildIds?: string[],
    ): Promise<void> => {
      if (allowedIds.has(workloadId.toLowerCase()) || denied.has(workloadId.toLowerCase())) {
        return;
      }

      allowedIds.add(workloadId.toLowerCase());

      let childIds = knownChildIds;

      if (!childIds) {
        const response = (await this.amppControl.listChildWorkloads(
          workloadId,
        )) as unknown as AmppChildWorkloadsResponse;

        childIds = (response?.workloads ?? []).map(
          (item) => item.workload.id,
        );
      }

      await Promise.all(childIds.map((childId) => visit(childId)));
    };

    await Promise.all(
      allowedWorkloads.map((workload) =>
        visit(
          workload.id,
          workload.child_workloads?.map((childWorkload) => childWorkload.id),
        ),
      ),
    );

    return [...allowedIds];
  }
  /*-------------------------------------------------------------*/
  //  getFirstResolvedWorkload()
  /*-------------------------------------------------------------*/
  private getFirstResolvedWorkload(
    allowedWorkloads: AllowedWorkload[],
  ): ExtractedWorkload | undefined {
    for (const workload of allowedWorkloads) {
      const firstChildWorkload = workload.child_workloads?.[0];

      if (firstChildWorkload) {
        return firstChildWorkload;
      }

      if (workload.is_parent === 0) {
        return {
          id: workload.id,
          name: workload.name,
          applicationName: workload.applicationName ?? '',
          packageName: workload.packageName ?? '',
          fabricId: workload.fabricId ?? '',
          nodeId: workload.nodeId ?? '',
        };
      }
    }

    return undefined;
  }
}
