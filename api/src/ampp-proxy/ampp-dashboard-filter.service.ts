import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SessionData } from 'express-session';

import type { AmppDashboardMatrixReferences } from '../auth/types/session-data';
import type { AmppCookieHttpResponse } from './ampp-cookie-http.service';
import {
  getDashboardResourceIds,
  ICE_DASHBOARD_REFERENCE,
} from './ampp-dashboard-resources';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AmppDashboardFilterService {
  private readonly platformUrl: URL;

  constructor(config: ConfigService) {
    this.platformUrl = new URL(config.getOrThrow<string>('PLATFORM_URL'));
  }

  filterApiResponse(
    session: SessionData,
    workloadId: string,
    upstreamPath: string,
    response: AmppCookieHttpResponse,
  ): AmppCookieHttpResponse {
    if (
      response.status < 200 ||
      response.status >= 300 ||
      response.status === 204
    ) {
      return response;
    }

    const target = new URL(upstreamPath, this.platformUrl);
    const pathname = target.pathname.replace(/\/+$/, '').toLowerCase();
    const dashboardMatch = target.pathname.match(
      /^\/configuration\/api\/v1\/configuration\/gv\/systemdashboards\/dashboards\/([^/]+)$/i,
    );

    if (dashboardMatch) {
      this.captureDashboardMatrixReferences(
        session,
        workloadId,
        dashboardMatch[1],
        response,
      );
    }

    if (pathname === '/cluster/state/api/v1/workloads') {
      return this.filterWrappedList(
        response,
        'workloads',
        'workload',
        this.getAllowedWorkloadIds(session),
      );
    }

    if (pathname === '/cluster/state/api/v2/nodes') {
      return this.filterListById(
        response,
        'nodes',
        'nodeId',
        this.getAllowedNodeIds(session, workloadId),
      );
    }

    if (pathname === '/cluster/fabric/api/v1/fabrics') {
      return this.filterFabrics(session, workloadId, response);
    }

    if (pathname === '/cluster/snapshot/api/v1/snapshots') {
      return this.filterWrappedList(
        response,
        'snapshots',
        'snapshot',
        this.getAllowedFabricIds(session),
        'fabricId',
      );
    }

    if (pathname === '/cluster/matrix/api/v1/salvos') {
      return this.filterArrayById(
        response,
        this.getAllowedFabricIds(session),
        'fabricId',
      );
    }

    if (pathname === '/ampp/control/api/v1/macro') {
      return this.filterMacros(session, response);
    }

    if (
      pathname ===
      '/configuration/api/v1/configurations/startswith/gv/systemdashboards/dashboard-list'
    ) {
      return this.filterConfigurationList(response, (value) => {
        const id = value.id;
        return (
          typeof id === 'string' &&
          this.getAllowedDashboardIds(session).has(id.toLowerCase())
        );
      });
    }

    if (
      pathname ===
      '/configuration/api/v1/configurations/startswith/gv/matrix/panel'
    ) {
      return this.filterConfigurationList(response, (value) =>
        this.referencesOnlyAllowed(session, value, true),
      );
    }

    if (
      pathname ===
      '/configuration/api/v1/configurations/startswith/gv/amppcontrolpanels/panels'
    ) {
      return this.filterConfigurationList(response, (value) =>
        this.referencesOnlyAllowed(session, value, true),
      );
    }

    if (pathname === '/hubmanager/api/v1/sites') {
      return this.filterSites(session, workloadId, response);
    }

    if (/^\/notifications\/api\/v1\/notifications\/[^/]+$/i.test(pathname)) {
      return this.filterNotifications(session, workloadId, response);
    }

    return response;
  }

  private filterFabrics(
    session: SessionData,
    workloadId: string,
    response: AmppCookieHttpResponse,
  ): AmppCookieHttpResponse {
    const parsed = this.parseJsonObject(response);
    const fabrics = parsed.fabrics;

    if (!Array.isArray(fabrics)) {
      throw new BadGatewayException('AMPP fabric response is missing fabrics');
    }

    const allowedFabricIds = this.getAllowedFabricIds(session, workloadId);
    const allowedNodeIds = this.getAllowedNodeIds(session, workloadId);
    const filtered = fabrics.flatMap((item) => {
      const wrapper = this.asObject(item);
      const fabric = this.asObject(wrapper?.fabric);
      const id = fabric?.id;

      if (
        !wrapper ||
        !fabric ||
        typeof id !== 'string' ||
        !allowedFabricIds.has(id.toLowerCase())
      ) {
        return [];
      }

      return [
        {
          ...wrapper,
          fabric: {
            ...fabric,
            ...(Array.isArray(fabric.nodes)
              ? {
                  nodes: fabric.nodes.filter((node) => {
                    const nodeId = this.asObject(node)?.id;
                    return (
                      typeof nodeId === 'string' &&
                      allowedNodeIds.has(nodeId.toLowerCase())
                    );
                  }),
                }
              : {}),
          },
        },
      ];
    });

    return this.replaceJsonBody(response, { ...parsed, fabrics: filtered });
  }

  private filterMacros(
    session: SessionData,
    response: AmppCookieHttpResponse,
  ): AmppCookieHttpResponse {
    const parsed = this.parseJson(response);

    if (!Array.isArray(parsed)) {
      throw new BadGatewayException('AMPP macro response is not an array');
    }

    return this.replaceJsonBody(
      response,
      parsed.filter((macro) => {
        const commands = this.asObject(macro)?.commands;
        return (
          Array.isArray(commands) &&
          commands.some((command) =>
            this.referencesOnlyAllowed(session, command, true),
          ) &&
          commands.every((command) =>
            this.referencesOnlyAllowed(session, command, false),
          )
        );
      }),
    );
  }

  private filterConfigurationList(
    response: AmppCookieHttpResponse,
    allow: (value: Record<string, unknown>) => boolean,
  ): AmppCookieHttpResponse {
    const parsed = this.parseJson(response);

    if (!Array.isArray(parsed)) {
      throw new BadGatewayException(
        'AMPP configuration list response is not an array',
      );
    }

    return this.replaceJsonBody(
      response,
      parsed.filter((item) => {
        const configuration = this.asObject(this.asObject(item)?.configuration);
        const value = configuration?.value;

        if (typeof value !== 'string') {
          return false;
        }

        try {
          const parsedValue = JSON.parse(value);
          const object = this.asObject(parsedValue);
          return Boolean(object && allow(object));
        } catch {
          return false;
        }
      }),
    );
  }

  private filterSites(
    session: SessionData,
    workloadId: string,
    response: AmppCookieHttpResponse,
  ): AmppCookieHttpResponse {
    const parsed = this.parseJsonObject(response);
    const sites = parsed.sites;

    if (!Array.isArray(sites)) {
      throw new BadGatewayException('AMPP site response is missing sites');
    }

    const allowedNodeIds = this.getAllowedNodeIds(session, workloadId);
    const filtered = sites.filter((site) =>
      this.containsAllowedId(site, allowedNodeIds),
    );

    return this.replaceJsonBody(response, { ...parsed, sites: filtered });
  }

  private filterNotifications(
    session: SessionData,
    workloadId: string,
    response: AmppCookieHttpResponse,
  ): AmppCookieHttpResponse {
    const parsed = this.parseJson(response);

    if (!Array.isArray(parsed)) {
      throw new BadGatewayException(
        'AMPP notification response is not an array',
      );
    }

    return this.replaceJsonBody(
      response,
      parsed.filter((notification) => {
        const item = this.asObject(notification);
        const topic = item?.topic;

        if (typeof topic !== 'string') {
          return false;
        }

        const normalized = topic.toLowerCase();

        if (
          normalized === 'gv.platform.identity.permissions' ||
          normalized === 'gv.platform.configuration' ||
          normalized.startsWith('gv.platform.service.') ||
          normalized.startsWith('gv.cluster.matrix.')
        ) {
          return true;
        }

        const workload = topic.match(
          /^gv\.cluster\.workload\.([0-9a-f-]{36})(?:\.|$)/i,
        );
        if (workload) {
          return this.getAllowedWorkloadIds(session).has(
            workload[1].toLowerCase(),
          );
        }

        const node = topic.match(
          /^gv\.(?:cluster\.(?:node|nodestate)|config\.gv\.node)\.([0-9a-f-]{36})(?:\.|$)/i,
        );
        if (node) {
          return this.getAllowedNodeIds(session, workloadId).has(
            node[1].toLowerCase(),
          );
        }

        const fabric = topic.match(
          /^gv\.cluster\.fabric\.([0-9a-f-]{36})(?:\.|$)/i,
        );
        if (fabric) {
          return this.getAllowedFabricIds(session, workloadId).has(
            fabric[1].toLowerCase(),
          );
        }

        if (
          normalized === 'gv.cluster.workload.created' ||
          normalized === 'gv.cluster.fabric.node.assigned' ||
          normalized === 'gv.cluster.fabric.node.unassigned'
        ) {
          const content = this.parseNotificationContent(item.content);
          return Boolean(
            content && this.referencesOnlyAllowed(session, content, true),
          );
        }

        return true;
      }),
    );
  }

  private referencesOnlyAllowed(
    session: SessionData,
    value: unknown,
    requireReference: boolean,
  ): boolean {
    const allowedWorkloads = this.getAllowedWorkloadIds(session);
    const allowedFabrics = this.getAllowedFabricIds(session);
    const allowedNodes = this.getAllowedNodeIds(session);
    let references = 0;
    let allowed = true;

    const inspect = (item: unknown, parentName = ''): void => {
      if (!allowed || item === null || item === undefined) {
        return;
      }

      if (Array.isArray(item)) {
        item.forEach((child) => inspect(child, parentName));
        return;
      }

      if (typeof item !== 'object') {
        return;
      }

      for (const [name, child] of Object.entries(item)) {
        const normalizedName = name.toLowerCase();

        if (typeof child === 'string' && UUID_PATTERN.test(child)) {
          if (
            normalizedName === 'workload' ||
            normalizedName === 'workloadid' ||
            normalizedName === 'parentnodeactiveworkload'
          ) {
            references += 1;
            if (!allowedWorkloads.has(child.toLowerCase())) {
              allowed = false;
              return;
            }
            continue;
          }

          if (normalizedName === 'fabric' || normalizedName === 'fabricid') {
            references += 1;
            if (!allowedFabrics.has(child.toLowerCase())) {
              allowed = false;
              return;
            }
            continue;
          }

          if (normalizedName === 'nodeid') {
            references += 1;
            if (!allowedNodes.has(child.toLowerCase())) {
              allowed = false;
              return;
            }
            continue;
          }

          if (normalizedName === 'id' && parentName === 'workload') {
            references += 1;
            if (!allowedWorkloads.has(child.toLowerCase())) {
              allowed = false;
              return;
            }
            continue;
          }
        }

        if (normalizedName === 'workloads' && Array.isArray(child)) {
          for (const id of child) {
            if (typeof id === 'string' && UUID_PATTERN.test(id)) {
              references += 1;
              if (!allowedWorkloads.has(id.toLowerCase())) {
                allowed = false;
                return;
              }
            }
          }
          continue;
        }

        inspect(child, normalizedName);
      }
    };

    inspect(value);
    return allowed && (!requireReference || references > 0);
  }

  private filterWrappedList(
    response: AmppCookieHttpResponse,
    listKey: string,
    wrapperKey: string,
    allowedIds: Set<string>,
    idKey = 'id',
  ): AmppCookieHttpResponse {
    const parsed = this.parseJsonObject(response);
    const list = parsed[listKey];

    if (!Array.isArray(list)) {
      throw new BadGatewayException(`AMPP response is missing ${listKey}`);
    }

    const filtered = list.filter((item) => {
      const value = this.asObject(this.asObject(item)?.[wrapperKey]);
      const id = value?.[idKey];
      return typeof id === 'string' && allowedIds.has(id.toLowerCase());
    });

    return this.replaceJsonBody(response, { ...parsed, [listKey]: filtered });
  }

  private filterListById(
    response: AmppCookieHttpResponse,
    listKey: string,
    idKey: string,
    allowedIds: Set<string>,
  ): AmppCookieHttpResponse {
    const parsed = this.parseJsonObject(response);
    const list = parsed[listKey];

    if (!Array.isArray(list)) {
      throw new BadGatewayException(`AMPP response is missing ${listKey}`);
    }

    return this.replaceJsonBody(response, {
      ...parsed,
      [listKey]: list.filter((item) => {
        const id = this.asObject(item)?.[idKey];
        return typeof id === 'string' && allowedIds.has(id.toLowerCase());
      }),
    });
  }

  private filterArrayById(
    response: AmppCookieHttpResponse,
    allowedIds: Set<string>,
    idKey: string,
  ): AmppCookieHttpResponse {
    const parsed = this.parseJson(response);

    if (!Array.isArray(parsed)) {
      throw new BadGatewayException('AMPP response is not an array');
    }

    return this.replaceJsonBody(
      response,
      parsed.filter((item) => {
        const id = this.asObject(item)?.[idKey];
        return typeof id === 'string' && allowedIds.has(id.toLowerCase());
      }),
    );
  }

  private containsAllowedId(value: unknown, allowedIds: Set<string>): boolean {
    if (typeof value === 'string') {
      return UUID_PATTERN.test(value) && allowedIds.has(value.toLowerCase());
    }

    if (Array.isArray(value)) {
      return value.some((item) => this.containsAllowedId(item, allowedIds));
    }

    if (!value || typeof value !== 'object') {
      return false;
    }

    return Object.values(value).some((item) =>
      this.containsAllowedId(item, allowedIds),
    );
  }

  private parseNotificationContent(value: unknown): unknown {
    if (typeof value !== 'string') {
      return value;
    }

    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  private captureDashboardMatrixReferences(
    session: SessionData,
    workloadId: string,
    dashboardId: string,
    response: AmppCookieHttpResponse,
  ): void {
    const dashboard = (session.allowedDashboards ?? []).find(
      (item) =>
        item.id.toLowerCase() === dashboardId.toLowerCase() &&
        (item.associatedWorkloadId === null ||
          item.associatedWorkloadId.toLowerCase() === workloadId.toLowerCase()),
    );

    if (!dashboard) {
      return;
    }

    const configuration = this.parseJsonObject(response);
    const value = configuration.value;

    if (typeof value !== 'string') {
      return;
    }

    let dashboardValue: unknown;

    try {
      dashboardValue = JSON.parse(value);
    } catch {
      return;
    }

    const references: Record<string, AmppDashboardMatrixReferences> = {};
    const nodeIds = new Set<string>();

    const add = (
      fabricId: string,
      key: 'workloadIds' | 'producerNames' | 'consumerNames',
      value: string,
    ): void => {
      const fabric = (references[fabricId.toLowerCase()] ??= {});
      const values = (fabric[key] ??= []);

      if (!values.includes(value)) {
        values.push(value);
      }
    };

    const inspect = (item: unknown, inheritedFabricId?: string): void => {
      if (Array.isArray(item)) {
        item.forEach((child) => inspect(child, inheritedFabricId));
        return;
      }

      const object = this.asObject(item);

      if (!object) {
        return;
      }

      const fabricId =
        typeof object.fabricId === 'string' && UUID_PATTERN.test(object.fabricId)
          ? object.fabricId
          : inheritedFabricId;

      if (typeof object.nodeId === 'string' && UUID_PATTERN.test(object.nodeId)) {
        nodeIds.add(object.nodeId.toLowerCase());
      }

      if (fabricId) {
        references[fabricId.toLowerCase()] ??= {};
        if (
          typeof object.workloadId === 'string' &&
          UUID_PATTERN.test(object.workloadId)
        ) {
          add(fabricId, 'workloadIds', object.workloadId.toLowerCase());
        }

        if (typeof object.producerName === 'string' && object.producerName) {
          add(fabricId, 'producerNames', object.producerName);
        }

        if (typeof object.consumerName === 'string' && object.consumerName) {
          add(fabricId, 'consumerNames', object.consumerName);
        }
      } else {
        if (typeof object.producerName === 'string' && object.producerName) {
          add(ICE_DASHBOARD_REFERENCE, 'producerNames', object.producerName);
        }

        if (typeof object.consumerName === 'string' && object.consumerName) {
          add(ICE_DASHBOARD_REFERENCE, 'consumerNames', object.consumerName);
        }
      }

      Object.values(object).forEach((child) => inspect(child, fabricId));
    };

    inspect(dashboardValue);

    const matrixAccess = (session.amppDashboardMatrixAccess ??= {});
    const scope = (matrixAccess[workloadId.toLowerCase()] ??= {});
    (scope.dashboards ??= {})[dashboardId.toLowerCase()] = references;
    (scope.dashboardNodeIds ??= {})[dashboardId.toLowerCase()] = [...nodeIds];
    scope.producerIds = [];
    scope.consumerIds = [];
  }

  private getAllowedDashboardIds(session: SessionData): Set<string> {
    return new Set(
      (session.allowedDashboardIds ?? []).map((id) => id.toLowerCase()),
    );
  }

  private getAllowedWorkloadIds(session: SessionData): Set<string> {
    return new Set(
      (
        session.amppAllowedWorkloadIds ??
        (session.allowedWorkloads ?? []).flatMap((workload) => [
          workload.id,
          ...(workload.child_workloads ?? []).map((child) => child.id),
        ])
      ).map((id) => id.toLowerCase()),
    );
  }

  private getAllowedFabricIds(
    session: SessionData,
    workloadId?: string,
  ): Set<string> {
    return new Set([
      ...(session.allowedWorkloads ?? [])
        .flatMap((workload) => [
          workload.fabricId,
          ...(workload.child_workloads ?? []).map((child) => child.fabricId),
        ])
        .filter((id): id is string => Boolean(id))
        .map((id) => id.toLowerCase()),
      ...(workloadId
        ? getDashboardResourceIds(session, workloadId, 'fabric')
        : []),
    ]);
  }

  private getAllowedNodeIds(
    session: SessionData,
    workloadId?: string,
  ): Set<string> {
    return new Set([
      ...(session.allowedWorkloads ?? [])
        .flatMap((workload) => [
          workload.nodeId,
          ...(workload.child_workloads ?? []).map((child) => child.nodeId),
        ])
        .filter((id): id is string => Boolean(id))
        .map((id) => id.toLowerCase()),
      ...(workloadId
        ? getDashboardResourceIds(session, workloadId, 'node')
        : []),
    ]);
  }

  private parseJson(response: AmppCookieHttpResponse): unknown {
    try {
      return JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new BadGatewayException('AMPP response is not valid JSON');
    }
  }

  private parseJsonObject(
    response: AmppCookieHttpResponse,
  ): Record<string, unknown> {
    const parsed = this.parseJson(response);
    const object = this.asObject(parsed);

    if (!object) {
      throw new BadGatewayException('AMPP response is not a JSON object');
    }

    return object;
  }

  private replaceJsonBody(
    response: AmppCookieHttpResponse,
    value: unknown,
  ): AmppCookieHttpResponse {
    return {
      ...response,
      headers: {
        ...response.headers,
        'content-length': undefined,
        etag: undefined,
        'last-modified': undefined,
      },
      body: Buffer.from(JSON.stringify(value)),
    };
  }

  private asObject(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }
}
