import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

import { AmppControlService } from '../ampp/services/ampp-control.service';
import type {
  AllowedWorkload,
  AmppChildWorkloadsResponse,
  ChildWorkload,
  ExtractedWorkload,
  UserDBWorkload,
  WorkloadPageType,
} from '../ampp/types/workload_types';
import { UserCredentialsRepository } from '../users/services/user-credentials.repository';

export type AuthenticatedUser = {
  id: string;
  username: string;
  displayName: string;
};

export type LoginResult = {
  user: AuthenticatedUser;
  parentWorkloadId?: string;
  fabricId: string;
  nodeId: string;
  allowedWorkloads: AllowedWorkload[];
};

// Define the precise structure of your data
type AmppWorkloadResponse = {
    applicationName: string;
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
  ) {}

  /*-------------------------------------------------------------*/
  //  login()
  /*-------------------------------------------------------------*/
  async login(username: string, password: string): Promise<LoginResult> {
    
    const user = await this.userCredentials.findByUsername(username);

    if (!user || !(await this.verifyPassword(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid username or password');
    }


    /* Get user's assigned workloads from the DB */
    const userDBWorkloads = await this.getUserDBWorkloads(user.id);
    const parentDBWorkloads = userDBWorkloads.filter(
      (workload) => workload.is_parent === 1,
    );
    const individualDBWorkloads = userDBWorkloads.filter(
      (workload) => workload.is_parent === 0,
    );

    const parentAllowedWorkloads = await Promise.all(
      parentDBWorkloads.map(async (workload) => {
        const workload_resp = await this.getWorkload(workload.id);

        return {
          ...workload,
          name: workload_resp.name,
          applicationName: workload_resp.applicationName,
          fabricId: workload_resp.fabricId,
          nodeId: workload_resp.nodeId,
          child_workloads: await this.getChildWorkloads(
            workload.id,
            'custom',
          ),
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
          name: workload_resp.name,
          applicationName: workload_resp.applicationName,
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

    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
      },
      parentWorkloadId: allowedWorkloads.find((workload) => workload.is_parent)?.id,
      fabricId: firstWorkload?.fabricId ?? '',
      nodeId: firstWorkload?.nodeId ?? '',
      allowedWorkloads,
    };
  }
  /*-------------------------------------------------------------*/
  //  verifyPassword()
  /*-------------------------------------------------------------*/
  private async verifyPassword(
    password: string,
    passwordHash: string,
  ): Promise<boolean> {
    return bcrypt.compare(password, passwordHash)
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
      applicationName: item.workload.applicationName ?? item.workload.packageName ?? '',
      fabricId: item.workload.fabricId,
      nodeId: item.workload.state?.nodeId ?? '',
      is_parent: 0,
      pageType,
    }));
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
          fabricId: workload.fabricId ?? '',
          nodeId: workload.nodeId ?? '',
        };
      }
    }

    return undefined;
  }
}