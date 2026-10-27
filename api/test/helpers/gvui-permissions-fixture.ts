import type { PoolConnection } from 'mysql2/promise';
import { GvuiPermissionsService } from '../../src/ampp-proxy/gvui/gvui-permissions.service';
import { AmppControlService } from '../../src/ampp/services/ampp-control.service';
import type { AuthenticatedUser } from '../../src/auth/auth.service';
import { ClientPermissionsService } from '../../src/users/services/client-permissions.service';
import { UserCredentialsRepository } from '../../src/users/services/user-credentials.repository';

// Isolated SQL adapter: no database, accounts or AMPP service are created.
export function setupGvuiPermissions() {
  const actor: AuthenticatedUser = {
    id: '1',
    username: 'admin',
    displayName: 'Admin',
    clientId: 1,
    userType: 'admin',
  };
  const state = {
    actorClient: 1,
    role: 'admin',
    targetClient: 1,
    layoutClient: 1,
    denied: false,
    associationDenied: false,
    grants: [16],
    workloads: [7],
    failWorkloadInsert: false,
    afterClientLock: () => {},
  };
  let snapshot: { grants: number[]; workloads: number[] };
  const run = jest.fn((sql: string, params: unknown[]) => {
    if (sql.includes('SELECT row_id FROM clients')) {
      state.afterClientLock();
      return [[{ row_id: 1 }]];
    }
    if (sql.includes('SELECT client_id, user_type FROM client_users'))
      return [[{ client_id: state.actorClient, user_type: state.role }]];
    if (sql.includes('SELECT client_id FROM client_users'))
      return [[{ client_id: state.targetClient }]];
    if (sql.includes('SELECT row_id AS id, workload_id AS workloadId'))
      return [[]];
    if (
      sql.includes('SELECT p.ampp_workload_id') ||
      sql.includes('SELECT p.ampp_dashboard_id') ||
      sql.includes('SELECT d.workload_id FROM client_user_workload_denials')
    )
      return [[]];
    if (sql.includes('FROM ampp_workloads WHERE'))
      return [[{ row_id: 7, workload_id: 'workload', is_parent: 0 }]];
    if (
      sql.includes('SELECT workload_id FROM client_workload_denials') ||
      sql.includes('FROM ampp_dashboards')
    )
      return [[]];
    if (sql.includes('SELECT g.row_id FROM ampp_gvui_layouts')) {
      expect(sql).toContain('FOR UPDATE');
      expect(sql).toContain('u.client_id=g.client_id');
      expect(sql).toContain('client_gvui_denials');
      expect(sql).toContain('client_workload_denials');
      expect(params.slice(0, 2)).toEqual([2, 1]);
      return [
        state.layoutClient === 1 &&
        state.targetClient === 1 &&
        !state.denied &&
        !state.associationDenied
          ? (params[2] as number[])
              .filter((id) => id === 16)
              .map((row_id) => ({ row_id }))
          : [],
      ];
    }
    if (
      sql.includes('SELECT g.row_id AS id FROM client_user_gvui_permissions')
    ) {
      return [state.denied ? [] : state.grants.map((id) => ({ id }))];
    }
    if (sql.includes('SELECT g.row_id AS id, g.layout_id')) {
      return [
        state.layoutClient === 1 && !state.denied && !state.associationDenied
          ? [
              {
                id: 16,
                layoutId: 'a5e4ca11-6f09-46dc-b365-888eea07d545',
                name: 'Layout',
                associatedWorkloadId: null,
              },
            ]
          : [],
      ];
    }
    if (sql.startsWith('DELETE FROM client_user_gvui_permissions')) {
      state.grants = [];
      return [{}];
    }
    if (sql.startsWith('INSERT INTO client_user_gvui_permissions')) {
      expect(params).toEqual([2, 16, '1']);
      state.grants.push(params[1] as number);
      return [{}];
    }
    if (sql.startsWith('DELETE FROM client_user_workload_permissions')) {
      state.workloads = [];
      return [{}];
    }
    if (sql.startsWith('INSERT INTO client_user_workload_permissions')) {
      if (state.failWorkloadInsert) throw new Error('Workload insert failed');
      state.workloads.push(params[1] as number);
      return [{}];
    }
    if (
      sql.startsWith('DELETE FROM client_user_dashboard_permissions') ||
      sql.startsWith('DELETE FROM client_user_workload_denials')
    )
      return [{}];
    throw new Error('Unexpected SQL: ' + sql);
  });
  const db = {
    execute: run,
    query: run,
    beginTransaction: jest.fn(() => {
      snapshot = { grants: [...state.grants], workloads: [...state.workloads] };
      return Promise.resolve();
    }),
    commit: jest.fn(() => Promise.resolve()),
    rollback: jest.fn(() => {
      Object.assign(state, snapshot);
      return Promise.resolve();
    }),
  };
  const users = {
    withConnection: <T>(callback: (connection: PoolConnection) => Promise<T>) =>
      callback(db as unknown as PoolConnection),
  } as UserCredentialsRepository;
  const gvui = new GvuiPermissionsService(users);
  const ampp = {
    getDashboardNames: jest.fn(() => Promise.resolve(new Map())),
    getWorkloadName: jest.fn(() => Promise.resolve(undefined)),
  };
  const service = new ClientPermissionsService(
    users,
    ampp as unknown as AmppControlService,
    gvui,
  );
  const changes = {
    workloadIds: [],
    dashboardIds: [],
    deniedChildWorkloadIds: [],
  };
  return { actor, state, db, service, changes, run };
}
