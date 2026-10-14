import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { RowDataPacket, PoolConnection } from 'mysql2/promise';

import { AmppControlService } from '../../ampp/services/ampp-control.service';
import type { AmppChildWorkloadsResponse } from '../../ampp/types/workload_types';
import type { AuthenticatedUser } from '../../auth/auth.service';
import { UserCredentialsRepository } from './user-credentials.repository';

export type PermissionChanges = {
  workloadIds: number[];
  dashboardIds: number[];
  deniedChildWorkloadIds: string[];
};

type IdRow = RowDataPacket & { row_id: number };
type WorkloadRow = IdRow & { workload_id: string; is_parent: number };

@Injectable()
export class ClientPermissionsService {
  constructor(
    private readonly users: UserCredentialsRepository,
    private readonly ampp: AmppControlService,
  ) {}

  private async assertAdmin(db: PoolConnection, actor: AuthenticatedUser) {
    const [rows] = await db.execute<(RowDataPacket & { client_id: number; user_type: string })[]>(
      'SELECT client_id, user_type FROM client_users WHERE row_id=?', [actor.id],
    );
    if (rows[0]?.client_id !== actor.clientId || rows[0]?.user_type !== 'admin') {
      throw new ForbiddenException('Client admin access required');
    }
  }

  private async assertClientUser(db: PoolConnection, userId: number, clientId: number) {
    const [rows] = await db.execute<(RowDataPacket & { client_id: number })[]>(
      'SELECT client_id FROM client_users WHERE row_id=?', [userId],
    );
    if (rows[0]?.client_id !== clientId) {
      throw new ForbiddenException('User does not belong to your client');
    }
  }

  async listUsers(actor: AuthenticatedUser) {
    return this.users.withConnection(async (db) => {
      await this.assertAdmin(db, actor);
      const [rows] = await db.execute<RowDataPacket[]>(
        `SELECT row_id AS id, username, first_name AS firstName,
                last_name AS lastName, user_type AS userType
         FROM client_users WHERE client_id=? ORDER BY username`, [actor.clientId],
      );
      return rows;
    });
  }

  async listResources(actor: AuthenticatedUser) {
    const resources = await this.users.withConnection(async (db) => {
      await this.assertAdmin(db, actor);
      const [[workloads], [dashboards]] = await Promise.all([
        db.execute<(RowDataPacket & { workloadId: string; isParent: number; name: string })[]>(
          `SELECT row_id AS id, workload_id AS workloadId, name,
                  is_parent AS isParent, page_type AS pageType
           FROM ampp_workloads WHERE client_id=? ORDER BY is_parent DESC, name`,
          [actor.clientId],
        ),
        db.execute<RowDataPacket[]>(
          `SELECT row_id AS id, dashboard_id AS dashboardId, name,
                  associated_workload_id AS associatedWorkloadId, page_type AS pageType
           FROM ampp_dashboards WHERE client_id=? ORDER BY name`,
          [actor.clientId],
        ),
      ]);
      return { workloads, dashboards };
    });
    // Resolve names only after verifying client-admin access and client ownership.
    const [dashboardNames, workloadNames] = await Promise.all([
      this.ampp.getDashboardNames(),
      Promise.all(resources.workloads.map((workload) =>
        this.ampp.getWorkloadName(workload.workloadId as string))),
    ]);
    return {
      workloads: resources.workloads.map((workload, i) => ({
        ...workload, name: workloadNames[i] || workload.name,
      })).sort((a, b) => (Number(b.isParent) - Number(a.isParent)) ||
        String(a.name).localeCompare(String(b.name), undefined, { numeric: true })),
      dashboards: resources.dashboards.map((dashboard) => ({
        ...dashboard,
        name: dashboard.pageType === 'ampp-ui'
          ? dashboardNames.get(String(dashboard.dashboardId).toLowerCase()) || dashboard.name
          : dashboard.name,
      })).sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true })),
    };
  }

  async getPermissions(actor: AuthenticatedUser, userId: number) {
    return this.users.withConnection(async (db) => {
      await this.assertAdmin(db, actor);
      await this.assertClientUser(db, userId, actor.clientId);
      const [[workloads], [dashboards], [denials]] = await Promise.all([
        db.execute<(RowDataPacket & { id: number })[]>(
          `SELECT p.ampp_workload_id AS id FROM client_user_workload_permissions p
           JOIN ampp_workloads w ON w.row_id=p.ampp_workload_id
           WHERE p.user_id=? AND w.client_id=?`, [userId, actor.clientId],
        ),
        db.execute<(RowDataPacket & { id: number })[]>(
          `SELECT p.ampp_dashboard_id AS id FROM client_user_dashboard_permissions p
           JOIN ampp_dashboards d ON d.row_id=p.ampp_dashboard_id
           WHERE p.user_id=? AND d.client_id=?`, [userId, actor.clientId],
        ),
        db.execute<(RowDataPacket & { workload_id: string })[]>(
          'SELECT workload_id FROM client_user_workload_denials WHERE user_id=?', [userId],
        ),
      ]);
      return {
        workloadIds: workloads.map((row) => row.id),
        dashboardIds: dashboards.map((row) => row.id),
        deniedChildWorkloadIds: denials.map((row) => row.workload_id),
      };
    });
  }

  private async discoverChildDetails(parentIds: string[]) {
    const children = new Map<string, { id: string; name: string; parentId: string; depth: number }>();
    const visited = new Set<string>();
    const queue = parentIds.map((id) => ({ id, depth: 0 }));
    while (queue.length) {
      const { id, depth } = queue.shift()!;
      if (visited.has(id.toLowerCase())) continue;
      visited.add(id.toLowerCase());
      if (visited.size > 1000) throw new BadRequestException('Too many discovered child workloads');
      const response = await this.ampp.listChildWorkloads(id) as unknown as AmppChildWorkloadsResponse;
      for (const item of response?.workloads ?? []) {
        if (!item.workload?.id) continue;
        const childId = item.workload.id.toLowerCase();
        if (parentIds.some((parent) => parent.toLowerCase() === childId)) continue;
        if (!children.has(childId)) {
          children.set(childId, {
            id: childId,
            name: item.workload.name || item.workload.alias || childId,
            parentId: id,
            depth: depth + 1,
          });
        }
        if (!visited.has(childId)) queue.push({ id: childId, depth: depth + 1 });
      }
    }
    return [...children.values()];
  }

  private async discoverChildren(parentIds: string[]): Promise<Set<string>> {
    return new Set((await this.discoverChildDetails(parentIds)).map((child) => child.id));
  }

  async listChildWorkloads(actor: AuthenticatedUser, workloadRowId: number) {
    const parentId = await this.users.withConnection(async (db) => {
      await this.assertAdmin(db, actor);
      const [rows] = await db.execute<WorkloadRow[]>(
        'SELECT row_id, workload_id, is_parent FROM ampp_workloads WHERE row_id=? AND client_id=?',
        [workloadRowId, actor.clientId],
      );
      if (!rows[0]?.is_parent) throw new ForbiddenException('Parent workload not available for your client');
      return rows[0].workload_id;
    });
    const response = await this.ampp.listChildWorkloads(parentId) as unknown as AmppChildWorkloadsResponse;
    return (response?.workloads ?? [])
      .filter((item) => item.workload?.id)
      .map((item) => ({
        id: item.workload.id.toLowerCase(),
        name: item.workload.name || item.workload.alias || item.workload.id,
        parentId,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  async replacePermissions(actor: AuthenticatedUser, userId: number, changes: PermissionChanges) {
    const workloadIds = [...new Set(changes.workloadIds)];
    const dashboardIds = [...new Set(changes.dashboardIds)];
    const deniedIds = [...new Set(changes.deniedChildWorkloadIds.map((id) => id.toLowerCase()))];

    // Validate discovered children before opening a database transaction.
    const assignedParents = await this.users.withConnection(async (db) => {
      await this.assertAdmin(db, actor);
      await this.assertClientUser(db, userId, actor.clientId);
      const [rows] = workloadIds.length ? await db.query<WorkloadRow[]>(
        'SELECT row_id, workload_id, is_parent FROM ampp_workloads WHERE client_id=? AND row_id IN (?)',
        [actor.clientId, workloadIds],
      ) : [[] as WorkloadRow[], []];
      if (rows.length !== workloadIds.length) throw new BadRequestException('Invalid workload assignment');
      return rows.filter((row) => row.is_parent).map((row) => row.workload_id);
    });
    if (deniedIds.length) {
      if (!assignedParents.length) throw new BadRequestException('Child denials require an assigned parent');
      const children = await this.discoverChildren(assignedParents);
      if (deniedIds.some((id) => !children.has(id))) {
        throw new BadRequestException('Denied workload must be a child of an assigned parent');
      }
    }

    return this.users.withConnection(async (db) => {
      await db.beginTransaction();
      try {
        // Serialize writes with the Admin tool's client-user role/client changes.
        const [clientRows] = await db.execute<IdRow[]>(
          'SELECT row_id FROM clients WHERE row_id=? FOR UPDATE', [actor.clientId],
        );
        if (!clientRows.length) throw new ForbiddenException('Client not found');
        await this.assertAdmin(db, actor);
        await this.assertClientUser(db, userId, actor.clientId);
        const [workloads] = workloadIds.length ? await db.query<WorkloadRow[]>(
          'SELECT row_id, workload_id, is_parent FROM ampp_workloads WHERE client_id=? AND row_id IN (?) FOR UPDATE',
          [actor.clientId, workloadIds],
        ) : [[] as WorkloadRow[], []];
        const [dashboards] = dashboardIds.length ? await db.query<IdRow[]>(
          'SELECT row_id FROM ampp_dashboards WHERE client_id=? AND row_id IN (?) FOR UPDATE',
          [actor.clientId, dashboardIds],
        ) : [[] as IdRow[], []];
        if (workloads.length !== workloadIds.length || dashboards.length !== dashboardIds.length) {
          throw new BadRequestException('Assignments must belong to your client');
        }
        if (deniedIds.length && !assignedParents.every((id) =>
          workloads.some((row) => row.is_parent && row.workload_id === id))) {
          throw new BadRequestException('Parent assignments changed; retry');
        }
        await db.execute('DELETE FROM client_user_workload_permissions WHERE user_id=?', [userId]);
        await db.execute('DELETE FROM client_user_dashboard_permissions WHERE user_id=?', [userId]);
        await db.execute('DELETE FROM client_user_workload_denials WHERE user_id=?', [userId]);
        for (const id of workloadIds) {
          await db.execute(
            'INSERT INTO client_user_workload_permissions (user_id, ampp_workload_id, created_by_user_id) VALUES (?, ?, ?)',
            [userId, id, actor.id],
          );
        }
        for (const id of dashboardIds) {
          await db.execute(
            'INSERT INTO client_user_dashboard_permissions (user_id, ampp_dashboard_id, created_by_user_id) VALUES (?, ?, ?)',
            [userId, id, actor.id],
          );
        }
        for (const id of deniedIds) {
          await db.execute(
            'INSERT INTO client_user_workload_denials (user_id, workload_id, created_by_user_id) VALUES (?, ?, ?)',
            [userId, id, actor.id],
          );
        }
        await db.commit();
        return { workloadIds, dashboardIds, deniedChildWorkloadIds: deniedIds };
      } catch (error) {
        await db.rollback();
        throw error;
      }
    });
  }
}
