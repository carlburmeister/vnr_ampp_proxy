import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { SessionData } from 'express-session';

import type { AllowedWorkload } from '../ampp/types/workload_types';
import { AmppMatrixFilterService } from './ampp-matrix-filter.service';
import { getDashboardResourceIds } from './ampp-dashboard-resources';
import { GvuiProxyService } from './gvui/gvui-proxy.service';
import { getDiscoveryNodeWorkloads } from './ampp-discovery-filter';

const API_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const GLOBAL_BOOTSTRAP_GET_PATHS = new Set([
  '/identity/api/v1/user',
  '/configuration/api/v1/configuration/gv/system/configuration',
  '/configuration/api/v1/configurations/startswith/gv/multiviewer/layouts',
  '/configuration/api/v1/configurations/startswith/gv/multiviewer/layout-categories',
  '/configuration/api/v1/configurations/startswith/gv/multiviewer/v2/layouts',
  '/discovery/api/v1/self',
  '/discovery/api/v1/services',
  '/cluster/store/api/store/account-notification',
  '/cluster/store/api/store/messagescache',
  '/cluster/store/api/store/settingscache',
  '/cluster/store/api/store/apps',
  '/cluster/store/api/store/allreleases',
  '/api/v1/store/location/locations/cloud:still',
  '/api/v1/store/still/avatars',
  '/api/v1/store/still/stills/partner/logo.png',
  '/api/v1/store/still/stills/partner/logo.svg',
]);
const GLOBAL_NOTIFICATION_TOPICS = new Set([
  'gv.platform.identity.permissions',
  'gv.platform.service.#',
  'gv.platform.service.healthchanged',
  'gv.cluster.matrix.producer.*',
  'gv.cluster.matrix.consumer.*',
]);
const MATRIX_READ_PATHS = new Set([
  '/cluster/matrix/api/v1/producers',
  '/cluster/matrix/api/v1/consumers',
  '/cluster/matrix/api/v1/routing/sources',
  '/cluster/matrix/api/v1/routing/destinations',
]);

@Injectable()
export class AmppProxyPolicyService {
  constructor(
    private readonly matrixFilter: AmppMatrixFilterService,
    private readonly gvui?: GvuiProxyService,
  ) {}

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
    this.assertWorkloadAllowed(session.allowedWorkloads ?? [], this.contextWorkload(session, workloadId));

    const target = this.parseRelativePath(upstreamPath);

    if (this.isApiPath(target.pathname)) {
      throw new ForbiddenException(
        'AMPP API requests must use the API proxy route',
      );
    }

    if (/^\/gvui(?:\/|$)/i.test(target.pathname)) {
      this.gvui?.assertUiPath(session, workloadId, target);
      if (!this.gvui) throw new ForbiddenException('GV.UI proxy is unavailable');
    }

    const dashboardId = this.getDashboardId(target.pathname);

    if (dashboardId) {
      this.assertDashboardAllowed(session, workloadId, dashboardId);
    }

    const targetWorkloadId = this.getUiTargetWorkloadId(target);

    if (targetWorkloadId) {
      this.assertWorkloadAllowed(
        session.allowedWorkloads ?? [],
        targetWorkloadId,
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

    this.assertWorkloadAllowed(allowedWorkloads, this.contextWorkload(session, workloadId));

    const normalizedMethod = method.toUpperCase();

    if (!API_METHODS.has(normalizedMethod)) {
      throw new ForbiddenException('AMPP API method is not allowed');
    }

    const target = this.parseRelativePath(upstreamPath);

    if (this.gvui) this.gvui.assertNotificationRequest(session, workloadId, normalizedMethod, target, body);

    if (
      !this.isAllowedApiRequest(
        normalizedMethod,
        target,
        session,
        workloadId,
        allowedWorkloads,
        allowedWorkloadIds,
        body,
      )
    ) {
      throw new ForbiddenException('AMPP API endpoint is not allowed');
    }

    this.assertWorkloadReferences(target, allowedWorkloadIds, session, workloadId);
    this.assertBodyWorkloadReferences(body, allowedWorkloadIds, session, normalizedMethod, target);
    this.assertAssignmentAccess(session, normalizedMethod, target, body);

    return `${target.pathname}${target.search}`;
  }

  assertWebSocketAccess(
    session: SessionData,
    workloadId: string,
    upstreamPath: string,
  ): string {
    this.assertWorkloadAllowed(session.allowedWorkloads ?? [], this.contextWorkload(session, workloadId));

    const target = this.parseRelativePath(upstreamPath);

    if (target.pathname.toLowerCase() !== '/pushnotificationshub') {
      throw new ForbiddenException('AMPP WebSocket endpoint is not allowed');
    }

    return `${target.pathname}${target.search}`;
  }

  private contextWorkload(session: SessionData, id: string): string {
    if (!id.startsWith('gvui-')) return id;
    if (!this.gvui) throw new ForbiddenException('GV.UI proxy is unavailable');
    return this.gvui.contextWorkload(session, id);
  }

  private isAllowedApiRequest(
    method: string,
    target: URL,
    session: SessionData,
    workloadId: string,
    allowedWorkloads: AllowedWorkload[],
    allowedWorkloadIds: Set<string>,
    body: Buffer | undefined,
  ): boolean {
    const pathname = target.pathname.replace(/\/+$/, '').toLowerCase();

    if (this.isAllowedGlobalBootstrapRequest(method, target)) {
      return true;
    }

    if (method === 'GET' && this.gvui?.isCatalogRequest(target) && this.gvui.isAllowed(session, workloadId)) {
      return true;
    }

    if (
      this.isAllowedDashboardRequest(
        method,
        target,
        session,
        workloadId,
        allowedWorkloadIds,
        body,
      )
    ) {
      return true;
    }

    if (pathname.startsWith('/cluster/matrix/api/')) {
      return this.isAllowedMatrixRequest(
        method,
        target,
        session,
        allowedWorkloads,
        body,
        this.hasDashboardScope(session, workloadId),
        workloadId,
      );
    }

    if (
      pathname.startsWith('/cluster/state/api/') ||
      pathname.startsWith('/cluster/control/api/') ||
      pathname.startsWith('/mocha/application/') ||
      pathname === '/discovery/api/v1/services'
    ) {
      return (
        this.isAllowedWorkloadRequest(method, target, allowedWorkloadIds) ||
        this.isAllowedDiscoveryNodeRequest(method, target, session, workloadId) ||
        this.isAllowedDashboardNodeRequest(method, target, session, workloadId)
      );
    }

    // Historical note:
    // These global/bootstrap namespaces remain unchanged until the explicit
    // global endpoint allowlist is implemented separately.
    // The explicit allowlist is now handled before the scoped rules above.
    if (pathname.startsWith('/notifications/api/')) {
      return this.isAllowedNotificationRequest(
        method,
        target,
        session,
        workloadId,
        allowedWorkloadIds,
        body,
        this.hasDashboardScope(session, workloadId),
      );
    }

    return (
      method === 'POST' &&
      !target.search &&
      pathname === '/logging/api/v2/events'
    );
  }

  private isAllowedGlobalBootstrapRequest(
    method: string,
    target: URL,
  ): boolean {
    if (method !== 'GET' || target.search) {
      return false;
    }

    const pathname = target.pathname.replace(/\/+$/, '').toLowerCase();

    if (GLOBAL_BOOTSTRAP_GET_PATHS.has(pathname)) {
      return true;
    }

    if (
      /^\/identity\/api\/v1\/users\/[0-9a-f]{32}\/login\/local$/.test(
        pathname,
      )
    ) {
      return true;
    }

    return /^\/configuration\/api\/v1\/configuration\/appstore-last-visited-[0-9a-f]{32}$/.test(
      pathname,
    );
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

    const controlMatch = decodedPath.match(
      /^\/cluster\/control\/api\/v1\/workload\/([^/]+)\/(start|stop)\/?$/i,
    );

    if (controlMatch) {
      return (
        method === 'POST' &&
        !target.search &&
        allowedIds.has(controlMatch[1].toLowerCase())
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

  private isAllowedDiscoveryNodeRequest(
    method: string,
    target: URL,
    session: SessionData,
    workloadId: string,
  ): boolean {
    return method === 'GET' &&
      target.pathname.replace(/\/+$/, '').toLowerCase() === '/discovery/api/v1/services' &&
      target.searchParams.size === 1 &&
      target.searchParams.has('instance') &&
      getDiscoveryNodeWorkloads(
        session, workloadId, target.searchParams.get('instance') ?? '',
      ).size > 0;
  }

  private isAllowedDashboardNodeRequest(
    method: string,
    target: URL,
    session: SessionData,
    workloadId: string,
  ): boolean {
    const match = target.pathname.match(
      /^\/cluster\/state\/api\/v2\/node\/([0-9a-f-]{36})\/?$/i,
    );

    return Boolean(
      method === 'GET' &&
        !target.search &&
        match &&
        getDashboardResourceIds(session, workloadId, 'node').has(
          match[1].toLowerCase(),
        ),
    );
  }

  private isAllowedMatrixRequest(
    method: string,
    target: URL,
    session: SessionData,
    allowedWorkloads: AllowedWorkload[],
    body: Buffer | undefined,
    dashboardScope: boolean,
    workloadId: string,
  ): boolean {
    const pathname = target.pathname.replace(/\/+$/, '').toLowerCase();

    if (method === 'GET' && MATRIX_READ_PATHS.has(pathname)) {
      const fabricIds = target.searchParams.getAll('fabricId');

      if (
        fabricIds.length === 1 &&
        (this.getAllowedFabricIds(allowedWorkloads).has(
          fabricIds[0].toLowerCase(),
        ) ||
          getDashboardResourceIds(session, workloadId, 'fabric').has(
            fabricIds[0].toLowerCase(),
          ))
      ) {
        return true;
      }

      return (
        dashboardScope &&
        fabricIds.length === 0 &&
        target.searchParams.getAll('type').length === 1 &&
        target.searchParams.get('type')?.toLowerCase() === 'ice'
      );
    }

    const producerMatch = pathname.match(
      /^\/cluster\/matrix\/api\/v1\/producer\/([^/]+)$/,
    );

    return Boolean(
      method === 'PUT' &&
        !target.search &&
        producerMatch &&
        this.matrixFilter.isProducerWritable(session, producerMatch[1]) &&
        this.isAliasUpdateBody(body),
    );
  }

  private isApiPath(pathname: string): boolean {
    return (
      /^\/(?:api|graphql)(?:\/|$)/i.test(pathname) ||
      /^\/(?:discovery|configuration|identity|notifications|logging|hubmanager)\/api(?:\/|$)/i.test(
        pathname,
      ) ||
      /^\/ampp\/control\/api(?:\/|$)/i.test(pathname) ||
      /^\/cluster\/(?:store|state|matrix|control|fabric|snapshot)\/api(?:\/|$)/i.test(pathname) ||
      /^\/mocha\/application\/[^/]+\/api(?:\/|$)/i.test(pathname)
    );
  }

  private isAllowedNotificationRequest(
    method: string,
    target: URL,
    session: SessionData,
    workloadId: string,
    allowedWorkloadIds: Set<string>,
    body: Buffer | undefined,
    dashboardScope: boolean,
  ): boolean {
    const decodedPath = target.pathname
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');

    if (
      method === 'POST' &&
      !target.search &&
      /^\/notifications\/api\/v1\/mailbox\/?$/i.test(decodedPath)
    ) {
      return this.isAllowedMailboxCreate(
        body,
        allowedWorkloadIds,
        dashboardScope,
        workloadId,
        session,
      );
    }

    if (
      method === 'POST' &&
      !target.search &&
      /^\/notifications\/api\/v1\/notifications\/?$/i.test(decodedPath)
    ) {
      return this.isAllowedNotificationPublish(body, allowedWorkloadIds, session);
    }

    const notificationMatch = decodedPath.match(
      /^\/notifications\/api\/v1\/notifications\/([^/]+)\/?$/i,
    );

    if (method === 'GET' && notificationMatch) {
      return (
        this.isAllowedMailbox(
          session,
          notificationMatch[1],
          allowedWorkloadIds,
        ) &&
        this.isAllowedNotificationPollQuery(target)
      );
    }

    const subscriptionMatch = decodedPath.match(
      /^\/notifications\/api\/v1\/mailbox\/([^/]+)\/(subscribe|unsubscribe)\/(.+)$/i,
    );

    return Boolean(
      method === 'POST' &&
        !target.search &&
        subscriptionMatch &&
        this.isAllowedMailbox(
          session,
          subscriptionMatch[1],
          allowedWorkloadIds,
        ) &&
        (this.gvui?.isNotificationTopicAllowed(
          session,
          workloadId,
          subscriptionMatch[1],
          subscriptionMatch[3],
        ) || this.isAllowedNotificationTopic(
          subscriptionMatch[3],
          allowedWorkloadIds,
          new Set([
            ...(session.amppResourceWorkloadIds ?? []),
          ].map((id) => id.toLowerCase())),
          new Set([
            ...this.getAllowedFabricIds(session.allowedWorkloads ?? []),
            ...getDashboardResourceIds(session, workloadId, 'fabric'),
          ]),
          new Set([
            ...this.getAllowedNodeIds(session.allowedWorkloads ?? []),
            ...getDashboardResourceIds(session, workloadId, 'node'),
          ]),
          dashboardScope,
        )),
    );
  }

  private isAllowedNotificationTopic(
    topic: string,
    allowedWorkloadIds: Set<string>,
    resourceWorkloadIds: Set<string>,
    allowedFabricIds: Set<string>,
    allowedNodeIds: Set<string>,
    dashboardScope: boolean,
  ): boolean {
    const normalizedTopic = topic.toLowerCase();

    if (GLOBAL_NOTIFICATION_TOPICS.has(normalizedTopic)) {
      return true;
    }

    if (
      dashboardScope &&
      [
        'gv.platform.configuration',
        'gv.cluster.workload.created',
        'gv.cluster.workload.*.deleted',
        'gv.cluster.workload.#',
        'gv.cluster.fabric.#',
        'gv.cluster.fabric.node.assigned',
        'gv.cluster.fabric.node.unassigned',
        'gv.cluster.matrix.salvo.*.*',
        'gv.cluster.matrix.*.#',
        'gv.cluster.node.*.created',
        'gv.cluster.node.*.deleted',
        'gv.config.gv.node.*.config',
      ].includes(normalizedTopic)
    ) {
      return true;
    }

    const nodeTopic = topic.match(
      /^gv\.(?:cluster\.(?:node|nodestate)|config\.gv\.node)\.([0-9a-f-]{36})\.#$/i,
    );

    if (nodeTopic) {
      return dashboardScope && allowedNodeIds.has(nodeTopic[1].toLowerCase());
    }

    // WebRTC previews may originate in a child whose UI is denied.
    // Do not apply this read permission to application/control topics.
    const preview = topic.match(/^gv\.webrtc\.([0-9a-f-]{36})\.[0-9a-f-]{36}$/i);
    if (preview) {
      return allowedWorkloadIds.has(preview[1].toLowerCase()) ||
        resourceWorkloadIds.has(preview[1].toLowerCase());
    }

    const workloadPatterns = [
      /^gv\.ampp\.workload\.([0-9a-f-]{36})\.roundtriptest$/i,
      /^gv\.ampp\.apps\.[^.]+\.([0-9a-f-]{36})\.#$/i,
      /^gv\.cluster\.workload\.([0-9a-f-]{36})\.#$/i,
      /^gv\.webrtc\.([0-9a-f-]{36})\.[0-9a-f-]{36}$/i,
    ];

    for (const pattern of workloadPatterns) {
      const match = topic.match(pattern);

      if (match) {
        return allowedWorkloadIds.has(match[1].toLowerCase());
      }
    }

    const engineStats = topic.match(
      /^gv\.engine\.([0-9a-f-]{36})\.(?:senders|receivers)\.([0-9a-f-]{36})\.stats$/i,
    );

    if (engineStats) {
      return (
        (allowedWorkloadIds.has(engineStats[1].toLowerCase()) ||
          resourceWorkloadIds.has(engineStats[1].toLowerCase())) &&
        (allowedWorkloadIds.has(engineStats[2].toLowerCase()) ||
          resourceWorkloadIds.has(engineStats[2].toLowerCase()))
      );
    }

    const matrixFabric = topic.match(
      /^gv\.cluster\.matrix\.([0-9a-f-]{36})\.#$/i,
    );

    return Boolean(
      matrixFabric && allowedFabricIds.has(matrixFabric[1].toLowerCase()),
    );
  }

  private isAllowedMailboxCreate(
    body: Buffer | undefined,
    allowedWorkloadIds: Set<string>,
    dashboardScope: boolean,
    workloadId: string,
    session: SessionData,
  ): boolean {
    const parsed = this.parseJsonObject(body);
    const id = parsed?.id;
    const proxiedDashboardMailbox =
      typeof id === 'string'
        ? id.match(
            /^ts-api\.ampp-proxy\.ui\.([0-9a-f-]{36})\.cluster\.systemdashboard--[0-9a-f-]{36}$/i,
          )
        : undefined;

    return Boolean(
      parsed &&
        Object.keys(parsed).length === 5 &&
        typeof id === 'string' &&
        (this.isAllowedMailboxId(id, allowedWorkloadIds) ||
          (this.gvui?.canCreateMailbox(session, workloadId, id) ?? false) ||
          (dashboardScope &&
            (/^ts-cluster\.systemdashboard--[0-9a-f-]{36}$/i.test(id) ||
              proxiedDashboardMailbox?.[1].toLowerCase() ===
                workloadId.toLowerCase()))) &&
        parsed.durable === false &&
        parsed.mailboxTTL === 1500000 &&
        parsed.maximumLength === 10000 &&
        parsed.subscription === 'gv',
    );
  }

  private isAllowedNotificationPublish(
    body: Buffer | undefined,
    allowedWorkloadIds: Set<string>,
    session: SessionData,
  ): boolean {
    const parsed = this.parseJsonObject(body);
    const topic = parsed?.topic;
    const source = parsed?.Source;

    if (typeof topic !== 'string' || typeof source !== 'string') {
      return false;
    }

    const workloadTopic = topic.match(
      /^gv\.ampp\.workload\.([0-9a-f-]{36})\.roundtriptest$/i,
    );

    if (workloadTopic) {
      const workloadId = workloadTopic[1].toLowerCase();

      if (!allowedWorkloadIds.has(workloadId)) {
        return false;
      }

      if (source === '/app/wrapper') {
        return true;
      }

      const proxiedSource = source.match(
        /^\/api\/ampp-proxy\/ui\/([0-9a-f-]{36})\/app\/wrapper$/i,
      );

      return Boolean(
        proxiedSource && proxiedSource[1].toLowerCase() === workloadId,
      );
    }

    const sourceWorkload = this.getNotificationSourceWorkload(source);

    if (
      !sourceWorkload ||
      !allowedWorkloadIds.has(sourceWorkload.workloadId)
    ) {
      return false;
    }

    const engineTopic = topic.match(
      /^gv\.engine\.([0-9a-f-]{36})\.(?:senders|receivers)(?:\.([0-9a-f-]{36}))?$/i,
    );

    if (!engineTopic) {
      return false;
    }

    const engineId = engineTopic[1].toLowerCase();
    const peerId = engineTopic[2]?.toLowerCase();

    // A proxied authorized workload may negotiate a read-only WebRTC preview
    // of a source in a UI-denied child. Never extend non-WebRTC publications.
    const resourceIds = new Set(
      (session.amppResourceWorkloadIds ?? []).map((id) => id.toLowerCase()),
    );
    const hasEngine = allowedWorkloadIds.has(engineId) ||
      (sourceWorkload.proxied && resourceIds.has(engineId));
    const hasPeer = !peerId || allowedWorkloadIds.has(peerId) ||
      (sourceWorkload.proxied && resourceIds.has(peerId));
    if (!hasEngine || !hasPeer) {
      return false;
    }

    if (!sourceWorkload.proxied) {
      return true;
    }

    return this.isAllowedWebRtcEnginePublish(
      this.parseJsonStringObject(parsed?.content),
      engineId,
      Boolean(peerId),
    );
  }

  private isAllowedWebRtcEnginePublish(
    content: Record<string, unknown> | undefined,
    engineId: string,
    hasPeer: boolean,
  ): boolean {
    if (!content || typeof content.type !== 'string') {
      return false;
    }

    const tunnelId =
      typeof content.tunnelId === 'string' &&
      /^[0-9a-f-]{36}$/i.test(content.tunnelId)
        ? content.tunnelId.toLowerCase()
        : undefined;
    const receiverTopic =
      typeof content.receiverTopic === 'string'
        ? content.receiverTopic.match(
            /^gv\.webrtc\.([0-9a-f-]{36})\.([0-9a-f-]{36})$/i,
          )
        : undefined;

    if (content.type === 'discovery') {
      return Boolean(
        !hasPeer &&
          receiverTopic &&
          receiverTopic[1].toLowerCase() === engineId,
      );
    }

    if (!hasPeer || !tunnelId) {
      return false;
    }

    if (content.type === 'init') {
      return Boolean(
        receiverTopic &&
          receiverTopic[1].toLowerCase() === engineId &&
          receiverTopic[2].toLowerCase() === tunnelId,
      );
    }

    if (content.type === 'newFullSdp') {
      return (
        (content.sdpType === 'offer' || content.sdpType === 'answer') &&
        typeof content.sdp === 'string'
      );
    }

    if (content.type === 'newCandidateSdp') {
      return (
        Number.isInteger(content.mLineIndex) &&
        Number(content.mLineIndex) >= 0 &&
        typeof content.sdp === 'string'
      );
    }

    if (content.type === 'keepAlive') {
      return true;
    }

    if (content.type !== 'requestReset' || typeof content.topic !== 'string') {
      return false;
    }

    const resetTopic = content.topic.match(
      /^gv\.webrtc\.([0-9a-f-]{36})\.([0-9a-f-]{36})$/i,
    );

    return Boolean(
      resetTopic &&
        resetTopic[1].toLowerCase() === engineId &&
        resetTopic[2].toLowerCase() === tunnelId,
    );
  }

  private getNotificationSourceWorkload(
    source: string,
  ): { workloadId: string; proxied: boolean } | undefined {
    const directSource = source.match(
      /^\/mocha\/application\/([0-9a-f-]{36})$/i,
    );

    if (directSource) {
      return { workloadId: directSource[1].toLowerCase(), proxied: false };
    }

    const proxiedSource = source.match(
      /^\/api\/ampp-proxy\/ui\/([0-9a-f-]{36})\/mocha\/application\/([0-9a-f-]{36})$/i,
    );

    if (
      proxiedSource &&
      proxiedSource[1].toLowerCase() === proxiedSource[2].toLowerCase()
    ) {
      return { workloadId: proxiedSource[1].toLowerCase(), proxied: true };
    }

    return undefined;
  }

  private isAllowedMailbox(
    session: SessionData,
    mailboxId: string,
    allowedWorkloadIds: Set<string>,
  ): boolean {
    const normalizedId = mailboxId.toLowerCase();

    return (
      (this.gvui && session.gvuiMailboxes?.[mailboxId] &&
        this.gvui.isAllowed(session, session.gvuiMailboxes[mailboxId].contextId)) ||
      (session.amppNotificationMailboxIds ?? []).some(
        (id) => id.toLowerCase() === normalizedId,
      ) || this.isAllowedMailboxId(mailboxId, allowedWorkloadIds)
    );
  }

  private isAllowedMailboxId(
    mailboxId: string,
    allowedWorkloadIds: Set<string>,
  ): boolean {
    if (/^ts-app\.wrapper--[0-9a-f-]{36}$/i.test(mailboxId)) {
      return true;
    }

    const proxiedMailbox = mailboxId.match(
      /^ts-api\.ampp-proxy\.ui\.([0-9a-f-]{36})\.app\.wrapper--[0-9a-f-]{36}$/i,
    );

    return Boolean(
      proxiedMailbox &&
        allowedWorkloadIds.has(proxiedMailbox[1].toLowerCase()),
    );
  }

  private isAllowedNotificationPollQuery(target: URL): boolean {
    const allowedNames = new Set(['count', 'timeout']);

    if (
      [...target.searchParams.keys()].some((name) => !allowedNames.has(name))
    ) {
      return false;
    }

    const count = target.searchParams.getAll('count');
    const timeout = target.searchParams.getAll('timeout');

    return (
      count.length === 1 &&
      timeout.length === 1 &&
      /^\d+$/.test(count[0]) &&
      /^\d+$/.test(timeout[0]) &&
      Number(count[0]) >= 1 &&
      Number(count[0]) <= 1000 &&
      Number(timeout[0]) >= 0 &&
      Number(timeout[0]) <= 60000
    );
  }

  private isAliasUpdateBody(body: Buffer | undefined): boolean {
    const parsed = this.parseJsonObject(body);

    return Boolean(
      parsed &&
        Object.keys(parsed).length === 1 &&
        typeof parsed.alias === 'string',
    );
  }

  private assertAssignmentAccess(
    session: SessionData,
    method: string,
    target: URL,
    body: Buffer | undefined,
  ): void {
    if (method !== 'POST') {
      return;
    }

    const path = target.pathname.replace(/\/+$/, '');
    const parsed = this.parseJsonObject(body);
    const inputMatch = path.match(
      /^\/mocha\/application\/([^/]+)\/api\/v1\/app\/input\/\d+$/i,
    );

    if (inputMatch) {
      this.assertProducerNameAssignment(
        session,
        inputMatch[1],
        parsed?.name,
      );
      return;
    }

    const audioSourceMatch = path.match(
      /^\/mocha\/application\/([^/]+)\/api\/v1\/channel\/\d+\/source$/i,
    );

    if (audioSourceMatch) {
      this.assertProducerNameAssignment(
        session,
        audioSourceMatch[1],
        parsed?.routedSource,
      );
      return;
    }

    if (/\/mocha\/application\/[^/]+\/api\/v1\/app\/sourceselect$/i.test(path)) {
      const producer = this.asObject(parsed?.Producer);
      const consumer = this.asObject(parsed?.Consumer);
      const producerId = producer?.id;
      const consumerId = consumer?.id;

      if (
        typeof producerId !== 'string' ||
        typeof consumerId !== 'string' ||
        !this.matrixFilter.isProducerIdAllowed(session, producerId) ||
        !this.matrixFilter.isConsumerIdAllowed(session, consumerId)
      ) {
        throw new ForbiddenException('AMPP assignment route is not allowed');
      }
    }
  }

  private assertProducerNameAssignment(
    session: SessionData,
    workloadId: string,
    value: unknown,
  ): void {
    const fabricId = this.getWorkloadFabricId(
      session.allowedWorkloads ?? [],
      workloadId,
    );

    if (
      typeof value !== 'string' ||
      (value &&
        (!fabricId ||
          !this.matrixFilter.isProducerNameAllowed(session, value, fabricId)))
    ) {
      throw new ForbiddenException('AMPP assignment producer is not allowed');
    }
  }

  private getWorkloadFabricId(
    allowedWorkloads: AllowedWorkload[],
    workloadId: string,
  ): string | undefined {
    const normalizedId = workloadId.toLowerCase();

    for (const workload of allowedWorkloads) {
      if (workload.id.toLowerCase() === normalizedId) {
        return workload.fabricId;
      }

      const child = (workload.child_workloads ?? []).find(
        (item) => item.id.toLowerCase() === normalizedId,
      );

      if (child) {
        return child.fabricId;
      }
    }

    return undefined;
  }

  private parseJsonObject(
    body: Buffer | undefined,
  ): Record<string, unknown> | undefined {
    if (!body?.length) {
      return undefined;
    }

    try {
      return this.asObject(JSON.parse(body.toString('utf8')));
    } catch {
      return undefined;
    }
  }

  private parseJsonStringObject(
    value: unknown,
  ): Record<string, unknown> | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    try {
      return this.asObject(JSON.parse(value));
    } catch {
      return undefined;
    }
  }

  private asObject(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private assertWorkloadReferences(
    target: URL,
    allowedIds: Set<string>,
    session: SessionData,
    workloadId: string,
  ): void {
    const decodedPath = target.pathname
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
    const pathPatterns = [
      /\/cluster\/state\/api\/v1\/workload\/([^/?]+)/gi,
      /\/cluster\/control\/api\/v1\/workload\/([^/?]+)/gi,
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
        !allowedIds.has(value.toLowerCase()) &&
        !(isDiscoveryInstance &&
          getDiscoveryNodeWorkloads(session, workloadId, value).size > 0 &&
          target.searchParams.size === 1)
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
    session: SessionData,
    method: string,
    target: URL,
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

    const sourceSelect = method === 'POST' &&
      /^\/mocha\/application\/[^/]+\/api\/v1\/app\/sourceselect\/?$/i.test(target.pathname);
    const resourceIds = new Set(
      (session.amppResourceWorkloadIds ?? []).map((id) => id.toLowerCase()),
    );
    const inspect = (value: unknown, path: string[] = []): void => {
      if (typeof value === 'string') {
        this.assertAmppWorkloadReferences(
          value,
          allowedIds,
          'AMPP API body references a different workload',
        );
        return;
      }

      if (Array.isArray(value)) {
        value.forEach((item) => inspect(item, path));
        return;
      }

      if (!value || typeof value !== 'object') {
        return;
      }

      for (const [name, child] of Object.entries(value)) {
        if (
          /^(?:workload|workload_?id)$/i.test(name) &&
          typeof child === 'string' &&
          /^[0-9a-f-]{36}$/i.test(child) &&
          !allowedIds.has(child.toLowerCase()) &&
          !(sourceSelect && path.length === 1 && path[0] === 'Producer' &&
            resourceIds.has(child.toLowerCase()))
        ) {
          throw new ForbiddenException(
            'AMPP API body references a different workload',
          );
        }

        inspect(child, [...path, name]);
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
    const ids = this.getAllowedWorkloadIds(session.allowedWorkloads ?? []);

    for (const id of session.amppAllowedWorkloadIds ?? []) {
      ids.add(id.toLowerCase());
    }

    return ids;
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

  private isAllowedDashboardRequest(
    method: string,
    target: URL,
    session: SessionData,
    workloadId: string,
    allowedWorkloadIds: Set<string>,
    body: Buffer | undefined,
  ): boolean {
    if (!this.hasDashboardScope(session, workloadId)) {
      return false;
    }

    const pathname = target.pathname.replace(/\/+$/, '').toLowerCase();
    const dashboardConfig = pathname.match(
      /^\/configuration\/api\/v1\/configuration\/gv\/systemdashboards\/(?:dashboards|dashboard-edits)\/([^/]+)$/i,
    );

    if (dashboardConfig) {
      return (
        method === 'GET' &&
        !target.search &&
        this.isDashboardAllowed(session, workloadId, dashboardConfig[1])
      );
    }

    if (method === 'GET') {
      if (
        [
          '/configuration/api/v1/configurations/startswith/gv/matrix/panel',
          '/configuration/api/v1/configurations/startswith/gv/amppcontrolpanels/panels',
          '/configuration/api/v1/configurations/startswith/gv/systemdashboards/dashboard-categories',
          '/configuration/api/v1/configurations/startswith/gv/systemdashboards/dashboard-list',
          '/ampp/control/api/v1/macro',
          '/ampp/control/api/v1/control/application/references',
          '/cluster/state/api/v1/workloads',
          '/cluster/state/api/v2/nodes',
          '/cluster/snapshot/api/v1/snapshots',
        ].includes(pathname)
      ) {
        return !target.search;
      }

      if (pathname === '/cluster/fabric/api/v1/fabrics') {
        return (
          target.searchParams.getAll('includeNodes').length === 1 &&
          target.searchParams.get('includeNodes') === 'true' &&
          [...target.searchParams.keys()].every((name) => name === 'includeNodes')
        );
      }

      if (pathname === '/hubmanager/api/v1/sites') {
        return (
          target.searchParams.get('includeNodes') === 'true' &&
          target.searchParams.get('includeHistory') === 'false' &&
          [...target.searchParams.keys()].every((name) =>
            ['includeNodes', 'includeHistory'].includes(name),
          )
        );
      }

      if (pathname === '/cluster/matrix/api/v1/salvos') {
        return (
          target.searchParams.get('includeMappings') === 'false' &&
          [...target.searchParams.keys()].every((name) => name === 'includeMappings')
        );
      }
    }

    return (
      method === 'POST' &&
      !target.search &&
      pathname === '/ampp/control/api/v1/control/commit' &&
      this.isAllowedDashboardControlCommit(
        session,
        workloadId,
        allowedWorkloadIds,
        body,
      )
    );
  }

  private isAllowedDashboardControlCommit(
    session: SessionData,
    workloadId: string,
    allowedWorkloadIds: Set<string>,
    body: Buffer | undefined,
  ): boolean {
    const parsed = this.parseJsonObject(body);
    const targetWorkload = parsed?.workload;
    const reconKey = parsed?.reconKey;

    if (
      typeof targetWorkload !== 'string' ||
      !allowedWorkloadIds.has(targetWorkload.toLowerCase()) ||
      typeof reconKey !== 'string'
    ) {
      return false;
    }

    const dashboardId = reconKey.match(
      /^dashboard-([0-9a-f-]{36})-/i,
    )?.[1];

    return Boolean(
      dashboardId && this.isDashboardAllowed(session, workloadId, dashboardId),
    );
  }

  private getDashboardId(pathname: string): string | undefined {
    return pathname.match(
      /^\/cluster\/systemdashboard\/dashboard\/([^/]+)\/?$/i,
    )?.[1];
  }

  private hasDashboardScope(session: SessionData, workloadId: string): boolean {
    const normalizedWorkloadId = workloadId.toLowerCase();
    return (session.allowedDashboards ?? []).some(
      (dashboard) =>
        (dashboard.associatedWorkloadId === null ||
          (dashboard.associatedWorkloadId.toLowerCase() === normalizedWorkloadId &&
            this.getAuthorizedWorkloadIds(session).has(normalizedWorkloadId))),
    );
  }

  private isDashboardAllowed(
    session: SessionData,
    workloadId: string,
    dashboardId: string,
  ): boolean {
    const normalizedDashboardId = dashboardId.toLowerCase();
    const normalizedWorkloadId = workloadId.toLowerCase();

    return (
      (session.allowedDashboardIds ?? []).some(
        (id) => id.toLowerCase() === normalizedDashboardId,
      ) &&
      (session.allowedDashboards ?? []).some(
        (dashboard) =>
          dashboard.id.toLowerCase() === normalizedDashboardId &&
          (dashboard.associatedWorkloadId === null ||
            (dashboard.associatedWorkloadId.toLowerCase() === normalizedWorkloadId &&
              this.getAuthorizedWorkloadIds(session).has(normalizedWorkloadId))),
      )
    );
  }

  private assertDashboardAllowed(
    session: SessionData,
    workloadId: string,
    dashboardId: string,
  ): void {
    if (!this.isDashboardAllowed(session, workloadId, dashboardId)) {
      throw new ForbiddenException('Dashboard is not allowed for this session');
    }
  }

  private getUiTargetWorkloadId(target: URL): string | undefined {
    const decodedPath = target.pathname
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
    const match =
      decodedPath.match(
        /^\/app\/wrapper\/(?:embedded\/)?single\/[^/]+\/([0-9a-f-]{36})(?:\/|$)/i,
      ) ??
      decodedPath.match(
        /^\/app\/wrapper\/embedded\/callback\/embedded\/single\/[^/]+\/([0-9a-f-]{36})(?:\/|$)/i,
      ) ??
      decodedPath.match(
        /^\/mocha\/application\/([0-9a-f-]{36})(?:\/|$)/i,
      );

    return match?.[1];
  }

  private getAllowedNodeIds(
    allowedWorkloads: AllowedWorkload[],
  ): Set<string> {
    return new Set(
      allowedWorkloads
        .flatMap((workload) => [
          workload.nodeId,
          ...(workload.child_workloads ?? []).map(
            (childWorkload) => childWorkload.nodeId,
          ),
        ])
        .filter((nodeId): nodeId is string => Boolean(nodeId))
        .map((nodeId) => nodeId.toLowerCase()),
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
