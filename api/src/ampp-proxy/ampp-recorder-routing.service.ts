import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  RequestTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SessionData } from 'express-session';
import { setTimeout as delay } from 'node:timers/promises';

import type { AmppCookieHttpResponse } from './ampp-cookie-http.service';
import { AmppMatrixFilterService } from './ampp-matrix-filter.service';

export type RecorderRequestOptions = { signal: AbortSignal; timeout: number };
export type RecorderOperationContext = {
  signal?: AbortSignal;
  assertActive?: () => Promise<void>;
};
export type RecorderRequest = (
  method: string,
  path: string,
  body?: Buffer,
  options?: RecorderRequestOptions,
) => Promise<AmppCookieHttpResponse>;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MATRIX = '/cluster/matrix/api/v1';
const ROUTING = `${MATRIX}/routing`;
const MAX_ACTIVE = 128;
const CLEANUP_TIMEOUT_MS = 5000;

type ObjectValue = Record<string, unknown>;
class RecorderLockRestoreException extends BadGatewayException {
  constructor() {
    super(
      'Recorder input lock could not be restored; check the AMPP destination',
    );
  }
}
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);
const sameId = (left: unknown, right: string): boolean =>
  typeof left === 'string' && left.toLowerCase() === right.toLowerCase();

/** Correct only the input of the engine bound to an authorized Recorder app. */
@Injectable()
export class AmppRecorderRoutingService {
  private readonly logger = new Logger(AmppRecorderRoutingService.name);
  private readonly active = new Set<string>();
  private readonly routeTimeout: number;
  private readonly operationTimeout: number;

  constructor(
    private readonly matrix: AmppMatrixFilterService,
    config: ConfigService,
  ) {
    this.routeTimeout = Number(
      config.get('AMPP_RECORDER_ROUTE_TIMEOUT_MS') ?? 10000,
    );
    this.operationTimeout = Number(
      config.get('AMPP_RECORDER_OPERATION_TIMEOUT_MS') ?? 60000,
    );
    if (
      !Number.isSafeInteger(this.routeTimeout) ||
      this.routeTimeout < 1 ||
      !Number.isSafeInteger(this.operationTimeout) ||
      this.operationTimeout < this.routeTimeout ||
      this.operationTimeout > 120000
    )
      throw new Error('Invalid AMPP Recorder routing/operation timeout');
  }

  async run(
    session: SessionData,
    method: string,
    path: string,
    body: Buffer | undefined,
    request: RecorderRequest,
    context: RecorderOperationContext = {},
  ): Promise<AmppCookieHttpResponse> {
    const target = new URL(path, 'http://ampp-proxy.local');
    const match = decodeURIComponent(target.pathname).match(
      /^\/mocha\/application\/([0-9a-f-]{36})\/api\/v1\/app\/(recordingsettings|preparerecording|startrecording)\/?$/i,
    );
    const workload = (session.allowedWorkloads ?? [])
      .flatMap((entry) => [entry, ...(entry.child_workloads ?? [])])
      .find((entry) => entry.id.toLowerCase() === match?.[1].toLowerCase());
    const action = match?.[2].toLowerCase();
    if (workload?.packageName !== 'GV.AMPP.Apps.Recorder')
      return request(method, path, body);
    if (
      target.search ||
      !(
        (method === 'POST' && action !== 'startrecording') ||
        (method === 'GET' &&
          (action === 'startrecording' || action === 'recordingsettings'))
      )
    ) {
      throw new ForbiddenException(
        'Recorder control method or query is not allowed',
      );
    }
    if (method === 'GET' && action === 'recordingsettings')
      return request(method, path, body);

    if (!uuid(workload.id) || !uuid(workload.fabricId)) {
      throw new ForbiddenException('Recorder workload/fabric is unavailable');
    }
    const key = `workload:${workload.id.toLowerCase()}`;
    if (this.active.has(key))
      throw new ConflictException('Recorder operation is already in progress');
    if (this.active.size >= MAX_ACTIVE * 2)
      throw new ServiceUnavailableException('Too many recorder operations');
    this.active.add(key);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.operationTimeout);
    const signal = context.signal
      ? AbortSignal.any([controller.signal, context.signal])
      : controller.signal;
    let engineKey: string | undefined;
    const check = async () => {
      signal.throwIfAborted();
      if (context.assertActive)
        await this.abortable(context.assertActive(), signal);
      signal.throwIfAborted();
    };
    const execute: RecorderRequest = async (m, p, data, options) => {
      await check();
      const requestSignal = options?.signal
        ? AbortSignal.any([signal, options.signal])
        : signal;
      requestSignal.throwIfAborted();
      const result = await this.abortable(
        request(m, p, data, {
          signal: requestSignal,
          timeout: options?.timeout ?? this.operationTimeout,
        }),
        requestSignal,
      );
      requestSignal.throwIfAborted();
      return result;
    };
    const app = `/mocha/application/${workload.id}/api/v1/app`;
    const read = async (p: string) => this.read(await execute('GET', p));
    try {
      const settings = await read(`${app}/recordingsettings`);
      const recorderId = settings.recorderId;
      if (!uuid(recorderId))
        throw new BadGatewayException(
          'AMPP returned an invalid recorder binding',
        );
      engineKey = `engine:${recorderId.toLowerCase()}`;
      if (this.active.has(engineKey)) {
        engineKey = undefined;
        throw new ConflictException(
          'Recorder operation is already in progress',
        );
      }
      this.active.add(engineKey);
      const idleInfo = async () => {
        const info = await read(`${app}/recorderinfo`);
        if (
          typeof info.state !== 'string' ||
          !['ready', 'prepared'].includes(info.state)
        ) {
          throw new ConflictException(
            'Recorder must be idle before changing or verifying its input',
          );
        }
        return info;
      };
      await idleInfo();

      let source = settings.source;
      if (action === 'recordingsettings') {
        let submitted: ObjectValue | undefined;
        try {
          submitted = object(JSON.parse(body?.toString('utf8') ?? ''));
        } catch {
          /* Reject malformed requests below. */
        }
        if (!submitted)
          throw new BadRequestException('Invalid recording settings');
        if (
          submitted.recorderId !== undefined &&
          (typeof submitted.recorderId !== 'string' ||
            submitted.recorderId.toLowerCase() !== recorderId.toLowerCase())
        ) {
          throw new ForbiddenException(
            'Recording settings cannot retarget the recorder engine',
          );
        }
        if (
          'source' in submitted &&
          (submitted.source === '' || submitted.source === null)
        ) {
          return execute(method, path, body);
        }
        source = submitted.source ?? source;
      }
      const producerPath = `${MATRIX}/producers?fabricId=${workload.fabricId}&type=Fabric`;
      const producerResponse = await execute('GET', producerPath);
      const visible = this.read(
        this.matrix.filterApiResponse(
          session,
          workload.id,
          producerPath,
          producerResponse,
        ),
      );
      const producers = Array.isArray(visible.producers)
        ? visible.producers
        : [];
      const selected = producers
        .map((row: unknown) => object(object(row)?.producer))
        .filter((p): p is ObjectValue & { id: string } =>
          Boolean(
            p &&
            p.name === source &&
            p.enabled !== false &&
            sameId(p.fabricId, workload.fabricId) &&
            uuid(p.id),
          ),
        );
      if (!selected.length)
        throw new ForbiddenException(
          'Selected recorder source is not permitted or available',
        );
      if (selected.length !== 1)
        throw new ConflictException('Recorder source name is ambiguous');
      const producerId = selected[0].id;

      // Settings can be saved without changing routing. Never derive ownership
      // from a browser-supplied recorder/destination ID or an echoed POST response.
      if (action === 'recordingsettings') return execute(method, path, body);

      const verifySettings = async () => {
        const current = await read(`${app}/recordingsettings`);
        if (
          !sameId(current.recorderId, recorderId) ||
          current.source !== source
        ) {
          throw new ConflictException(
            'Recorder binding or selected source changed; prepare again',
          );
        }
      };

      const consumerData = await read(
        `${MATRIX}/consumers?fabricId=${workload.fabricId}&type=Fabric`,
      );
      const consumers = Array.isArray(consumerData.consumers)
        ? consumerData.consumers
        : [];
      const inputs = consumers
        .map((row: unknown) => object(object(row)?.consumer))
        .filter((c): c is ObjectValue & { id: string } =>
          Boolean(
            c &&
            typeof c.workloadId === 'string' &&
            c.workloadId.toLowerCase() === recorderId.toLowerCase() &&
            sameId(c.fabricId, workload.fabricId) &&
            c.enabled !== false &&
            uuid(c.id),
          ),
        );
      if (inputs.length !== 1)
        throw new ConflictException(
          'Cannot uniquely identify the recorder input',
        );
      const destinationId = inputs[0].id;
      const destinationPath = `${ROUTING}/destination/${destinationId}`;
      const destination = async (send: RecorderRequest = execute) => {
        const data = this.read(await send('GET', destinationPath));
        const value = object(data.destination) ?? data;
        if (
          !sameId(value.id, destinationId) ||
          !sameId(value.fabricId, workload.fabricId) ||
          typeof value.locked !== 'boolean'
        ) {
          throw new BadGatewayException(
            'AMPP returned an invalid recorder destination',
          );
        }
        return value;
      };
      const verify = async (send: RecorderRequest = execute) => {
        if (!sameId((await destination(send)).sourceId, producerId)) {
          throw new ConflictException(
            'Recorder input differs from the selected source; prepare again',
          );
        }
      };
      const initial = await destination();
      if (action === 'startrecording') {
        if ((await idleInfo()).state !== 'prepared')
          throw new ConflictException('Recorder must be prepared before Start');
        await verifySettings();
        await verify();
        return execute(method, path, body);
      }

      if (!sameId(initial.sourceId, producerId)) {
        let restoreLock = false;
        const routeSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(this.routeTimeout),
        ]);
        const routeRequest: RecorderRequest = (m, p, data) =>
          execute(m, p, data, {
            signal: routeSignal,
            timeout: this.routeTimeout,
          });
        try {
          await idleInfo();
          if (initial.locked) {
            // Restore even if unlock times out after AMPP actually accepted it.
            restoreLock = true;
            this.success(
              await routeRequest('POST', `${destinationPath}/unlock`),
            );
          }
          const requested = this.read(
            await routeRequest(
              'POST',
              `${ROUTING}/requestroute`,
              Buffer.from(
                JSON.stringify({ sourceId: producerId, destinationId }),
              ),
            ),
          );
          if (!uuid(requested.requestId))
            throw new BadGatewayException(
              'AMPP returned an invalid route request ID',
            );
          const deadline = Date.now() + this.routeTimeout;
          for (;;) {
            const status = this.read(
              await routeRequest(
                'GET',
                `${ROUTING}/routestatus/${requested.requestId}`,
              ),
            );
            if (typeof status.routeStatus !== 'string') {
              throw new BadGatewayException(
                'AMPP returned an invalid route status',
              );
            }
            const routeStatus = status.routeStatus.trim();
            if (
              status.routeErrorMessage ||
              /^(failed|error|cancelled|canceled|rejected)$/i.test(routeStatus)
            ) {
              throw new ConflictException(
                'AMPP could not establish the selected recorder input',
              );
            }
            if (
              /^(complete|completed|success|succeeded|successful|routed)$/i.test(
                routeStatus,
              )
            ) {
              await verify(routeRequest);
              break;
            }
            if (Date.now() >= deadline)
              throw new GatewayTimeoutException(
                'AMPP recorder route did not complete',
              );
            await delay(
              Math.min(50, Math.max(1, deadline - Date.now())),
              undefined,
              { signal: routeSignal },
            );
          }
        } catch (error) {
          if (routeSignal.aborted && !signal.aborted) {
            throw new GatewayTimeoutException(
              'AMPP recorder route did not complete',
            );
          }
          throw error;
        } finally {
          if (restoreLock) {
            // Attempt restoration after disconnect/revocation; report failures.
            // Cleanup is limited to relocking the input this operation unlocked.
            await this.restoreLock(destinationId, request);
          }
        }
      }
      const restored = await destination();
      if (restored.locked !== initial.locked)
        throw new BadGatewayException(
          'Recorder destination lock was not restored',
        );
      await verify();
      await idleInfo();
      await verifySettings();
      const result = await execute(method, path, body);
      if (
        result.status >= 200 &&
        result.status < 300 &&
        this.json(result)?.state === 5
      ) {
        await verifySettings();
        await verify();
      }
      return result;
    } catch (error) {
      if (signal.aborted && !(error instanceof RecorderLockRestoreException)) {
        if (context.signal?.aborted)
          throw new RequestTimeoutException('Recorder operation was cancelled');
        throw new GatewayTimeoutException('AMPP recorder operation timed out');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (engineKey) this.active.delete(engineKey);
      this.active.delete(key);
    }
  }

  private json(response: AmppCookieHttpResponse): ObjectValue | undefined {
    try {
      return object(JSON.parse(response.body.toString('utf8')));
    } catch {
      return undefined;
    }
  }

  private async restoreLock(
    destinationId: string,
    request: RecorderRequest,
  ): Promise<void> {
    const signal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
    try {
      this.success(
        await this.abortable(
          request(
            'POST',
            `${ROUTING}/destination/${destinationId}/lock`,
            undefined,
            { signal, timeout: CLEANUP_TIMEOUT_MS },
          ),
          signal,
        ),
      );
    } catch {
      this.logger.error(
        `Unable to restore recorder destination lock: ${destinationId}`,
      );
      throw new RecorderLockRestoreException();
    }
  }

  private abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener('abort', abort);
        reject(signal.reason as Error);
      };
      signal.addEventListener('abort', abort, { once: true });
      void operation
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }

  private success(response: AmppCookieHttpResponse): void {
    if (response.status < 200 || response.status >= 300) {
      throw new BadGatewayException(
        `AMPP recorder routing request failed (${response.status})`,
      );
    }
  }

  private read(response: AmppCookieHttpResponse): ObjectValue {
    this.success(response);
    const value = this.json(response);
    if (!value)
      throw new BadGatewayException(
        'AMPP recorder response is not a JSON object',
      );
    return value;
  }
}
