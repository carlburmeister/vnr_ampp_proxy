import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { SessionData } from 'express-session';

import type { AllowedWorkload } from '../ampp/types/workload_types';

const API_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MATRIX_READ_PATHS = new Set([
  '/cluster/matrix/api/v1/producers',
  '/cluster/matrix/api/v1/consumers',
  '/cluster/matrix/api/v1/routing/sources',
  '/cluster/matrix/api/v1/routing/destinations',
]);

@Injectable()
export class AmppProxyPolicyService {
  assertUiAccess(
    session: SessionData,
    workloadId: string,
    upstreamPath: string,
  ): string {
    const allowedPath = this.assertUiResourceAccess(
      session,
      workloadId,
      upstreamPath,
    );
    const target = new URL(allowedPath, 'http://ampp-proxy.local');
    const pathSegments = target.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
    const queryValues = [...target.searchParams.values()];

    if (
      !pathSegments.includes(workloadId) &&
      !queryValues.includes(workloadId)
    ) {
      throw new ForbiddenException(
        'AMPP UI path does not reference the allowed workload',
      );
    }

    return allowedPath;
  }

  assertUiResourceAccess(
    session: SessionData,
    workloadId: string,
    upstreamPath: string,
  ): string {
    this.assertWorkloadAllowed(session.allowedWorkloads ?? [], workloadId);

    const target = this.parseRelativePath(upstreamPath);

    if (this.isApiPath(target.pathname)) {
      throw new ForbiddenException(
        'AMPP API requests must use the API proxy route',
      );
    }

    return `${target.pathname}${target.search}`;
  }

  assertApiAccess(
    session: SessionData,
    workloadId: string,
    method: string,
    upstreamPath: string,
    body?: Buffer,
  ): string {
    const allowedWorkloads = session.allowedWorkloads ?? [];
    const allowedWorkloadIds = this.getAuthorizedWorkloadIds(session);

    this.assertWorkloadAllowed(allowedWorkloads, workloadId);

    const normalizedMethod = method.toUpperCase();

    if (!API_METHODS.has(normalizedMethod)) {
      throw new ForbiddenException('AMPP API method is not allowed');
    }

    const target = this.parseRelativePath(upstreamPath);

    if (
      !this.isAllowedApiRequest(
        normalizedMethod,
        target,
        allowedWorkloads,
        allowedWorkloadIds,
      )
    ) {
      throw new ForbiddenException('AMPP API endpoint is not allowed');
    }

    this.assertWorkloadReferences(target, allowedWorkloadIds);
    this.assertBodyWorkloadReferences(body, allowedWorkloadIds);

    return `${target.pathname}${target.search}`;
  }

  assertWebSocketAccess(
    session: SessionData,
    workloadId: string,
    upstreamPath: string,
  ): string {
    this.assertWorkloadAllowed(session.allowedWorkloads ?? [], workloadId);

    const target = this.parseRelativePath(upstreamPath);

    if (target.pathname.toLowerCase() !== '/pushnotificationshub') {
      throw new ForbiddenException('AMPP WebSocket endpoint is not allowed');
    }

    return `${target.pathname}${target.search}`;
  }

  private isAllowedApiRequest(
    method: string,
    target: URL,
    allowedWorkloads: AllowedWorkload[],
    allowedWorkloadIds: Set<string>,
  ): boolean {
    const pathname = target.pathname.replace(/\/+$/, '').toLowerCase();

    if (pathname.startsWith('/cluster/matrix/api/')) {
      return this.isAllowedMatrixRequest(method, target, allowedWorkloads);
    }

    if (
      pathname.startsWith('/cluster/state/api/') ||
      pathname.startsWith('/mocha/application/') ||
      pathname === '/discovery/api/v1/services'
    ) {
      return this.isAllowedWorkloadRequest(method, target, allowedWorkloadIds);
    }

    // These global/bootstrap namespaces remain unchanged until the explicit
    // global endpoint allowlist is implemented separately.
    const readOnlyRules = [
      /^\/discovery\/api\//i,
      /^\/configuration\/api\//i,
      /^\/identity\/api\//i,
      /^\/cluster\/store\/api\//i,
      /^\/api\/v1\/store\//i,
    ];

    if (
      method === 'GET' &&
      readOnlyRules.some((rule) => rule.test(target.pathname))
    ) {
      return true;
    }

    if (
      ['GET', 'POST'].includes(method) &&
      /^\/notifications\/api\//i.test(target.pathname)
    ) {
      return true;
    }

    return method === 'POST' && /^\/logging\/api\//i.test(target.pathname);
  }

  private isAllowedWorkloadRequest(
    method: string,
    target: URL,
    allowedIds: Set<string>,
  ): boolean {
    const decodedPath = target.pathname
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
    const mochaMatch = decodedPath.match(
      /^\/mocha\/application\/([^/]+)\/api(?:\/|$)/i,
    );

    if (mochaMatch) {
      return (
        API_METHODS.has(method) &&
        allowedIds.has(mochaMatch[1].toLowerCase())
      );
    }

    if (method !== 'GET') {
      return false;
    }

    const workloadMatch = decodedPath.match(
      /^\/cluster\/state\/api\/v1\/workload\/([^/]+)(?:\/|$)/i,
    );

    if (workloadMatch) {
      return allowedIds.has(workloadMatch[1].toLowerCase());
    }

    if (/^\/cluster\/state\/api\/v1\/workloads\/?$/i.test(decodedPath)) {
      return this.isAllowedQueryWorkload(target, 'parentId', allowedIds);
    }

    if (/^\/discovery\/api\/v1\/services\/?$/i.test(decodedPath)) {
      return this.isAllowedQueryWorkload(target, 'instance', allowedIds);
    }

    return false;
  }

  private isAllowedMatrixRequest(
    method: string,
    target: URL,
    allowedWorkloads: AllowedWorkload[],
  ): boolean {
    const pathname = target.pathname.replace(/\/+$/, '').toLowerCase();

    if (method !== 'GET' || !MATRIX_READ_PATHS.has(pathname)) {
      return false;
    }

    const fabricIds = target.searchParams.getAll('fabricId');

    if (fabricIds.length !== 1) {
      return false;
    }

    return this.getAllowedFabricIds(allowedWorkloads).has(
      fabricIds[0].toLowerCase(),
    );
  }

  private isApiPath(pathname: string): boolean {
    return (
      /^\/(?:api|graphql)(?:\/|$)/i.test(pathname) ||
      /^\/(?:discovery|configuration|identity|notifications|logging)\/api(?:\/|$)/i.test(
        pathname,
      ) ||
      /^\/cluster\/(?:store|state|matrix)\/api(?:\/|$)/i.test(pathname) ||
      /^\/mocha\/application\/[^/]+\/api(?:\/|$)/i.test(pathname)
    );
  }

  private assertWorkloadReferences(
    target: URL,
    allowedIds: Set<string>,
  ): void {
    const decodedPath = target.pathname
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
    const pathPatterns = [
      /\/cluster\/state\/api\/v1\/workload\/([^/?]+)/gi,
      /\/mocha\/application\/([^/?]+)/gi,
    ];

    for (const pattern of pathPatterns) {
      for (const match of decodedPath.matchAll(pattern)) {
        if (match[1] && !allowedIds.has(match[1].toLowerCase())) {
          throw new ForbiddenException(
            'AMPP API request references a different workload',
          );
        }
      }
    }

    this.assertAmppWorkloadReferences(
      decodedPath,
      allowedIds,
      'AMPP API request references a different workload',
    );

    for (const [name, value] of target.searchParams.entries()) {
      const isWorkloadId = /^workload_?id$/i.test(name);
      const isParentId =
        /^parentid$/i.test(name) &&
        /^\/cluster\/state\/api\/v1\/workloads\/?$/i.test(target.pathname);
      const isDiscoveryInstance =
        /^instance$/i.test(name) &&
        /^\/discovery\/api\/v1\/services\/?$/i.test(target.pathname);

      if (
        (isWorkloadId || isParentId || isDiscoveryInstance) &&
        !allowedIds.has(value.toLowerCase())
      ) {
        throw new ForbiddenException(
          'AMPP API query references a different workload',
        );
      }
    }
  }

  private assertBodyWorkloadReferences(
    body: Buffer | undefined,
    allowedIds: Set<string>,
  ): void {
    if (!body?.length) {
      return;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return;
    }

    const inspect = (value: unknown): void => {
      if (typeof value === 'string') {
        this.assertAmppWorkloadReferences(
          value,
          allowedIds,
          'AMPP API body references a different workload',
        );
        return;
      }

      if (Array.isArray(value)) {
        value.forEach(inspect);
        return;
      }

      if (!value || typeof value !== 'object') {
        return;
      }

      for (const [name, child] of Object.entries(value)) {
        if (
          /^workload_?id$/i.test(name) &&
          typeof child === 'string' &&
          !allowedIds.has(child.toLowerCase())
        ) {
          throw new ForbiddenException(
            'AMPP API body references a different workload',
          );
        }

        inspect(child);
      }
    };

    inspect(parsed);
  }

  private assertAmppWorkloadReferences(
    value: string,
    allowedIds: Set<string>,
    message: string,
  ): void {
    const patterns = [
      /gv\.ampp\.(?:apps\.[^.]+|workload)\.([0-9a-f-]{36})/gi,
      /gv\.cluster\.workload\.([0-9a-f-]{36})/gi,
    ];

    for (const pattern of patterns) {
      for (const match of value.matchAll(pattern)) {
        if (match[1] && !allowedIds.has(match[1].toLowerCase())) {
          throw new ForbiddenException(message);
        }
      }
    }
  }

  private isAllowedQueryWorkload(
    target: URL,
    name: string,
    allowedIds: Set<string>,
  ): boolean {
    const values = target.searchParams.getAll(name);
    return values.length === 1 && allowedIds.has(values[0].toLowerCase());
  }

  private getAuthorizedWorkloadIds(session: SessionData): Set<string> {
    const ids = session.amppAllowedWorkloadIds;

    if (ids?.length) {
      return new Set(ids.map((id) => id.toLowerCase()));
    }

    return this.getAllowedWorkloadIds(session.allowedWorkloads ?? []);
  }

  private getAllowedWorkloadIds(
    allowedWorkloads: AllowedWorkload[],
  ): Set<string> {
    return new Set(
      allowedWorkloads
        .flatMap((workload) => [
          workload.id,
          ...(workload.child_workloads ?? []).map(
            (childWorkload) => childWorkload.id,
          ),
        ])
        .filter(Boolean)
        .map((id) => id.toLowerCase()),
    );
  }

  private getAllowedFabricIds(
    allowedWorkloads: AllowedWorkload[],
  ): Set<string> {
    return new Set(
      allowedWorkloads
        .flatMap((workload) => [
          workload.fabricId,
          ...(workload.child_workloads ?? []).map(
            (childWorkload) => childWorkload.fabricId,
          ),
        ])
        .filter((fabricId): fabricId is string => Boolean(fabricId))
        .map((fabricId) => fabricId.toLowerCase()),
    );
  }

  private parseRelativePath(upstreamPath: string): URL {
    if (!upstreamPath?.startsWith('/') || upstreamPath.startsWith('//')) {
      throw new BadRequestException('A relative AMPP path is required');
    }

    return new URL(upstreamPath, 'http://ampp-proxy.local');
  }

  private assertWorkloadAllowed(
    allowedWorkloads: AllowedWorkload[],
    workloadId: string,
  ): void {
    const allowedIds = this.getAllowedWorkloadIds(allowedWorkloads);

    if (!allowedIds.size) {
      throw new ForbiddenException(
        'No allowed workloads found for this session',
      );
    }

    if (!allowedIds.has(workloadId.toLowerCase())) {
      throw new ForbiddenException('Workload is not allowed for this session');
    }
  }
}
