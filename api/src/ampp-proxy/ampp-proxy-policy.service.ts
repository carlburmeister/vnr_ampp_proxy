import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { SessionData } from 'express-session';

import type { AllowedWorkload } from '../ampp/types/workload_types';

const API_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

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
    this.assertWorkloadAllowed(session.allowedWorkloads ?? [], workloadId);

    const normalizedMethod = method.toUpperCase();

    if (!API_METHODS.has(normalizedMethod)) {
      throw new ForbiddenException('AMPP API method is not allowed');
    }

    const target = this.parseRelativePath(upstreamPath);

    if (!this.isAllowedApiRequest(normalizedMethod, target.pathname, workloadId)) {
      throw new ForbiddenException('AMPP API endpoint is not allowed');
    }

    this.assertWorkloadReferences(target, workloadId);
    this.assertBodyWorkloadReferences(body, workloadId);

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
    pathname: string,
    workloadId: string,
  ): boolean {
    const readOnlyRules = [
      /^\/discovery\/api\//i,
      /^\/configuration\/api\//i,
      /^\/identity\/api\//i,
      /^\/cluster\/(?:store|state|matrix)\/api\//i,
      /^\/api\/v1\/store\//i,
    ];

    if (method === 'GET' && readOnlyRules.some((rule) => rule.test(pathname))) {
      return true;
    }

    if (
      ['GET', 'POST'].includes(method) &&
      /^\/notifications\/api\//i.test(pathname)
    ) {
      return true;
    }

    if (method === 'POST' && /^\/logging\/api\//i.test(pathname)) {
      return true;
    }

    const escapedWorkloadId = this.escapeRegExp(workloadId);
    return new RegExp(
      `^/mocha/application/${escapedWorkloadId}/api/`,
      'i',
    ).test(pathname);
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

  private assertWorkloadReferences(target: URL, workloadId: string): void {
    const decodedPath = target.pathname
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
    const pathPatterns = [
      /\/cluster\/state\/api\/v1\/workload\/([^/?]+)/gi,
      /\/mocha\/application\/([^/?]+)/gi,
      /gv\.ampp\.(?:apps\.[^.]+|workload)\.([0-9a-f-]{36})/gi,
      /gv\.cluster\.workload\.([0-9a-f-]{36})/gi,
    ];

    for (const pattern of pathPatterns) {
      for (const match of decodedPath.matchAll(pattern)) {
        if (match[1] && match[1] !== workloadId) {
          throw new ForbiddenException(
            'AMPP API request references a different workload',
          );
        }
      }
    }

    for (const [name, value] of target.searchParams.entries()) {
      if (/^workload_?id$/i.test(name) && value !== workloadId) {
        throw new ForbiddenException(
          'AMPP API query references a different workload',
        );
      }
    }
  }

  private assertBodyWorkloadReferences(
    body: Buffer | undefined,
    workloadId: string,
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
          child !== workloadId
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
    const allowedIds = allowedWorkloads.flatMap((workload) => [
      workload.id,
      ...(workload.child_workloads ?? []).map(
        (childWorkload) => childWorkload.id,
      ),
    ]);

    if (!allowedIds.length) {
      throw new ForbiddenException(
        'No allowed workloads found for this session',
      );
    }

    if (!allowedIds.includes(workloadId)) {
      throw new ForbiddenException('Workload is not allowed for this session');
    }
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
