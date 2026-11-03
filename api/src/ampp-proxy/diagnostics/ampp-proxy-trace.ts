// TEMP AMPP trace: remove this module and its marked hooks after diagnosis.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { RequestHandler } from 'express';
import type { Store } from 'express-session';

type TraceRequest = IncomingMessage & {
  originalUrl?: string;
  sessionID?: string;
};
type Details = {
  status?: number;
  durationMs?: number;
  upstreamMethod?: string;
  upstreamPath?: string;
  operation?: string;
  errorCode?: string;
  errorType?: string;
  delayMs?: number;
  premature?: boolean;
  side?: string;
  initiator?: string;
  code?: number;
  reason?: string;
  reasonId?: string;
  reasonBytes?: number;
  aliasId?: string;
  upstreamId?: string;
  topicId?: string;
};
type Context = {
  id: string;
  startedAt: number;
  request: TraceRequest;
  sessionId?: string;
  initiator?: string;
};

const active = new AsyncLocalStorage<Context>();
const requests = new WeakMap<TraceRequest, Context>();
const enabled = () => process.env.AMPP_PROXY_TRACE === 'true';
const elapsed = (start: number) =>
  Math.round((performance.now() - start) * 100) / 100;
const fingerprint = (value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);
const uuid = /^(?:gvui-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const segments = new Set(
  (
    'api ampp-proxy ui ws gvui launch access desktop callback dist images ' +
    'notifications v1 v2 mailbox subscribe unsubscribe pushnotificationshub cluster store state ' +
    'matrix control fabric snapshot ampp identity connect authorize configuration configurations ' +
    'discovery services logging events mocha application app wrapper embedded single refresh refresh.html ' +
    'settingscache messagescache account-notification users user login local'
  ).split(' '),
);

export function tracePath(value: string): string {
  try {
    const parts = new URL(value, 'http://trace.invalid').pathname.split('/');
    const mailbox = parts.findIndex(
      (part, i) =>
        ['mailbox', 'notifications'].includes(part) &&
        parts[i - 1] === 'v1' &&
        parts[i - 2] === 'api' &&
        parts[i - 3] === 'notifications',
    );
    return parts
      .map((part, i) => {
        if (mailbox >= 0 && i === mailbox + 1 && part)
          return '@' + fingerprint(part);
        if (mailbox >= 0 && i > mailbox + 1) {
          if (i === mailbox + 2 && ['subscribe', 'unsubscribe'].includes(part))
            return part;
          return part ? ':redacted' : '';
        }
        return !part || segments.has(part) || uuid.test(part)
          ? part
          : ':segment';
      })
      .join('/');
  } catch {
    return ':invalid-path';
  }
}

function errorDetails(error: unknown): Details {
  try {
    const value = error as {
      code?: unknown;
      name?: unknown;
      getStatus?: () => number;
    } | null;
    const safe = (item: unknown) =>
      typeof item === 'string' && /^[\w.-]{1,64}$/.test(item)
        ? item
        : undefined;
    const status =
      typeof value?.getStatus === 'function' ? value.getStatus() : undefined;
    return {
      errorCode: safe(value?.code),
      errorType: safe(value?.name),
      status: typeof status === 'number' ? status : undefined,
    };
  } catch {
    return {};
  }
}

function emit(
  context: Context | undefined,
  event: string,
  details: Details = {},
): void {
  if (!context || !enabled()) return;
  try {
    const request = context.request;
    const path = tracePath(request.originalUrl ?? request.url ?? '/');
    const contextId = path.match(
      /^\/api\/ampp-proxy\/(?:api|ui|ws)\/([^/]+)/,
    )?.[1];
    const sid = request.sessionID ?? context.sessionId;
    console.info(
      '[AMPP proxy trace] ' +
        JSON.stringify({
          time: new Date().toISOString(),
          pid: process.pid,
          traceId: context.id,
          elapsedMs: elapsed(context.startedAt),
          method: request.method,
          path,
          contextId,
          sessionId: sid ? fingerprint(sid) : undefined,
          event,
          ...details,
        }),
    );
  } catch {
    // Logging must never change request processing, including if the sink fails.
  }
}

export function traceEvent(event: string, details?: Details): void {
  emit(active.getStore(), event, details);
}

export function traceForRequest(
  request: TraceRequest,
  event: string,
  details?: Details,
): void {
  emit(requests.get(request), event, details);
}

export function tracePhase<T>(
  event: string,
  action: () => T,
  details?: Details,
): T {
  const context = active.getStore();
  if (!context || !enabled()) return action();
  const startedAt = performance.now();
  emit(context, event + '.start', details);
  const complete = (value: unknown) => {
    try {
      const status =
        value && typeof value === 'object'
          ? (Object.getOwnPropertyDescriptor(value, 'status')?.value as unknown)
          : undefined;
      emit(context, event + '.end', {
        ...details,
        durationMs: elapsed(startedAt),
        status: typeof status === 'number' ? status : details?.status,
      });
    } catch {
      // Application results remain untouched if observation is unavailable.
    }
  };
  const failed = (error: unknown) =>
    emit(context, event + '.error', {
      ...details,
      durationMs: elapsed(startedAt),
      ...errorDetails(error),
    });
  try {
    const result = action();
    if (result instanceof Promise)
      return (result as Promise<unknown>).then(
        (value) => {
          complete(value);
          return value;
        },
        (error) => {
          failed(error);
          throw error;
        },
      ) as T;
    complete(result);
    return result;
  } catch (error) {
    failed(error);
    throw error;
  }
}

function begin(request: TraceRequest): Context {
  const context = { id: randomUUID(), startedAt: performance.now(), request };
  requests.set(request, context);
  return context;
}

export const amppTraceMiddleware: RequestHandler = (
  request,
  response,
  next,
) => {
  if (
    !enabled() ||
    !/^\/api\/ampp-proxy(?:\/|$)/.test(request.originalUrl ?? request.url)
  )
    return next();
  const context = begin(request);
  response.setHeader('X-Ampp-Trace-Id', context.id);
  const aborted = () => emit(context, 'request.aborted');
  request.once('aborted', aborted);
  response.once('finish', () => {
    request.off('aborted', aborted);
    emit(context, 'response.finish', { status: response.statusCode });
  });
  response.once('close', () => {
    request.off('aborted', aborted);
    emit(context, 'response.close', {
      status: response.statusCode,
      premature: !response.writableFinished,
    });
  });
  active.run(context, () => {
    emit(context, 'request.received');
    next();
  });
};

export function traceUpgrade(request: TraceRequest, action: () => void): void {
  if (!enabled()) return action();
  const context = begin(request);
  active.run(context, () => {
    emit(context, 'websocket.upgrade.received');
    action();
  });
}

// Wrap callbacks only while tracing. Keep the underlying operation count,
// callback receiver/arguments, return value, and synchronous exceptions intact.
export function traceSessionStore(store: Store): void {
  if (!enabled()) return;
  for (const operation of ['get', 'set', 'touch'] as const) {
    const original = store[operation];
    if (!original) continue;
    const wrapped = function (
      this: Store,
      sid: string,
      ...args: unknown[]
    ): unknown {
      const context = active.getStore();
      if (!context || !enabled())
        return Reflect.apply(original, this, [sid, ...args]);
      context.sessionId = sid;
      const startedAt = performance.now();
      emit(context, `session.${operation}.start`);
      const callback = args.at(-1);
      if (typeof callback === 'function')
        args[args.length - 1] = function (
          this: unknown,
          ...values: unknown[]
        ): unknown {
          emit(context, `session.${operation}.${values[0] ? 'error' : 'end'}`, {
            durationMs: elapsed(startedAt),
            ...(values[0] ? errorDetails(values[0]) : {}),
          });
          return Reflect.apply(callback, this, values) as unknown;
        };
      try {
        return Reflect.apply(original, this, [sid, ...args]);
      } catch (error) {
        emit(context, `session.${operation}.error`, {
          durationMs: elapsed(startedAt),
          ...errorDetails(error),
        });
        throw error;
      }
    };
    Object.defineProperty(store, operation, {
      configurable: true,
      writable: true,
      value: wrapped,
    });
  }
}

export function traceMailbox(
  event: 'mailbox.request' | 'mailbox.response',
  method: string,
  path: string,
  upstreamPath: string,
  body?: Buffer,
  upstreamBody?: Buffer,
  status?: number,
): void {
  if (!active.getStore() || !enabled()) return;
  try {
    const extract = (value: string, input?: Buffer) => {
      const pathname = new URL(value, 'http://trace.invalid').pathname;
      const match = pathname.match(
        /^\/notifications\/api\/v1\/(notifications|mailbox)(?:\/([^/]+))?(?:\/(subscribe|unsubscribe)\/(.+))?/i,
      );
      if (!match) return;
      let id = match[2] ? decodeURIComponent(match[2]) : undefined;
      if (!id && method === 'POST' && match[1] === 'mailbox') {
        const data = JSON.parse(input?.toString() ?? '{}') as { id?: unknown };
        if (typeof data.id === 'string') id = data.id;
      }
      return {
        id,
        operation:
          match[3] ??
          (match[1] === 'notifications'
            ? 'poll'
            : method === 'POST'
              ? 'create'
              : method.toLowerCase()),
        topic: match[4],
      };
    };
    const alias = extract(path, body),
      upstream = extract(upstreamPath, upstreamBody ?? body);
    if (!alias?.id) return;
    traceEvent(event, {
      operation: alias.operation,
      aliasId: fingerprint(alias.id),
      upstreamId: upstream?.id ? fingerprint(upstream.id) : undefined,
      topicId: alias.topic ? fingerprint(alias.topic) : undefined,
      status,
    });
  } catch {
    // Invalid requests remain the policy/transport's responsibility.
  }
}

export function traceCloseReason(value: unknown): Details {
  try {
    const text = Buffer.isBuffer(value)
      ? value.toString()
      : typeof value === 'string'
        ? value
        : '';
    const known = [
      'Session expired',
      'Permission revoked',
      'Notification subscription is not permitted',
      'WebSocket message queue exceeded',
      'AMPP WebSocket rejected',
      'Setup failed',
      'Relay failed',
      'Transport error',
    ];
    return {
      reason: !text ? 'empty' : known.includes(text) ? text : 'other',
      reasonId: text ? fingerprint(text) : undefined,
      reasonBytes: Buffer.byteLength(text),
    };
  } catch {
    return { reason: 'unavailable' };
  }
}

export function traceSocketClose(
  request: TraceRequest,
  side: 'browser' | 'upstream' | 'proxy',
  code?: number,
  reason?: unknown,
): void {
  const context = requests.get(request);
  if (!context || !enabled()) return;
  context.initiator ??= side;
  emit(context, 'websocket.close', {
    side,
    initiator: context.initiator,
    code,
    ...traceCloseReason(reason),
  });
}
