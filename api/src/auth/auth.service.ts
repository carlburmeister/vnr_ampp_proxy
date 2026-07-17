import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

import { AmppControlService } from '../ampp/services/ampp-control.service';
import type {
  AllowedWorkload,
  AmppChildWorkloadsResponse,
  ExtractedWorkload,
  UserDBWorkload,
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

    const allowedWorkloads = await Promise.all(
      userDBWorkloads.map(async (workload) => {
        const workload_resp = await this.getWorkload(workload.id);

        if (workload.is_parent) {
          return {
            ...workload,
            name: workload_resp.name,
            applicationName: workload_resp.applicationName,
            fabricId: workload_resp.fabricId,
            nodeId: workload_resp.nodeId,
            child_workloads: await this.getChildWorkloads(workload.id),
          };
        }
        else {
          return {
            ...workload,
            name: workload_resp.name,
            applicationName: workload_resp.applicationName,
            fabricId: workload_resp.fabricId,
            nodeId: workload_resp.nodeId,
          };
        }

      }),
    );

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
    parentWorkloadId?: string,
  ): Promise<ExtractedWorkload[]> {
    
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
    }

    return undefined;
  }
}