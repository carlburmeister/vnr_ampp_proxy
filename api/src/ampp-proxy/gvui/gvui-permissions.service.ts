import { BadRequestException, Injectable } from '@nestjs/common';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { UserCredentialsRepository } from '../../users/services/user-credentials.repository';
import type { AllowedGvuiLayout, GvuiLayoutAssignment } from './gvui.types';

// Client restrictions override grants, including a restricted association.
const UNRESTRICTED = `NOT EXISTS (
  SELECT 1 FROM client_gvui_denials x
  WHERE x.client_id=g.client_id AND x.layout_id=LOWER(g.layout_id)
) AND (g.associated_workload_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM client_workload_denials x
  WHERE x.client_id=g.client_id AND x.workload_id=LOWER(g.associated_workload_id)
))`;

@Injectable()
export class GvuiPermissionsService {
  constructor(private readonly users: UserCredentialsRepository) {}

  validateChanges(value: unknown): number[] | undefined {
    if (value === undefined) return undefined;
    if (
      !Array.isArray(value) ||
      value.length > 500 ||
      value.some((id) => !Number.isInteger(id) || id < 1 || id > 2147483647)
    )
      throw new BadRequestException('Invalid GV.UI layout assignment IDs');
    return [...new Set(value)] as number[];
  }

  async listAssignments(
    db: PoolConnection,
    clientId: number,
  ): Promise<GvuiLayoutAssignment[]> {
    const [rows] = await db.execute<(RowDataPacket & GvuiLayoutAssignment)[]>(
      `SELECT g.row_id AS id, g.layout_id AS layoutId, g.name,
              g.associated_workload_id AS associatedWorkloadId
       FROM ampp_gvui_layouts g WHERE g.client_id=? AND ${UNRESTRICTED}
       ORDER BY g.name, g.row_id`,
      [clientId],
    );
    return rows;
  }

  async getGrantedIds(
    db: PoolConnection,
    userId: number,
    clientId: number,
  ): Promise<number[]> {
    const [rows] = await db.execute<(RowDataPacket & { id: number })[]>(
      `SELECT g.row_id AS id FROM client_user_gvui_permissions p
       JOIN client_users u ON u.row_id=p.user_id AND u.client_id=?
       JOIN ampp_gvui_layouts g ON g.row_id=p.ampp_gvui_layout_id AND g.client_id=u.client_id
       WHERE p.user_id=? AND ${UNRESTRICTED} ORDER BY g.row_id`,
      [clientId, userId],
    );
    return rows.map((row) => row.id);
  }

  async getUserLayouts(
    userId: string,
    clientId: number,
  ): Promise<AllowedGvuiLayout[]> {
    return this.users.withConnection(async (db) => {
      const [rows] = await db.execute<(RowDataPacket & AllowedGvuiLayout)[]>(
        `SELECT LOWER(g.layout_id) AS id, g.name,
                LOWER(g.associated_workload_id) AS associatedWorkloadId
         FROM client_user_gvui_permissions p
         JOIN client_users u ON u.row_id=p.user_id AND u.client_id=?
         JOIN ampp_gvui_layouts g ON g.row_id=p.ampp_gvui_layout_id AND g.client_id=u.client_id
         WHERE p.user_id=? AND ${UNRESTRICTED} ORDER BY g.row_id`,
        [clientId, userId],
      );
      return rows;
    });
  }

  // The caller owns the transaction and holds the same client-row lock as Admin.
  async replaceGrants(
    db: PoolConnection,
    clientId: number,
    userId: number,
    actorId: string,
    ids: number[] | undefined,
  ): Promise<number[]> {
    if (ids === undefined) return this.getGrantedIds(db, userId, clientId);
    if (ids.length) {
      const [rows] = await db.query<(RowDataPacket & { row_id: number })[]>(
        `SELECT g.row_id FROM ampp_gvui_layouts g
         JOIN client_users u ON u.row_id=? AND u.client_id=g.client_id
         WHERE g.client_id=? AND g.row_id IN (?) AND ${UNRESTRICTED} FOR UPDATE`,
        [userId, clientId, ids],
      );
      if (rows.length !== ids.length) {
        throw new BadRequestException(
          'GV.UI assignments must belong to your client and be unrestricted',
        );
      }
    }
    await db.execute(
      'DELETE FROM client_user_gvui_permissions WHERE user_id=?',
      [userId],
    );
    for (const id of ids) {
      await db.execute(
        'INSERT INTO client_user_gvui_permissions (user_id, ampp_gvui_layout_id, created_by_user_id) VALUES (?, ?, ?)',
        [userId, id, actorId],
      );
    }
    return ids;
  }
}
