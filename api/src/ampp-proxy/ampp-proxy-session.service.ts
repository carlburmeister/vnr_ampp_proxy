import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionData } from 'express-session';

import type { AmppMatrixAccess } from '../auth/types/session-data';

const SESSION_KEYS = [
  'amppUserId',
  'amppCookieJar',
  'amppAccessToken',
  'amppMatrixAccess',
  'amppNotificationMailboxIds',
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

        if (latest) {
          for (const key of SESSION_KEYS) {
            if (!changedKeys.includes(key)) {
              this.setValue(req.session, key, latest[key]);
            }
          }

          if (changedKeys.includes('amppMatrixAccess')) {
            req.session.amppMatrixAccess = this.mergeMatrixAccess(
              snapshot.values.amppMatrixAccess,
              current.amppMatrixAccess,
              latest.amppMatrixAccess,
            );
          }

          if (changedKeys.includes('amppNotificationMailboxIds')) {
            req.session.amppNotificationMailboxIds = this.mergeIds(
              latest.amppNotificationMailboxIds,
              snapshot.values.amppNotificationMailboxIds,
              current.amppNotificationMailboxIds,
            );
          }
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

      for (const key of ['producerIds', 'consumerIds'] as const) {
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
