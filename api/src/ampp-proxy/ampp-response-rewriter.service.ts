import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AmppCookieHttpResponse } from './ampp-cookie-http.service';

export type AmppBrowserResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

@Injectable()
export class AmppResponseRewriterService {
  private readonly platformUrl: URL;

  constructor(private readonly config: ConfigService) {
    this.platformUrl = new URL(
      this.config.getOrThrow<string>('PLATFORM_URL'),
    );
  }

  rewrite(
    workloadId: string,
    publicOrigin: string,
    response: AmppCookieHttpResponse,
  ): AmppBrowserResponse {
    const contentType = this.headerValue(response.headers['content-type']);
    const headers = this.createBrowserHeaders(
      workloadId,
      publicOrigin,
      response,
      contentType,
    );

    return {
      status: response.status,
      headers,
      body: this.rewriteBody(
        workloadId,
        publicOrigin,
        response.url,
        contentType,
        response.body,
      ),
    };
  }

  rewriteApi(
    workloadId: string,
    publicOrigin: string,
    response: AmppCookieHttpResponse,
  ): AmppBrowserResponse {
    const contentType = this.headerValue(response.headers['content-type']);

    return {
      status: response.status,
      headers: this.createApiBrowserHeaders(
        workloadId,
        publicOrigin,
        response,
        contentType,
      ),
      body: response.body,
    };
  }

  createProxyPath(workloadId: string, upstreamPath: string): string {
    return (
      `/api/ampp-proxy/ui/${encodeURIComponent(workloadId)}` +
      upstreamPath
    );
  }

  createApiProxyPath(workloadId: string, upstreamPath: string): string {
    return (
      `/api/ampp-proxy/api/${encodeURIComponent(workloadId)}` +
      upstreamPath
    );
  }

  private createBrowserHeaders(
    workloadId: string,
    publicOrigin: string,
    response: AmppCookieHttpResponse,
    contentType: string,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': [
        "default-src 'self' data: blob:",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        `connect-src 'self' ${publicOrigin.replace(/^http/i, 'ws')}`,
        "worker-src 'self' blob:",
        "frame-src 'self' blob:",
        "frame-ancestors 'self'",
        "object-src 'none'",
        "base-uri 'self'",
      ].join('; '),
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
    };

    if (contentType) {
      headers['Content-Type'] = contentType;
    }

    for (const name of [
      'accept-ranges',
      'content-disposition',
      'content-language',
      'content-range',
    ]) {
      const value = this.headerValue(response.headers[name]);

      if (value) {
        headers[this.headerName(name)] = value;
      }
    }

    const location = this.headerValue(response.headers.location);

    if (location) {
      headers.Location = this.rewriteUrl(
        location,
        response.url,
        workloadId,
        publicOrigin,
      );
    }

    return headers;
  }

  private createApiBrowserHeaders(
    workloadId: string,
    publicOrigin: string,
    response: AmppCookieHttpResponse,
    contentType: string,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };

    if (contentType) {
      headers['Content-Type'] = contentType;
    }

    for (const name of [
      'accept-ranges',
      'content-disposition',
      'content-language',
      'content-range',
      'etag',
      'last-modified',
      'retry-after',
      'www-authenticate',
    ]) {
      const value = this.headerValue(response.headers[name]);

      if (value) {
        headers[this.headerName(name)] = value;
      }
    }

    const location = this.headerValue(response.headers.location);

    if (location) {
      headers.Location = this.rewriteUrl(
        location,
        response.url,
        workloadId,
        publicOrigin,
      );
    }

    return headers;
  }

  private rewriteBody(
    workloadId: string,
    publicOrigin: string,
    responseUrl: string,
    contentType: string,
    body: Buffer,
  ): Buffer {
    if (!body.length || !this.isTextContent(contentType)) {
      return body;
    }

    const text = body.toString('utf8');

    if (/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      return Buffer.from(
        this.rewriteHtml(text, responseUrl, workloadId, publicOrigin),
      );
    }

    if (/text\/css/i.test(contentType)) {
      return Buffer.from(
        this.rewriteCss(text, responseUrl, workloadId, publicOrigin),
      );
    }

    return body;
  }

  private rewriteHtml(
    html: string,
    responseUrl: string,
    workloadId: string,
    publicOrigin: string,
  ): string {
    const rawElements: string[] = [];
    let rewritten = html.replace(
      /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      (element, elementName: string) => {
        const openTagEnd = element.indexOf('>') + 1;
        const closeTagStart = element.toLowerCase().lastIndexOf(
          `</${elementName.toLowerCase()}`,
        );
        const openTag = this.rewriteHtmlTag(
          element.slice(0, openTagEnd),
          responseUrl,
          workloadId,
          publicOrigin,
        );
        const content = element.slice(openTagEnd, closeTagStart);
        const rewrittenContent =
          elementName.toLowerCase() === 'style'
            ? this.rewriteCss(
                content,
                responseUrl,
                workloadId,
                publicOrigin,
              )
            : content;
        const placeholder = `\uE000AMPP_RAW_${rawElements.length}\uE001`;

        rawElements.push(
          `${openTag}${rewrittenContent}${element.slice(closeTagStart)}`,
        );
        return placeholder;
      },
    );

    rewritten = rewritten.replace(/<[^>]+>/g, (tag) =>
      this.rewriteHtmlTag(
        tag,
        responseUrl,
        workloadId,
        publicOrigin,
      ),
    );

    rewritten = rewritten.replace(
      /\uE000AMPP_RAW_(\d+)\uE001/g,
      (placeholder, index: string) => rawElements[Number(index)] ?? placeholder,
    );

    const baseHref = this.createBaseHref(
      responseUrl,
      workloadId,
      publicOrigin,
    );

    if (!/<base\b/i.test(rewritten)) {
      rewritten = this.insertIntoHead(
        rewritten,
        `<base href="${baseHref}">`,
      );
    }

    return this.insertIntoHead(
      rewritten,
      this.createRuntimeRewriteScript(responseUrl, workloadId),
    );
  }

  private rewriteHtmlTag(
    tag: string,
    responseUrl: string,
    workloadId: string,
    publicOrigin: string,
  ): string {
    let rewritten = tag.replace(
      /(\b(?:src|href|action|poster|manifest|data-src|data-href)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      (
        match,
        prefix: string,
        doubleQuoted: string,
        singleQuoted: string,
        unquoted: string,
      ) => {
        const value = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
        const quote =
          doubleQuoted !== undefined
            ? '"'
            : singleQuoted !== undefined
              ? "'"
              : '';
        return `${prefix}${quote}${this.rewriteUrl(
          value,
          responseUrl,
          workloadId,
          publicOrigin,
        )}${quote}`;
      },
    );

    rewritten = rewritten.replace(
      /(\bsrcset\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      (
        match,
        prefix: string,
        doubleQuoted: string,
        singleQuoted: string,
        unquoted: string,
      ) => {
        const value = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
        const quote =
          doubleQuoted !== undefined
            ? '"'
            : singleQuoted !== undefined
              ? "'"
              : '';
        const rewrittenValue = value
          .split(',')
          .map((candidate) => {
            const parts = candidate.trim().split(/\s+/, 2);
            return [
              this.rewriteUrl(
                parts[0],
                responseUrl,
                workloadId,
                publicOrigin,
              ),
              parts[1],
            ]
              .filter(Boolean)
              .join(' ');
          })
          .join(', ');
        return `${prefix}${quote}${rewrittenValue}${quote}`;
      },
    );

    return rewritten.replace(
      /(\bstyle\s*=\s*)("([^"]*)"|'([^']*)')/gi,
      (
        match,
        prefix: string,
        quotedValue: string,
        doubleQuoted: string,
        singleQuoted: string,
      ) => {
        const quote = quotedValue[0];
        const value = doubleQuoted ?? singleQuoted ?? '';
        return `${prefix}${quote}${this.rewriteCss(
          value,
          responseUrl,
          workloadId,
          publicOrigin,
        )}${quote}`;
      },
    );
  }

  private rewriteCss(
    css: string,
    responseUrl: string,
    workloadId: string,
    publicOrigin: string,
  ): string {
    const rewritten = css
      .replace(
        /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi,
        (match, doubleQuoted: string, singleQuoted: string, unquoted: string) => {
          const value = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
          return `url("${this.rewriteUrl(
            value,
            responseUrl,
            workloadId,
            publicOrigin,
          )}")`;
        },
      )
      .replace(
        /(@import\s+)(?:"([^"]*)"|'([^']*)')/gi,
        (match, prefix: string, doubleQuoted: string, singleQuoted: string) => {
          const value = doubleQuoted ?? singleQuoted ?? '';
          return `${prefix}"${this.rewriteUrl(
            value,
            responseUrl,
            workloadId,
            publicOrigin,
          )}"`;
        },
      );

    return this.rewriteAbsoluteAmppUrls(
      rewritten,
      workloadId,
      publicOrigin,
    );
  }

  private rewriteAbsoluteAmppUrls(
    text: string,
    workloadId: string,
    publicOrigin: string,
  ): string {
    const httpProxyBase =
      publicOrigin +
      `/api/ampp-proxy/ui/${encodeURIComponent(workloadId)}`;
    const wsProxyBase =
      publicOrigin.replace(/^http/i, 'ws') +
      `/api/ampp-proxy/ws/${encodeURIComponent(workloadId)}`;
    const upstreamHttpOrigin = this.platformUrl.origin;
    const upstreamWsOrigin = upstreamHttpOrigin.replace(/^http/i, 'ws');

    return text
      .split(upstreamWsOrigin)
      .join(wsProxyBase)
      .split(upstreamHttpOrigin)
      .join(httpProxyBase)
      .split(this.escapeSlashes(upstreamWsOrigin))
      .join(this.escapeSlashes(wsProxyBase))
      .split(this.escapeSlashes(upstreamHttpOrigin))
      .join(this.escapeSlashes(httpProxyBase));
  }

  private rewriteRootRelativeUiUrls(
    text: string,
    workloadId: string,
    publicOrigin: string,
  ): string {
    const proxyBase =
      publicOrigin +
      `/api/ampp-proxy/ui/${encodeURIComponent(workloadId)}`;

    return text.replace(
      /(["'`])\/(identity|app|assets|static)(?=\/)/gi,
      `$1${proxyBase}/$2`,
    );
  }

  private rewriteUrl(
    value: string,
    baseUrl: string,
    workloadId: string,
    publicOrigin: string,
  ): string {
    const trimmedValue = value.trim();

    if (
      !trimmedValue ||
      /^(?:#|data:|blob:|javascript:|mailto:|tel:|about:)/i.test(trimmedValue)
    ) {
      return value;
    }

    let target: URL;

    try {
      target = new URL(trimmedValue.replace(/&amp;/gi, '&'), baseUrl);
    } catch {
      return value;
    }

    const publicUrl = new URL(publicOrigin);
    const uiProxyPath = `/api/ampp-proxy/ui/${encodeURIComponent(workloadId)}`;
    const apiProxyPath = `/api/ampp-proxy/api/${encodeURIComponent(workloadId)}`;
    const wsProxyPath = `/api/ampp-proxy/ws/${encodeURIComponent(workloadId)}`;

    if (target.origin === publicUrl.origin) {
      if (target.pathname.startsWith(uiProxyPath)) {
        const upstreamPath =
          target.pathname.slice(uiProxyPath.length) || '/';
        const proxyPath = this.isApiPath(upstreamPath)
          ? apiProxyPath
          : uiProxyPath;

        return (
          publicOrigin +
          proxyPath +
          upstreamPath +
          target.search +
          target.hash
        );
      }

      if (
        target.pathname.startsWith(apiProxyPath) ||
        target.pathname.startsWith(wsProxyPath)
      ) {
        return target.toString();
      }
    }

    if (target.host !== this.platformUrl.host) {
      return value;
    }

    const path = `${target.pathname}${target.search}${target.hash}`;

    if (target.protocol === 'ws:' || target.protocol === 'wss:') {
      return `${publicOrigin.replace(/^http/i, 'ws')}${wsProxyPath}${path}`;
    }

    if (target.origin !== this.platformUrl.origin) {
      throw new BadGatewayException(
        `AMPP response referenced an unexpected origin: ${target.origin}`,
      );
    }

    const proxyPath = this.isApiPath(target.pathname)
      ? apiProxyPath
      : uiProxyPath;

    return `${publicOrigin}${proxyPath}${path}`;
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

  private createBaseHref(
    responseUrl: string,
    workloadId: string,
    publicOrigin: string,
  ): string {
    const url = new URL(responseUrl);
    const pathname = url.pathname.endsWith('/')
      ? url.pathname
      : url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);

    return (
      publicOrigin +
      `/api/ampp-proxy/ui/${encodeURIComponent(workloadId)}` +
      pathname
    );
  }

  private createRuntimeRewriteScript(
    responseUrl: string,
    workloadId: string,
  ): string {
    const responsePath = new URL(responseUrl);
    const values = {
      upstreamDocumentPath: `${responsePath.pathname}${responsePath.search}`,
      upstreamHttpOrigin: this.platformUrl.origin,
      upstreamWsOrigin: this.platformUrl.origin.replace(/^http/i, 'ws'),
      httpProxyPath: `/api/ampp-proxy/ui/${encodeURIComponent(workloadId)}`,
      apiProxyPath: `/api/ampp-proxy/api/${encodeURIComponent(workloadId)}`,
      wsProxyPath: `/api/ampp-proxy/ws/${encodeURIComponent(workloadId)}`,
    };

    return `<script data-ampp-proxy-bootstrap>(function(){
const c=${JSON.stringify(values)};
const proxyHttpBase=window.location.origin+c.httpProxyPath;
const proxyApiBase=window.location.origin+c.apiProxyPath;
const proxyWsOrigin=window.location.origin.replace(/^http/i,'ws');
const proxyWsBase=proxyWsOrigin+c.wsProxyPath;
const amppRootPaths=['/app/','/identity/','/assets/','/static/','/mocha/'];
const isAmppRootPath=function(path){return amppRootPaths.some(function(prefix){return path.startsWith(prefix);});};
const isAmppApiPath=function(path){return /^\\/(?:api|graphql)(?:\\/|$)/i.test(path)||/^\\/(?:discovery|configuration|identity|notifications|logging)\\/api(?:\\/|$)/i.test(path)||/^\\/cluster\\/(?:store|state|matrix)\\/api(?:\\/|$)/i.test(path)||/^\\/mocha\\/application\\/[^/]+\\/api(?:\\/|$)/i.test(path);};
const stripUiProxyPath=function(value){return String(value).split(c.httpProxyPath).join('');};
const normalizeAuthorizeUrl=function(url){const path=url.pathname.startsWith(c.httpProxyPath)?url.pathname.slice(c.httpProxyPath.length)||'/':url.pathname;if(path.toLowerCase()!=='/identity/connect/authorize')return url;const redirectUri=url.searchParams.get('redirect_uri');if(redirectUri){try{const callback=new URL(redirectUri,c.upstreamHttpOrigin);const callbackPath=stripUiProxyPath(callback.pathname)||'/';url.searchParams.set('redirect_uri',new URL(callbackPath+callback.search+callback.hash,c.upstreamHttpOrigin).toString());}catch{}}const state=url.searchParams.get('state');if(state){try{const parsed=JSON.parse(state);if(parsed&&typeof parsed==='object'&&typeof parsed.to==='string'){parsed.to=stripUiProxyPath(parsed.to);url.searchParams.set('state',JSON.stringify(parsed));}}catch{}}return url;};
const rewriteHttp=function(value){try{if(value===undefined||value===null)return value;const raw=String(value);const u=normalizeAuthorizeUrl(new URL(raw,c.upstreamHttpOrigin+c.upstreamDocumentPath));if(u.origin===window.location.origin){if(u.pathname.startsWith(c.httpProxyPath)){const upstreamPath=u.pathname.slice(c.httpProxyPath.length)||'/';const proxyBase=isAmppApiPath(upstreamPath)?proxyApiBase:proxyHttpBase;return proxyBase+upstreamPath+u.search+u.hash;}if(u.pathname.startsWith(c.apiProxyPath)||u.pathname.startsWith(c.wsProxyPath))return u.toString();if(isAmppApiPath(u.pathname))return proxyApiBase+u.pathname+u.search+u.hash;return isAmppRootPath(u.pathname)?proxyHttpBase+u.pathname+u.search+u.hash:raw;}if(u.origin!==c.upstreamHttpOrigin)return raw;const proxyBase=isAmppApiPath(u.pathname)?proxyApiBase:proxyHttpBase;return proxyBase+u.pathname+u.search+u.hash;}catch{return value;}};
const rewriteWs=function(value){try{if(value===undefined||value===null)return value;const raw=String(value);const u=new URL(raw,c.upstreamWsOrigin+c.upstreamDocumentPath);if(u.host===window.location.host){if(u.pathname.startsWith(c.httpProxyPath)){const upstreamPath=u.pathname.slice(c.httpProxyPath.length)||'/';return proxyWsBase+upstreamPath+u.search+u.hash;}if(u.pathname.startsWith(c.wsProxyPath))return proxyWsOrigin+u.pathname+u.search+u.hash;return raw;}if(u.host!==new URL(c.upstreamWsOrigin).host)return raw;return proxyWsBase+u.pathname+u.search+u.hash;}catch{return value;}};
const patchConfig=function(config){if(!config||typeof config!=='object')return config;const originalProxyPath=typeof config.proxyPath==='string'?config.proxyPath:'';const proxyPath=originalProxyPath.startsWith(c.httpProxyPath)?originalProxyPath:c.httpProxyPath+originalProxyPath;const configValues={baseUri:window.location.origin,proxyPath:proxyPath,platformUri:proxyHttpBase,clusterUri:proxyHttpBase};for(const key of Object.keys(configValues)){const value=configValues[key];try{const descriptor=Object.getOwnPropertyDescriptor(config,key);if(!descriptor||descriptor.configurable){Object.defineProperty(config,key,{configurable:true,enumerable:descriptor?descriptor.enumerable:true,get:function(){return value;},set:function(){}});}else{config[key]=value;}}catch{try{config[key]=value;}catch{}}}return config;};
let gvConfig=patchConfig(window.__GVCONFIG__);try{Object.defineProperty(window,'__GVCONFIG__',{configurable:true,enumerable:true,get:function(){return gvConfig;},set:function(value){gvConfig=patchConfig(value);}});}catch{if(window.__GVCONFIG__)patchConfig(window.__GVCONFIG__);}
const nativeFetch=window.fetch.bind(window);window.fetch=function(input,init){if(input instanceof Request){const url=rewriteHttp(input.url);return nativeFetch(url===input.url?input:new Request(url,input),init);}return nativeFetch(rewriteHttp(input),init);};
const nativeOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url){arguments[1]=rewriteHttp(url);return nativeOpen.apply(this,arguments);};
if(window.EventSource){const NativeEventSource=window.EventSource;const ProxyEventSource=function(url,config){return new NativeEventSource(rewriteHttp(url),config);};ProxyEventSource.prototype=NativeEventSource.prototype;Object.setPrototypeOf(ProxyEventSource,NativeEventSource);window.EventSource=ProxyEventSource;}
if(window.WebSocket){const NativeWebSocket=window.WebSocket;const ProxyWebSocket=function(url,protocols){return protocols===undefined?new NativeWebSocket(rewriteWs(url)):new NativeWebSocket(rewriteWs(url),protocols);};ProxyWebSocket.prototype=NativeWebSocket.prototype;Object.setPrototypeOf(ProxyWebSocket,NativeWebSocket);window.WebSocket=ProxyWebSocket;}
const patchUrlProperty=function(prototype,name,rewrite){if(!prototype)return;const descriptor=Object.getOwnPropertyDescriptor(prototype,name);if(!descriptor||!descriptor.get||!descriptor.set||descriptor.configurable===false)return;Object.defineProperty(prototype,name,{configurable:descriptor.configurable,enumerable:descriptor.enumerable,get:descriptor.get,set:function(value){descriptor.set.call(this,rewrite(value));}});};
patchUrlProperty(window.HTMLScriptElement&&HTMLScriptElement.prototype,'src',rewriteHttp);
patchUrlProperty(window.HTMLLinkElement&&HTMLLinkElement.prototype,'href',rewriteHttp);
patchUrlProperty(window.HTMLBaseElement&&HTMLBaseElement.prototype,'href',rewriteHttp);
patchUrlProperty(window.HTMLIFrameElement&&HTMLIFrameElement.prototype,'src',rewriteHttp);
patchUrlProperty(window.HTMLImageElement&&HTMLImageElement.prototype,'src',rewriteHttp);
const nativeSetAttribute=Element.prototype.setAttribute;Element.prototype.setAttribute=function(name,value){const attribute=String(name).toLowerCase();if(['src','href','action','poster','manifest','data-src','data-href'].includes(attribute))value=rewriteHttp(value);return nativeSetAttribute.call(this,name,value);};
const nativeWindowOpen=window.open.bind(window);window.open=function(url){if(arguments.length)arguments[0]=rewriteHttp(url);return nativeWindowOpen.apply(window,arguments);};
document.addEventListener('click',function(event){const link=event.target instanceof Element?event.target.closest('a[href]'):null;if(link)link.href=rewriteHttp(link.href);},true);
document.addEventListener('submit',function(event){const form=event.target;if(form instanceof HTMLFormElement)form.action=rewriteHttp(form.action);},true);
})();</script>`;
  }

  private insertIntoHead(html: string, value: string): string {
    if (/<head\b[^>]*>/i.test(html)) {
      return html.replace(/<head\b[^>]*>/i, (head) => `${head}${value}`);
    }

    return `${value}${html}`;
  }

  private isTextContent(contentType: string): boolean {
    return /^(?:text\/|application\/(?:javascript|json|manifest\+json|xhtml\+xml|xml)|image\/svg\+xml)/i.test(
      contentType,
    );
  }

  private headerValue(
    value: string | string[] | undefined,
  ): string {
    return Array.isArray(value) ? value.join(', ') : String(value ?? '');
  }

  private headerName(name: string): string {
    return name
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('-');
  }

  private escapeSlashes(value: string): string {
    return value.replaceAll('/', '\\/');
  }
}
