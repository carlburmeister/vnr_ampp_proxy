import { BadGatewayException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SessionData } from 'express-session';

import type { AmppCookieHttpResponse } from '../ampp-cookie-http.service';

// Development-only GV.UI proof of concept. Disabled unless explicitly configured.
const LAYOUT_ID = 'f8106b06-9ff0-424d-b6dc-5df246f3ee2f';
const COMPONENTS = new Map([
  ['6ac0ee96-f6cb-46d2-be4e-00034ad72943', 'GV.AMPP.Apps.FlowMonitor'],
  ['cbda2ccd-a99f-4c6a-8e82-1e0948858441', 'GV.AMPP.Apps.MiniMixer'],
  ['bc8a392e-f043-467b-8358-7dfab9d13ea0', 'GV.AMPP.Apps.AudioMixer'],
  ['19876769-99e5-4685-a7e2-95d8c0720284', 'GV.AMPP.Apps.SrtInput'],
  ['fbab1aa9-405b-460d-abfa-83a239981f5e', 'GV.AMPP.Apps.SrtInput'],
]);
const CATALOG_PATH = '/configuration/api/v1/configurations/startswith/gv-ui-l';

@Injectable()
export class GvuiPhase1Service {
  private readonly platformOrigin: string;
  private readonly logger = new Logger(GvuiPhase1Service.name);

  constructor(private readonly config: ConfigService) {
    this.platformOrigin = new URL(config.getOrThrow<string>('PLATFORM_URL')).origin;
  }

  getLayout(session: SessionData): { id: string; name: string; workloadId: string } | null {
    const userId = this.config.get<string>('GVUI_PHASE1_USER_ID');
    if (
      this.config.get<string>('GVUI_PHASE1_ENABLED') !== 'true' ||
      !userId ||
      !session.user ||
      session.user.userType !== 'admin' ||
      session.user.id !== userId
    ) {
      return null;
    }

    // Require a known test-layout child under a single assigned parent.
    // Denying one embedded UI must not hide the entire layout.
    const parent = (session.allowedWorkloads ?? []).find((workload) => {
      const childIds = new Set(
        (workload.child_workloads ?? []).map((child) => child.id.toLowerCase()),
      );
      return workload.is_parent === 1 &&
        [...COMPONENTS.keys()].some((id) => childIds.has(id));
    });

    return parent ? { id: LAYOUT_ID, name: 'CKB_Test_Prod (GV.UI test)', workloadId: parent.id } : null;
  }

  isAllowed(session: SessionData, workloadId: string): boolean {
    return this.getLayout(session)?.workloadId.toLowerCase() === workloadId.toLowerCase();
  }

  assertUiPath(session: SessionData, workloadId: string, target: URL): void {
    if (!this.isAllowed(session, workloadId)) {
      throw new ForbiddenException('GV.UI development layout is not permitted');
    }
    // OAuth callbacks and the selected layout may include query parameters.
    // Authorize the exact route, not the query string; other layouts stay blocked.
    const path = target.pathname.toLowerCase().replace(/\/+$/, '');
    // GV.UI returns from OAuth through /gvui/callback/desktop/{layoutId}.
    // Match layout-bearing routes by ID, rather than separately allowing guessed callback paths.
    const layoutRoute = path.match(/^\/gvui\/(?:callback\/)?desktop\/([0-9a-f-]{36})$/);
    if (
      layoutRoute?.[1] === LAYOUT_ID ||
      path === '/gvui/callback' ||
      path === '/gvui/refresh' ||
      path.startsWith('/gvui/dist/') ||
      path.startsWith('/gvui/images/')
    ) {
      return;
    }
    // Log only the path and presence of a query, never OAuth query values.
    this.logger.warn(
      `Rejected GV.UI path=${target.pathname} query=${target.search ? 'present' : 'absent'}`,
    );
    throw new ForbiddenException('Only the selected GV.UI layout may be opened');
  }

  isCatalogRequest(target: URL): boolean {
    return target.pathname.replace(/\/+$/, '').toLowerCase() === CATALOG_PATH && !target.search;
  }

  isCatalogAllowed(session: SessionData, workloadId: string, method: string, target: URL): boolean {
    return method === 'GET' && this.isCatalogRequest(target) && this.isAllowed(session, workloadId);
  }

  isMailboxIdAllowed(session: SessionData, workloadId: string, id: string): boolean {
    if (!this.isAllowed(session, workloadId)) return false;
    const prefix = `ts-api.ampp-proxy.ui.${workloadId.toLowerCase()}.`;
    const normalized = id.toLowerCase();
    return /^ts-gvui--[0-9a-f-]{36}$/.test(normalized) ||
      (normalized.startsWith(prefix) &&
        /^gvui--[0-9a-f-]{36}$/.test(normalized.slice(prefix.length)));
  }

  isNotificationTopicAllowed(
    session: SessionData,
    workloadId: string,
    mailboxId: string,
    topic: string,
  ): boolean {
    return this.isMailboxIdAllowed(session, workloadId, mailboxId) &&
      topic.toLowerCase() === 'gv.ui.notifications.#';
  }

  filterCatalog(
    session: SessionData,
    workloadId: string,
    upstreamPath: string,
    response: AmppCookieHttpResponse,
  ): AmppCookieHttpResponse {
    const target = new URL(upstreamPath, 'http://ampp-proxy.local');
    if (!this.isCatalogRequest(target) || response.status < 200 || response.status >= 300) {
      return response;
    }
    if (!this.isAllowed(session, workloadId)) {
      throw new ForbiddenException('GV.UI catalog is not permitted');
    }

    let items: unknown;
    try {
      items = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new BadGatewayException('Invalid GV.UI catalog response');
    }
    if (!Array.isArray(items)) {
      throw new BadGatewayException('Invalid GV.UI catalog response');
    }

    // Verify embedded applications against the current user's effective child-workload
    // permissions, so adding an authorized UI does not require another code change.
    const parent = (session.allowedWorkloads ?? []).find(
      (workload) => workload.id.toLowerCase() === workloadId.toLowerCase() && workload.is_parent === 1,
    );
    const children = new Map(
      (parent?.child_workloads ?? []).map((child) => [child.id.toLowerCase(), child.packageName]),
    );
    const selected: unknown[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const configuration = (item as { configuration?: { key?: string; value?: string } }).configuration;
      if (configuration?.key?.toLowerCase() !== `gv-ui-l/${LAYOUT_ID}` ||
          typeof configuration.value !== 'string') continue;
      try {
        const layout = JSON.parse(configuration.value) as {
          components?: Array<{ type?: string; url?: string }>;
        };
        if (!Array.isArray(layout.components) || layout.components.length === 0) continue;
        const authorizedComponents: typeof layout.components = [];
        let invalid = false;
        for (const component of layout.components) {
          if (component?.type !== 'web' || typeof component.url !== 'string') {
            invalid = true;
            break;
          }
          const url = new URL(component.url);
          const match = url.pathname.match(
            /^\/app\/wrapper\/embedded\/single\/([^/]+)\/([0-9a-f-]{36})\/?$/i,
          );
          if (!match || url.origin !== this.platformOrigin || url.search || url.hash) {
            invalid = true;
            break;
          }
          const allowedPackage = children.get(match[2].toLowerCase());
          if (allowedPackage && allowedPackage !== match[1]) {
            invalid = true;
            break;
          }
          // A denied child remains unavailable as a UI, but does not hide its siblings.
          if (allowedPackage) authorizedComponents.push(component);
        }
        if (invalid || authorizedComponents.length === 0) continue;
        selected.push({
          ...item,
          configuration: {
            ...configuration,
            value: JSON.stringify({ ...layout, components: authorizedComponents }),
          },
        });
      } catch {
        continue;
      }
    }

    // Only return the selected layout, and never expose unauthorized embedded components.
    const body = Buffer.from(JSON.stringify(selected));
    // The upstream ETag describes a different body and cannot validate this user-specific response.
    const headers: AmppCookieHttpResponse['headers'] = {
      ...response.headers,
      'content-length': String(body.length),
    };
    delete headers.etag;
    delete headers['last-modified'];
    return { ...response, body, headers };
  }
}
