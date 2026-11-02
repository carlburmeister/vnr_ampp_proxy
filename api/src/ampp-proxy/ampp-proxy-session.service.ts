import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionData } from 'express-session';

import type {
  AmppAccessToken,
  AmppDashboardMatrixAccess,
  AmppMatrixAccess,
} from '../auth/types/session-data';
import {
  migrateAmppAccessToken,
  newerAmppAccessToken,
} from './ampp-access-tokens';

const SESSION_KEYS = [
  'amppUserId',
  'amppCookieJar',
  'amppAccessToken',
  'amppAccessTokens',
  'amppTokenGeneration',
  'amppMatrixAccess',
  'amppDashboardMatrixAccess',
  'amppNotificationMailboxIds',
  'gvuiMailboxes',
] as const;

type SessionKey = (typeof SESSION_KEYS)[number];
type SessionValues = Pick<SessionData, SessionKey>;

export type AmppProxySessionSnapshot = {
  values: SessionValues;
};

@Injectable()
export class AmppProxySessionService {
  private readonly saveQueues = new Map<string, Promise<void>>();

  snapshot(session: SessionData): AmppProxySessionSnapshot {
    return { values: this.cloneValues(session) };
  }

  async saveIfChanged(
    req: Request,
    snapshot: AmppProxySessionSnapshot,
  ): Promise<void> {
    const current = this.cloneValues(req.session);
    const changedKeys = SESSION_KEYS.filter(
      (key) => !this.same(snapshot.values[key], current[key]),
    );

    if (!changedKeys.length) {
      return;
    }

    const previous = this.saveQueues.get(req.sessionID) ?? Promise.resolve();
    const save = previous
      .catch(() => undefined)
      .then(async () => {
        const latest = await this.getStoredSession(req);

        if (!latest) {
          // Do not let a delayed upstream response recreate a logged-out session.
          return;
        }

        // Another request may have refreshed permissions while this request
        // was proxied. Never overwrite that newer authorization snapshot.
        if (latest.authorizationFingerprint !== req.session.authorizationFingerprint) {
          for (const key of [
            'user', 'parentWorkloadId', 'fabricId', 'nodeId',
            'amppAccessToken',
            'amppAccessTokens',
            'amppTokenGeneration',
            'amppCookieJar',
            'amppUserId',
            'allowedWorkloads', 'allowedDashboardIds', 'allowedDashboards',
            'allowedGvuiLayoutIds', 'allowedGvuiLayouts',
            'gvuiMailboxes',
            'amppAllowedWorkloadIds', 'amppResourceWorkloadIds', 'authorizationFingerprint', 'authorizationCheckedAt',
            'amppMatrixAccess', 'amppDashboardMatrixAccess', 'amppNotificationMailboxIds',
          ] as const) {
            (req.session as any)[key] = this.clone<unknown>(latest[key]);
          }
          // Do not merge data derived under revoked permissions.
          return;
        }
        req.session.authorizationCheckedAt = latest.authorizationCheckedAt;
        for (const key of SESSION_KEYS) {
          if (!changedKeys.includes(key)) {
            this.setValue(req.session, key, latest[key]);
          }
        }

        // A reset wins over responses started under the previous authentication.
        const beforeGeneration = snapshot.values.amppTokenGeneration;
        if (
          latest.amppTokenGeneration !== beforeGeneration &&
          latest.amppTokenGeneration !== current.amppTokenGeneration
        ) {
          for (const key of [
            'amppAccessTokens',
            'amppAccessToken',
            'amppTokenGeneration',
            'amppCookieJar',
            'amppUserId',
          ] as const)
            this.setValue(req.session, key, latest[key]);
        } else if (current.amppTokenGeneration !== beforeGeneration) {
          req.session.amppAccessTokens = this.clone(current.amppAccessTokens);
          req.session.amppAccessToken = current.amppAccessToken;
        } else if (
          changedKeys.includes('amppAccessTokens') ||
          changedKeys.includes('amppAccessToken')
        ) {
          req.session.amppAccessTokens = this.mergeAccessTokens(
            snapshot.values,
            current,
            latest,
          );
        }

        if (changedKeys.includes('amppMatrixAccess')) {
          req.session.amppMatrixAccess = this.mergeMatrixAccess(
            snapshot.values.amppMatrixAccess,
            current.amppMatrixAccess,
            latest.amppMatrixAccess,
          );
        }

        if (changedKeys.includes('amppDashboardMatrixAccess')) {
          req.session.amppDashboardMatrixAccess =
            this.mergeDashboardMatrixAccess(
              snapshot.values.amppDashboardMatrixAccess,
              current.amppDashboardMatrixAccess,
              latest.amppDashboardMatrixAccess,
            );
        }

        if (changedKeys.includes('amppNotificationMailboxIds')) {
          req.session.amppNotificationMailboxIds = this.mergeIds(
            latest.amppNotificationMailboxIds,
            snapshot.values.amppNotificationMailboxIds,
            current.amppNotificationMailboxIds,
          );
        }

        if (changedKeys.includes('gvuiMailboxes')) {
          // Merge independent tabs by mailbox alias, preserving newer entries.
          const merged = this.clone(latest.gvuiMailboxes ?? {});
          const before = snapshot.values.gvuiMailboxes ?? {};
          const after = current.gvuiMailboxes ?? {};
          for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (this.same(before[key], after[key])) continue;
            if (!after[key]) delete merged[key];
            else if (!merged[key] || merged[key].createdAt <= after[key].createdAt) merged[key] = this.clone(after[key]);
          }
          req.session.gvuiMailboxes = merged;
        }

        await this.saveSession(req);
      });

    this.saveQueues.set(req.sessionID, save);

    try {
      await save;
    } finally {
      if (this.saveQueues.get(req.sessionID) === save) {
        this.saveQueues.delete(req.sessionID);
      }
    }
  }

  private mergeAccessTokens(
    beforeValues: SessionValues,
    afterValues: SessionValues,
    latestValues: SessionValues,
  ): Record<string, AmppAccessToken> {
    // Normalize snapshots too: a concurrent migration must not resurrect a
    // legacy token that this request has just invalidated.
    const normalized = (values: SessionValues) => {
      const state = {
        amppAccessTokens: this.clone(values.amppAccessTokens),
        amppAccessToken: values.amppAccessToken,
      } as SessionData;
      migrateAmppAccessToken(state);
      return state.amppAccessTokens ?? {};
    };
    const before = normalized(beforeValues);
    const after = normalized(afterValues);
    const merged = normalized(latestValues);
    for (const key of new Set([
      ...Object.keys(before),
      ...Object.keys(after),
    ])) {
      if (this.same(before[key], after[key])) continue;
      if (!after[key]) {
        // A rejected/expired token must not remove a concurrent replacement.
        if (this.same(before[key], merged[key])) delete merged[key];
      } else if (
        !merged[key] ||
        newerAmppAccessToken(after[key], merged[key])
      ) {
        merged[key] = this.clone(after[key]);
      }
    }
    return merged;
  }

  private mergeMatrixAccess(
    before: AmppMatrixAccess | undefined,
    after: AmppMatrixAccess | undefined,
    latest: AmppMatrixAccess | undefined,
  ): AmppMatrixAccess | undefined {
    if (after === undefined) {
      return undefined;
    }

    const merged = this.clone(latest ?? {});
    const beforeAccess = before ?? {};

    for (const fabricId of new Set([
      ...Object.keys(beforeAccess),
      ...Object.keys(after),
    ])) {
      const previous = beforeAccess[fabricId];
      const current = after[fabricId];

      if (this.same(previous, current)) {
        continue;
      }

      if (!current) {
        delete merged[fabricId];
        continue;
      }

      const target = (merged[fabricId] ??= {});

      for (const key of ['producerIds', 'writableProducerIds', 'consumerIds'] as const) {
        if (!this.same(previous?.[key], current[key])) {
          target[key] = this.mergeIds(target[key], previous?.[key], current[key]);
        }
      }

      if (!this.same(previous?.producerNames, current.producerNames)) {
        target.producerNames = this.mergeNames(
          target.producerNames,
          previous?.producerNames,
          current.producerNames,
        );
      }
    }

    return merged;
  }

  private mergeDashboardMatrixAccess(
    before: AmppDashboardMatrixAccess | undefined,
    after: AmppDashboardMatrixAccess | undefined,
    latest: AmppDashboardMatrixAccess | undefined,
  ): AmppDashboardMatrixAccess | undefined {
    if (after === undefined) {
      return undefined;
    }

    const merged = this.clone(latest ?? {});
    const previousAccess = before ?? {};

    for (const workloadId of new Set([
      ...Object.keys(previousAccess),
      ...Object.keys(after),
    ])) {
      const previous = previousAccess[workloadId];
      const current = after[workloadId];

      if (this.same(previous, current)) {
        continue;
      }

      if (!current) {
        delete merged[workloadId];
        continue;
      }

      const target = (merged[workloadId] ??= {});

      for (const key of ['producerIds', 'consumerIds'] as const) {
        if (!this.same(previous?.[key], current[key])) {
          target[key] = this.mergeIds(target[key], previous?.[key], current[key]);
        }
      }

      if (!this.same(previous?.dashboardNodeIds, current.dashboardNodeIds)) {
        const nodeIds = { ...(target.dashboardNodeIds ?? {}) };
        const previousNodes = previous?.dashboardNodeIds ?? {};
        const currentNodes = current.dashboardNodeIds ?? {};

        for (const dashboardId of new Set([
          ...Object.keys(previousNodes),
          ...Object.keys(currentNodes),
        ])) {
          if (this.same(previousNodes[dashboardId], currentNodes[dashboardId])) {
            continue;
          }
          if (!(dashboardId in currentNodes)) {
            delete nodeIds[dashboardId];
          } else {
            nodeIds[dashboardId] = this.clone(currentNodes[dashboardId]);
          }
        }
        target.dashboardNodeIds = nodeIds;
      }

      if (!this.same(previous?.dashboards, current.dashboards)) {
        const dashboards = { ...(target.dashboards ?? {}) };
        const previousDashboards = previous?.dashboards ?? {};
        const currentDashboards = current.dashboards ?? {};

        for (const dashboardId of new Set([
          ...Object.keys(previousDashboards),
          ...Object.keys(currentDashboards),
        ])) {
          if (
            this.same(
              previousDashboards[dashboardId],
              currentDashboards[dashboardId],
            )
          ) {
            continue;
          }

          if (!(dashboardId in currentDashboards)) {
            delete dashboards[dashboardId];
          } else {
            dashboards[dashboardId] = this.clone(
              currentDashboards[dashboardId],
            );
          }
        }

        target.dashboards = dashboards;
      }
    }

    return merged;
  }

  private mergeIds(
    latest: string[] | undefined,
    before: string[] | undefined,
    after: string[] | undefined,
  ): string[] | undefined {
    if (after === undefined) {
      return undefined;
    }

    if (before === undefined) {
      return [...after];
    }

    const values = new Map(
      (latest ?? []).map((value) => [value.toLowerCase(), value]),
    );
    const afterIds = new Set(after.map((value) => value.toLowerCase()));

    for (const value of before) {
      if (!afterIds.has(value.toLowerCase())) {
        values.delete(value.toLowerCase());
      }
    }

    for (const value of after) {
      if (!before.some((item) => item.toLowerCase() === value.toLowerCase())) {
        values.set(value.toLowerCase(), value);
      }
    }

    return [...values.values()];
  }

  private mergeNames(
    latest: Record<string, string> | undefined,
    before: Record<string, string> | undefined,
    after: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (after === undefined) {
      return undefined;
    }

    if (before === undefined) {
      return { ...after };
    }

    const merged = { ...(latest ?? {}) };

    for (const key of Object.keys(before)) {
      if (!(key in after)) {
        delete merged[key];
      }
    }

    for (const [key, value] of Object.entries(after)) {
      if (before[key] !== value) {
        merged[key] = value;
      }
    }

    return merged;
  }

  private getStoredSession(req: Request): Promise<SessionData | null> {
    return new Promise((resolve, reject) => {
      req.sessionStore.get(req.sessionID, (error, session) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(session ?? null);
      });
    });
  }

  private saveSession(req: Request): Promise<void> {
    req.session.touch();
    return new Promise<void>((resolve, reject) => {
      req.session.save((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private cloneValues(session: SessionData): SessionValues {
    return Object.fromEntries(
      SESSION_KEYS.map((key) => [key, this.clone(session[key])]),
    ) as SessionValues;
  }

  private setValue(
    session: SessionData,
    key: SessionKey,
    value: SessionData[SessionKey],
  ): void {
    if (value === undefined) {
      delete session[key];
      return;
    }

    (session as Record<SessionKey, SessionData[SessionKey]>)[key] =
      this.clone(value);
  }

  private clone<T>(value: T): T {
    return value === undefined
      ? value
      : (JSON.parse(JSON.stringify(value)) as T);
  }

  private same(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }
}
