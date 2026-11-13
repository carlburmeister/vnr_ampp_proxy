import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { raw, type NextFunction, type Request, type Response } from 'express';
import type { SessionData } from 'express-session';
import type { Server } from 'node:http';
import type { AmppCookieHttpService } from '../../src/ampp-proxy/ampp-cookie-http.service';
import { AuthService } from '../../src/auth/auth.service';
import { AmppApiProxyController } from '../../src/ampp-proxy/ampp-api-proxy.controller';
import { AmppProxyController } from '../../src/ampp-proxy/ampp-proxy.controller';
import { AmppProxyPolicyService } from '../../src/ampp-proxy/ampp-proxy-policy.service';
import { AmppProxyService } from '../../src/ampp-proxy/ampp-proxy.service';
import { AmppProxySessionService } from '../../src/ampp-proxy/ampp-proxy-session.service';
import { AmppMatrixFilterService } from '../../src/ampp-proxy/ampp-matrix-filter.service';
import { AmppDashboardFilterService } from '../../src/ampp-proxy/ampp-dashboard-filter.service';
import { AmppResponseRewriterService } from '../../src/ampp-proxy/ampp-response-rewriter.service';
import { GvuiProxyService } from '../../src/ampp-proxy/gvui/gvui-proxy.service';

export const W = '11111111-1111-4111-8111-111111111111';
export const OTHER = '22222222-2222-4222-8222-222222222222';
export const PANEL = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://ampp.invalid';
export const catalog = '/ampp/control/api/v1/panel/panels';
export const embedded = `/ampp/control/embedded/panelControl/${PANEL}/workload/${W}`;
export const api = (path: string, context = W) =>
  `/api/ampp-proxy/api/${context}${path}`;
export const ui = (path: string, context = W) =>
  `/api/ampp-proxy/ui/${context}${path}`;
const panel = {
  id: PANEL,
  name: 'Fixture MaverikX',
  applicationType: 'MaverikX',
};

// Real guards/controllers, request policy, proxy, filters, session merge and URL
// rewriting. Only AMPP/authentication and persistent session storage are fixtures.
export async function setupPanelFixture() {
  let stored = {
    user: { id: 'fixture-user' },
    authorizationFingerprint: 'granted',
    allowedWorkloads: [
      {
        id: W,
        name: 'Maverik X',
        is_parent: 0,
        pageType: 'ampp-ui',
        packageName: 'GV.AMPP.Apps.ProdSwitcher',
      },
    ],
    amppAllowedWorkloadIds: [W],
    amppResourceWorkloadIds: [W, OTHER],
  } as SessionData;
  let cutCount = 0;
  const requests: { path: string; method: string; body?: unknown }[] = [];
  let report: (value: unknown) => void;
  const result = new Promise<unknown>((resolve) => {
    report = resolve;
  });
  const config = new ConfigService({ PLATFORM_URL: ORIGIN });
  const matrix = new AmppMatrixFilterService(config);
  const gvui = new GvuiProxyService(config, {} as never);
  const rewriter = new AmppResponseRewriterService(config);
  const upstream: AmppCookieHttpService['request'] = (_jar, path, options) => {
    const rawData: unknown = options?.data;
    const body =
      Buffer.isBuffer(rawData) && rawData.length
        ? (JSON.parse(rawData.toString()) as Record<string, unknown>)
        : undefined;
    requests.push({ path, method: options.method ?? 'GET', body });
    let value: unknown = {};
    let html: string | undefined;
    let status = 200;
    if (path === catalog)
      value = {
        panels: {
          [PANEL]: panel,
          other: { ...panel, id: OTHER, workloadId: OTHER },
          mixer: { ...panel, id: 'mixer', applicationType: 'MiniMixer' },
        },
      };
    else if (path === `/ampp/control/api/v1/panel/${PANEL}`) value = panel;
    else if (path === '/ampp/control/api/v1/control/application/references')
      value = [{ name: 'MaverikX' }, { name: 'MiniMixer' }];
    else if (path === '/cluster/state/api/v1/workloads')
      value = {
        workloads: [
          { workload: { id: W, name: 'MaverikX' } },
          {
            workload: {
              id: OTHER,
              name: 'Resource only',
              secret: 'must not escape',
            },
          },
        ],
      };
    else if (path === '/ampp/control/api/v1/macro')
      value = [
        { uuid: PANEL, commands: [{ workload: W }] },
        { uuid: OTHER, commands: [{ workload: OTHER }] },
      ];
    else if (path === '/ampp/control/api/v1/control/commit') {
      if (body.command === 'cut') cutCount++;
      status = 204;
    } else if (path.includes('/subscribe/')) status = 204;
    else if (path.includes('/notifications/api/v1/notifications/'))
      value = [
        {
          topic: `gv.ampp.control.${W}.cut.notify`,
          content: { cutCount },
        },
      ];
    else if (path === embedded) html = panelHtml();
    else if (path.startsWith(`/mocha/application/${W}/embedded`))
      html = workloadHtml();
    return Promise.resolve({
      url: ORIGIN + path,
      status,
      headers: { 'content-type': html ? 'text/html' : 'application/json' },
      body: Buffer.from(html ?? (status === 204 ? '' : JSON.stringify(value))),
    });
  };
  const proxy = new AmppProxyService(
    config,
    { getSessionToken: () => 'fixture-token' } as never,
    { secureUiResponse: (response: unknown) => response } as never,
    { request: upstream } as never,
    new AmppDashboardFilterService(config),
    matrix,
    rewriter,
    {
      getCookieJar: () => Promise.resolve({}),
      saveCookieJar: () => {},
    } as never,
    { isLoginResponse: () => false } as never,
    gvui,
  );
  const module = await Test.createTestingModule({
    controllers: [AmppApiProxyController, AmppProxyController],
    providers: [
      { provide: ConfigService, useValue: config },
      {
        provide: AuthService,
        useValue: { refreshSessionAuthorization: () => Promise.resolve(false) },
      },
      {
        provide: AmppProxyPolicyService,
        useValue: new AmppProxyPolicyService(matrix, gvui),
      },
      { provide: AmppProxyService, useValue: proxy },
      { provide: AmppResponseRewriterService, useValue: rewriter },
      { provide: GvuiProxyService, useValue: gvui },
      AmppProxySessionService,
    ],
  }).compile();
  const app: INestApplication<Server> = module.createNestApplication();
  app.setGlobalPrefix('api');
  app.use(raw({ type: () => true }));
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.url === '/fixture/result') {
      report(JSON.parse((req.body as Buffer).toString()) as unknown);
      res.status(204).end();
      return;
    }
    req.sessionID = 'panel-fixture';
    req.session = Object.assign(structuredClone(stored), {
      touch: () => {},
      save: (done: () => void) => {
        stored = JSON.parse(JSON.stringify(req.session)) as SessionData;
        done();
      },
    }) as Request['session'];
    req.sessionStore = {
      get: (_id: string, done: (err: null, session: SessionData) => void) =>
        done(null, structuredClone(stored)),
    } as never;
    next();
  });
  await app.init();
  return {
    app,
    requests,
    result,
    revoke: () => {
      stored.authorizationFingerprint = 'revoked';
      stored.allowedWorkloads = [];
      stored.amppAllowedWorkloadIds = [];
      stored.amppPanelIdsByWorkload = undefined;
    },
  };
}

function workloadHtml() {
  return `<html><head></head><body><div id="panels"></div><script>
  (async()=>{
    const response=await fetch('${catalog}');
    const data=await response.json();
    const panels=Object.values(data.panels).filter(p=>p.applicationType==='MaverikX');
    if(panels.length!==1)throw Error('Unfiltered catalogue');
    const frame=document.createElement('iframe');frame.id='panel';
    frame.src='/ampp/control/embedded/panelControl/'+panels[0].id+'/workload/${W}';
    window.addEventListener('message',async event=>{
      if(event.data==='panelLoaded')frame.contentWindow.document.getElementById('cut').click();
      if(event.data?.cutCount===1){
        const denied=await fetch('/ampp/control/embedded/panelControl/${PANEL}/workload/${OTHER}');
        await fetch(window.location.origin+'/fixture/result',{method:'POST',body:JSON.stringify({
          panels:panels.length,frame:frame.src,cutCount:event.data.cutCount,denied:denied.status
        })});
      }
    });
    document.getElementById('panels').appendChild(frame);
  })().catch(e=>fetch(window.location.origin+'/fixture/result',{method:'POST',body:JSON.stringify({error:String(e)})}));
  </script></body></html>`;
}

function panelHtml() {
  return `<html><head></head><body><button id="cut">Cut</button><script>
  window.addEventListener('unhandledrejection',event=>fetch(window.location.origin+'/fixture/result',{
    method:'POST',body:JSON.stringify({error:String(event.reason)})
  }));
  (async()=>{
    const definition=await fetch('/ampp/control/api/v1/panel/${PANEL}');
    if(!definition.ok)throw Error('Panel definition failed');
    const post=(path,data)=>fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    await post('/ampp/control/api/v1/control/commit',{
      application:'any',command:'getstate',workload:'${W}',reconKey:'panel-state',formData:'{}'
    });
    const mailbox='ts-api.ampp-proxy.ui.${W}.app.wrapper--${PANEL}';
    const subscribed=await post('/notifications/api/v1/mailbox/'+mailbox+'/subscribe/gv.ampp.control.${W}.*.*');
    if(!subscribed.ok)throw Error('Panel subscription failed');
    document.getElementById('cut').onclick=async()=>{
      const sent=await post('/ampp/control/api/v1/control/commit',{
        application:'MaverikX',command:'cut',workload:'${W}',reconKey:'panel-cut',formData:'{"bankIndex":0}'
      });
      if(!sent.ok)throw Error('Panel control failed');
      const events=await(await fetch('/notifications/api/v1/notifications/'+mailbox+'?count=100&timeout=1000')).json();
      window.parent.postMessage({cutCount:events[0].content.cutCount},window.location.origin);
    };
    window.parent.postMessage('panelLoaded',window.location.origin);
  })().catch(e=>fetch(window.location.origin+'/fixture/result',{method:'POST',body:JSON.stringify({error:String(e)})}));
  </script></body></html>`;
}
