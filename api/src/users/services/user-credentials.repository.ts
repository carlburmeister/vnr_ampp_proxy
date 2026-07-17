import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPool,
  type Pool,
  type RowDataPacket,
} from 'mysql2/promise';

import type { UserDBWorkload } from '../../ampp/types/workload_types';

export type UserCredentialRecord = {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  parentWorkloadId?: string;
};

type UserCredentialRow = RowDataPacket & {
  user_id: number | string;
  client_name: string;
  username: string;
  password_hash: string;
  workload_id: string | null;
};

type UserDBWorkloadRow = RowDataPacket & {
  workload_id: string;
  name: string;
  is_parent: 0 | 1 | boolean;
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
      //parentWorkloadId: firstRow.workload_id ?? undefined,
    };
  }
  /*--------------------------------------------------------------------*/
  //  getUserDBWorkloads()
  /*--------------------------------------------------------------------*/
  async getUserDBWorkloads(userId: string): Promise<UserDBWorkload[]> {
    const [rows] = await this.pool.execute<UserDBWorkloadRow[]>(
      `SELECT
          workload_id,
          is_parent
       FROM ampp_workloads
       WHERE user_id = ?
       ORDER BY row_id ASC`,
      [userId],
    );

    return rows.map((row) => ({
      id: row.workload_id,
      name: '',
      is_parent: row.is_parent ? 1 : 0,
    }));
  }
}