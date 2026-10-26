import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { SessionData } from 'express-session';

import { AmppControlService } from '../../ampp/services/ampp-control.service';
import type { AmppCookieHttpResponse } from '../ampp-cookie-http.service';
import {
  configuration,
  GVUI_CATALOG_PATH,
  object,
  permittedComponents,
  replaceJson,
  UUID,
  type GvuiConfiguration,
  type JsonObject,
} from './gvui-layouts';

export type GvuiMailbox = {
  contextId: string;
  upstreamId: string;
  createdAt: number;
};
export type GvuiPreparedRequest = {
  path: string;
  body?: Buffer;
  mailbox?: { alias: string; upstreamId: string };
};

@Injectable()
export class GvuiProxyService {
  private readonly origin: string;
  // Raw configurations are shared metadata, never shared authorization decisions.
  // Every use rechecks this session's effective layout AND component permissions.
  private readonly layouts = new Map<string, GvuiConfiguration>();

  constructor(
    config: ConfigService,
    private readonly ampp: AmppControlService,
  ) {
    this.origin = new URL(config.getOrThrow<string>('PLATFORM_URL')).origin;
  }

  isContext(id: string) {
    return id.startsWith('gvui-');
  }

  private layoutId(session: SessionData, contextId: string): string {
    const id = contextId.slice(5).toLowerCase();
    if (
      !this.isContext(contextId) ||
      !UUID.test(id) ||
      !session.allowedGvuiLayoutIds?.some(
        (allowed) => allowed.toLowerCase() === id,
      ) ||
      !session.allowedGvuiLayouts?.some(
        (layout) => layout.id.toLowerCase() === id,
      )
    ) {
      throw new ForbiddenException('GV.UI layout access is not permitted');
    }
    return id;
  }

  contextWorkload(session: SessionData, contextId: string): string {
    const id = this.layoutId(session, contextId);
    const record = this.layouts.get(id);
    const filtered =
      record && permittedComponents(record, session, this.origin);
    if (!filtered)
      throw new ForbiddenException(
        'GV.UI launch context is unavailable. Open the layout again.',
      );
    return filtered.workloadIds[0];
  }

  isAllowed(session: SessionData, contextId: string): boolean {
    try {
      this.contextWorkload(session, contextId);
      return true;
    } catch {
      return false;
    }
  }

  private catalog(raw: unknown): Map<string, GvuiConfiguration> {
    if (!Array.isArray(raw) || raw.length > 10000)
      throw new BadGatewayException('Invalid GV.UI catalog');
    const records = new Map<string, GvuiConfiguration>(),
      duplicates = new Set<string>();
    for (const item of raw) {
      const record = configuration(item);
      if (!record) continue;
      if (records.has(record.id)) duplicates.add(record.id);
      else records.set(record.id, record);
    }
    for (const id of duplicates) records.delete(id);
    return records;
  }

  async launch(session: SessionData, id: string): Promise<{ url: string }> {
    const contextId = `gvui-${id.toLowerCase()}`;
    const layoutId = this.layoutId(session, contextId);
    let raw: unknown;
    try {
      raw = await this.ampp.getGvuiConfigurations();
    } catch {
      throw new BadGatewayException(
        'Unable to load the AMPP GV.UI catalog. Please retry.',
      );
    }
    const record = this.catalog(raw).get(layoutId);
    const filtered =
      record && permittedComponents(record, session, this.origin);
    if (!filtered) {
      this.layouts.delete(layoutId);
      throw new ConflictException(
        'This layout is missing, unsupported, or has no accessible components with a permitted workload context.',
      );
    }
    if (this.layouts.size >= 512 && !this.layouts.has(layoutId)) {
      const [oldest] = this.layouts.keys();
      if (oldest) this.layouts.delete(oldest);
    }
    this.layouts.set(layoutId, record);
    return { url: `/api/ampp-proxy/ui/${contextId}/gvui/desktop/${layoutId}` };
  }

  assertUiPath(session: SessionData, contextId: string, target: URL): void {
    const id = this.layoutId(session, contextId);
    this.contextWorkload(session, contextId);
    const path = target.pathname.toLowerCase().replace(/\/+$/, '');
    const layout = path.match(/^\/gvui\/(?:callback\/)?desktop\/([^/]+)$/);
    if (
      layout?.[1] === id ||
      path === '/gvui/callback' ||
      path === '/gvui/refresh' ||
      path.startsWith('/gvui/dist/') ||
      path.startsWith('/gvui/images/')
    )
      return;
    throw new ForbiddenException(
      'GV.UI route does not match the authorized layout',
    );
  }

  isCatalogRequest(target: URL): boolean {
    return (
      target.pathname.replace(/\/+$/, '').toLowerCase() === GVUI_CATALOG_PATH &&
      !target.search
    );
  }

  filterApiResponse(
    session: SessionData,
    contextId: string,
    path: string,
    response: AmppCookieHttpResponse,
    proxyOrigin?: string,
  ): AmppCookieHttpResponse {
    const target = new URL(path, this.origin);
    if (
      response.status < 200 ||
      response.status >= 300 ||
      response.status === 204
    )
      return response;
    if (this.isCatalogRequest(target)) {
      const id = this.layoutId(session, contextId);
      let records: Map<string, GvuiConfiguration>;
      try {
        records = this.catalog(JSON.parse(response.body.toString('utf8')));
      } catch {
        throw new BadGatewayException('Invalid GV.UI catalog response');
      }
      const record = records.get(id);
      if (record) this.layouts.set(id, record);
      else this.layouts.delete(id);
      const filtered =
        record &&
        permittedComponents(record, session, this.origin, proxyOrigin);
      return replaceJson(response, filtered ? [filtered.item] : []);
    }
    if (
      /^\/notifications\/api\/v1\/notifications\/[^/]+\/?$/i.test(
        target.pathname,
      )
    ) {
      let items: unknown;
      try {
        items = JSON.parse(response.body.toString('utf8'));
      } catch {
        throw new BadGatewayException('Invalid notification response');
      }
      if (!Array.isArray(items))
        throw new BadGatewayException('Invalid notification response');
      return replaceJson(
        response,
        (items as unknown[]).flatMap((item) => {
          const event = object(item);
          if (typeof event?.topic !== 'string')
            return this.isContext(contextId) ? [] : [item];
          if (!event.topic.toLowerCase().startsWith('gv.ui.notifications.'))
            return this.isContext(contextId) ? [] : [item];
          const filtered = this.notification(
            session,
            contextId,
            event,
            proxyOrigin,
          );
          return filtered ? [filtered] : [];
        }),
      );
    }
    return response;
  }

  private notification(
    session: SessionData,
    contextId: string,
    event: JsonObject,
    proxyOrigin?: string,
  ): JsonObject | undefined {
    try {
      const id = this.layoutId(session, contextId);
      const content =
        typeof event.content === 'string'
          ? (JSON.parse(event.content) as unknown)
          : event.content;
      if (
        Object.entries(event).some(
          ([key, value]) =>
            key !== 'content' && value !== null && typeof value === 'object',
        )
      )
        return;
      const record = configuration(content);
      // Until a real delta-event fixture is available, only a complete, identified
      // configuration can be authorized. Unknown/delta payloads are never relayed.
      if (
        !record ||
        record.id !== id ||
        (event.topic !== 'gv.ui.notifications.#' &&
          event.topic !== `gv.ui.notifications.${id}`)
      )
        return;
      const filtered = permittedComponents(
        record,
        session,
        this.origin,
        proxyOrigin,
      );
      if (!filtered) return;
      return {
        ...event,
        content:
          typeof event.content === 'string'
            ? JSON.stringify(filtered.item)
            : filtered.item,
      };
    } catch {
      return;
    }
  }

  canCreateMailbox(
    session: SessionData,
    contextId: string,
    id: string,
  ): boolean {
    if (!this.isAllowed(session, contextId)) return false;
    const prefix = `ts-api.ampp-proxy.ui.${contextId}.gvui--`;
    const normalized = id.toLowerCase();
    const suffix = normalized.startsWith(prefix)
      ? normalized.slice(prefix.length)
      : normalized.startsWith('ts-gvui--')
        ? normalized.slice(9)
        : '';
    const existing = session.gvuiMailboxes?.[id];
    return UUID.test(suffix) && (!existing || existing.contextId === contextId);
  }

  private ownedMailbox(
    session: SessionData,
    contextId: string,
    alias: string,
  ): GvuiMailbox {
    this.contextWorkload(session, contextId);
    const entry = session.gvuiMailboxes?.[alias];
    if (
      !entry ||
      entry.contextId !== contextId ||
      Date.now() - entry.createdAt >= 1500000
    ) {
      throw new ForbiddenException(
        'GV.UI mailbox does not belong to this layout session',
      );
    }
    return entry;
  }

  assertNotificationRequest(
    session: SessionData,
    contextId: string,
    method: string,
    target: URL,
    body?: Buffer,
  ): void {
    const path = decodeURIComponent(target.pathname);
    const match = path.match(
      /^\/notifications\/api\/v1\/(?:notifications|mailbox)\/([^/]+)/i,
    );
    if (
      match &&
      (this.isContext(contextId) ||
        /gvui/i.test(match[1]) ||
        session.gvuiMailboxes?.[match[1]])
    ) {
      this.ownedMailbox(session, contextId, match[1]);
    }
    if (
      /^\/notifications\/api\/v1\/mailbox\/?$/i.test(path) &&
      method === 'POST'
    ) {
      let id: unknown;
      try {
        id = object(JSON.parse(body?.toString() ?? ''))?.id;
      } catch {
        return;
      }
      if (
        (this.isContext(contextId) ||
          (typeof id === 'string' && /gvui/i.test(id))) &&
        (typeof id !== 'string' ||
          !this.canCreateMailbox(session, contextId, id))
      ) {
        throw new ForbiddenException('GV.UI mailbox creation is not permitted');
      }
    }
  }

  isNotificationTopicAllowed(
    session: SessionData,
    contextId: string,
    alias: string,
    topic: string,
  ): boolean {
    try {
      this.ownedMailbox(session, contextId, alias);
      const id = this.layoutId(session, contextId);
      return (
        topic === 'gv.ui.notifications.#' ||
        topic === `gv.ui.notifications.${id}`
      );
    } catch {
      return false;
    }
  }

  prepareApiRequest(
    session: SessionData,
    contextId: string,
    method: string,
    path: string,
    body?: Buffer,
  ): GvuiPreparedRequest {
    if (!this.isContext(contextId)) return { path, body };
    const target = new URL(path, this.origin);
    if (
      method === 'POST' &&
      /^\/notifications\/api\/v1\/mailbox\/?$/i.test(target.pathname)
    ) {
      let data: JsonObject | undefined;
      try {
        data = object(JSON.parse(body?.toString() ?? ''));
      } catch {
        /* Reject below. */
      }
      const alias = data?.id;
      if (
        typeof alias !== 'string' ||
        !this.canCreateMailbox(session, contextId, alias)
      )
        throw new ForbiddenException('Invalid GV.UI mailbox');
      const upstreamId =
        session.gvuiMailboxes?.[alias]?.upstreamId ??
        `ts-gvui--${randomUUID()}`;
      return {
        path,
        body: Buffer.from(JSON.stringify({ ...data, id: upstreamId })),
        mailbox: { alias, upstreamId },
      };
    }
    const match = target.pathname.match(
      /^(\/notifications\/api\/v1\/(?:notifications|mailbox)\/)([^/]+)(.*)$/i,
    );
    if (match) {
      const entry = this.ownedMailbox(
        session,
        contextId,
        decodeURIComponent(match[2]),
      );
      return {
        path: `${match[1]}${encodeURIComponent(entry.upstreamId)}${match[3]}${target.search}`,
        body,
      };
    }
    return { path, body };
  }

  completeApiRequest(
    session: SessionData,
    contextId: string,
    prepared: GvuiPreparedRequest,
    response: AmppCookieHttpResponse,
  ): AmppCookieHttpResponse {
    if (!prepared.mailbox || response.status < 200 || response.status >= 300)
      return response;
    this.contextWorkload(session, contextId);
    let data: JsonObject | undefined;
    try {
      data = object(JSON.parse(response.body.toString()));
    } catch {
      /* Fail closed below. */
    }
    if (data?.id !== prepared.mailbox.upstreamId)
      throw new BadGatewayException('Invalid GV.UI mailbox response');
    const entries = (session.gvuiMailboxes ??= {});
    for (const [alias, entry] of Object.entries(entries)) {
      if (
        Date.now() - entry.createdAt >= 1500000 ||
        !session.allowedGvuiLayoutIds?.includes(entry.contextId.slice(5))
      )
        delete entries[alias];
    }
    if (Object.keys(entries).length >= 512 && !entries[prepared.mailbox.alias])
      throw new ConflictException('Too many open GV.UI mailboxes');
    entries[prepared.mailbox.alias] = {
      contextId,
      upstreamId: prepared.mailbox.upstreamId,
      createdAt: Date.now(),
    };
    return replaceJson(response, { ...data, id: prepared.mailbox.alias });
  }

  isHubMessageAllowed(
    session: SessionData,
    contextId: string,
    strings: string[],
    fromBrowser = false,
  ): boolean {
    const topics = strings.filter((value) =>
      value.toLowerCase().startsWith('gv.ui.notifications.'),
    );
    const nestedTopics: string[] = [];
    const embedded: JsonObject[] = [];
    const visit = (value: unknown, depth = 0) => {
      if (depth > 24) throw new Error('Notification nesting limit');
      if (
        typeof value === 'string' &&
        value.toLowerCase().startsWith('gv.ui.notifications.')
      ) {
        nestedTopics.push(value);
        return;
      }
      if (
        typeof value === 'string' &&
        (value.startsWith('[') || value.startsWith('{'))
      ) {
        visit(JSON.parse(value) as unknown, depth + 1);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((v) => visit(v, depth + 1));
        return;
      }
      const item = object(value);
      if (!item) return;
      if (
        typeof item.topic === 'string' &&
        item.topic.toLowerCase().startsWith('gv.ui.notifications.')
      )
        embedded.push(item);
      else Object.values(item).forEach((v) => visit(v, depth + 1));
    };
    try {
      for (const value of strings)
        if (value.startsWith('[') || value.startsWith('{'))
          visit(JSON.parse(value) as unknown);
      if (!this.isContext(contextId))
        return !topics.length && !embedded.length && !nestedTopics.length;
      if (nestedTopics.length) return false;
      const id = this.layoutId(session, contextId);
      this.contextWorkload(session, contextId);
      if (fromBrowser) {
        const allowed = new Set([
          'subscribe',
          'unsubscribe',
          'ping',
          'protocol',
          'messagepack',
          'json',
          'version',
          'type',
          'target',
          'arguments',
          'invocationid',
          'subscriptions',
          'context',
          'correlationid',
        ]);
        return strings.every(
          (v) =>
            allowed.has(v.toLowerCase()) ||
            /^\d+$/.test(v) ||
            UUID.test(v) ||
            v === 'gv.ui.notifications.#' ||
            v === `gv.ui.notifications.${id}`,
        );
      }
      if (
        strings.some(
          (value) =>
            value.startsWith('gv.') &&
            !value.startsWith('gv.ui.notifications.'),
        )
      )
        return false;
      if (
        strings.includes('ReceiveNotification') &&
        !topics.length &&
        !embedded.length
      )
        return false;
      const consumed = new Set<string>();
      for (const topic of topics) {
        const index = strings.indexOf(topic);
        const content = strings
          .slice(index + 1)
          .find((value) => value.trimStart().startsWith('{'));
        if (!content) return false;
        const filtered = this.notification(session, contextId, {
          topic,
          content,
        });
        // Binary frames cannot be partially rewritten without changing framing.
        if (!filtered || filtered.content !== content) return false;
        consumed.add(content);
      }
      if (
        !embedded.every((event) => {
          const filtered = this.notification(session, contextId, event);
          return filtered && JSON.stringify(filtered) === JSON.stringify(event);
        })
      )
        return false;
      for (const value of strings) {
        if (!value.startsWith('[') && !value.startsWith('{')) continue;
        const item = object(JSON.parse(value));
        // Parsed objects have different identity; compare the authorized envelope.
        if (
          item &&
          embedded.some(
            (event) => JSON.stringify(event) === JSON.stringify(item),
          )
        )
          consumed.add(value);
      }
      const envelope = new Set([
        'type',
        'target',
        'arguments',
        'invocationid',
        'headers',
        'receivenotification',
        'topic',
        'content',
        'protocol',
        'version',
        'messagepack',
        'json',
      ]);
      return strings.every(
        (value) =>
          consumed.has(value) ||
          topics.includes(value) ||
          envelope.has(value.toLowerCase()) ||
          /^\d+$/.test(value) ||
          UUID.test(value),
      );
    } catch {
      return false;
    }
  }
}
