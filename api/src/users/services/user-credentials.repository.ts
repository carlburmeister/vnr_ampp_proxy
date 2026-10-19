import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPool,
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from 'mysql2/promise';

import type { AllowedDashboard } from '../../ampp/types/dashboard_types';
import type {
  UserDBWorkload,
  WorkloadPageType,
} from '../../ampp/types/workload_types';

export type UserCredentialRecord = {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  parentWorkloadId?: string;
  clientId: number;
  userType: 'admin' | 'user';
};

type UserCredentialRow = RowDataPacket & {
  user_id: number | string;
  client_id: number;
  user_type: 'admin' | 'user';
  client_name: string;
  username: string;
  password_hash: string;
  workload_id: string | null;
};

type UserDBWorkloadRow = RowDataPacket & {
  workload_id: string;
  name: string;
  is_parent: 0 | 1 | boolean;
  page_type: WorkloadPageType;
};

type UserDashboardRow = RowDataPacket & {
  dashboard_id: string;
  associated_workload_id: string | null;
  name: string;
  page_type: AllowedDashboard['pageType'];
};

@Injectable()
export class UserCredentialsRepository implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(private readonly config: ConfigService) {
    this.pool = createPool({
      host: this.config.get<string>('MYSQL_HOST'),
      port: Number(this.config.get<string>('MYSQL_PORT') ?? 3306),
      user: this.config.get<string>('MYSQL_USER'),
      password: this.config.get<string>('MYSQL_PASSWORD'),
      database: this.config.get<string>('MYSQL_DATABASE'),
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
  // Share one MySQL pool with the client permission-management endpoints.
  async withConnection<T>(run: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      return await run(connection);
    } finally {
      connection.release();
    }
  }
  /*--------------------------------------------------------------------*/
  //  findByUsername()
  /*--------------------------------------------------------------------*/
  async findByUsername(username: string): Promise<UserCredentialRecord | null> {
    const normalizedUsername = username.trim().toLowerCase();

    if (!normalizedUsername) {
      return null;
    }

    const [rows] = await this.pool.execute<UserCredentialRow[]>(
      `SELECT
          c.name AS client_name,
          u.row_id AS user_id,
          u.client_id,
          u.user_type,
          u.username,
          u.password_hash
       FROM client_users u
       JOIN clients c ON u.client_id = c.row_id
       WHERE LOWER(u.username) = ?`,
      [normalizedUsername],
    );

    if (!rows.length) {
      return null;
    }

    const firstRow = rows[0];

    return {
      id: String(firstRow.user_id),
      username: firstRow.username,
      displayName: firstRow.client_name,
      passwordHash: firstRow.password_hash,
      clientId: firstRow.client_id,
      userType: firstRow.user_type,
      //parentWorkloadId: firstRow.workload_id ?? undefined,
    };
  }
  /*--------------------------------------------------------------------*/
  //  findById()
  /*--------------------------------------------------------------------*/
  async findById(userId: string): Promise<UserCredentialRecord | null> {
    const [rows] = await this.pool.execute<UserCredentialRow[]>(
      `SELECT u.row_id AS user_id, u.client_id, u.user_type,
              u.username, u.password_hash, c.name AS client_name
       FROM client_users u
       JOIN clients c ON c.row_id = u.client_id
       WHERE u.row_id = ?`,
      [userId],
    );

    const row = rows[0];
    return row ? {
      id: String(row.user_id),
      username: row.username,
      displayName: row.client_name,
      passwordHash: row.password_hash,
      clientId: row.client_id,
      userType: row.user_type,
    } : null;
  }
  /*--------------------------------------------------------------------*/
  //  getUserDBWorkloads()
  /*--------------------------------------------------------------------*/
  async getUserDBWorkloads(userId: string): Promise<UserDBWorkload[]> {
    const [rows] = await this.pool.execute<UserDBWorkloadRow[]>(
      `SELECT w.workload_id, w.name, w.is_parent, w.page_type
       FROM client_user_workload_permissions p
       JOIN client_users u ON u.row_id = p.user_id
       JOIN ampp_workloads w ON w.row_id = p.ampp_workload_id
                             AND w.client_id = u.client_id
       WHERE p.user_id = ?
       ORDER BY w.is_parent DESC, w.row_id ASC`,
      [userId],
    );

    return rows.map((row) => ({
      id: row.workload_id,
      name: row.name,
      is_parent: row.is_parent ? 1 : 0,
      pageType: row.page_type,
    }));
  }
  /*--------------------------------------------------------------------*/
  //  getUserDashboards()
  /*--------------------------------------------------------------------*/
  async getUserDashboards(userId: string): Promise<AllowedDashboard[]> {
    const [rows] = await this.pool.execute<UserDashboardRow[]>(
      `SELECT d.dashboard_id, d.associated_workload_id, d.name, d.page_type
       FROM client_user_dashboard_permissions p
       JOIN client_users u ON u.row_id = p.user_id
       JOIN ampp_dashboards d ON d.row_id = p.ampp_dashboard_id
                              AND d.client_id = u.client_id
       WHERE p.user_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM client_dashboard_denials x
           WHERE x.client_id = u.client_id AND x.dashboard_id = LOWER(d.dashboard_id)
         )
       ORDER BY d.row_id ASC`,
      [userId],
    );

    return rows.map((row) => ({
      id: row.dashboard_id,
      associatedWorkloadId: row.associated_workload_id,
      name: row.name,
      pageType: row.page_type,
    }));
  }
  /*--------------------------------------------------------------------*/
  //  getWorkloadDenials()
  /*--------------------------------------------------------------------*/
  async getWorkloadDenials(userId: string): Promise<string[]> {
    const [rows] = await this.pool.execute<(RowDataPacket & { workload_id: string })[]>(
      `SELECT d.workload_id
       FROM client_user_workload_denials d
       WHERE d.user_id = ?
       UNION
       SELECT x.workload_id FROM client_workload_denials x
       JOIN client_users u ON u.client_id = x.client_id
       WHERE u.row_id = ?`,
      [userId, userId],
    );
    return rows.map((row) => row.workload_id.toLowerCase());
  }
  /*--------------------------------------------------------------------*/
  //  compareLegacyPermissions()
  //  Diagnostics only. The legacy tables never authorize requests.
  //  Step 8: comparison removed with the legacy per-user resource columns.
  /*--------------------------------------------------------------------*/
}
