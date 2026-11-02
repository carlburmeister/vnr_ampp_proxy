import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { GvuiPollRetry } from './gvui-poll-retry';

const CONTEXT = 'gvui-11111111-1111-4111-8111-111111111111';
const PATH =
  '/notifications/api/v1/notifications/mailbox?count=100&timeout=10000';
const response = () =>
  Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
  }) as unknown as Response;

describe('GVUI failed poll response pacing', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('backs off repeated failures with a finite cap and permits recovery after more than six errors', async () => {
    const retry = new GvuiPollRetry();
    const res = response();
    for (const delay of [1000, 2000, 4000, 5000, 5000, 5000, 5000]) {
      let complete = false;
      const wait = retry
        .complete('sid', CONTEXT, 'GET', PATH, 503, res)
        .then(() => {
          complete = true;
        });
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(complete).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await wait;
    }
    await retry.complete('sid', CONTEXT, 'GET', PATH, 200, res);
    expect(jest.getTimerCount()).toBe(0);
    const next = retry.complete('sid', CONTEXT, 'GET', PATH, 403, res);
    await jest.advanceTimersByTimeAsync(1000);
    await next;
    expect(res.listenerCount('close')).toBe(0);
  });

  it('passes 401/404/410 immediately and resets the same alias on recreation', async () => {
    const retry = new GvuiPollRetry();
    const res = response();
    const first = retry.complete('sid', CONTEXT, 'GET', PATH, 403, res);
    await jest.advanceTimersByTimeAsync(1000);
    await first;
    for (const status of [401, 404, 410, 204]) {
      await retry.complete('sid', CONTEXT, 'GET', PATH, status, res);
      expect(jest.getTimerCount()).toBe(0);
    }
    retry.reset('sid', CONTEXT, 'mailbox');
    const second = retry.complete('sid', CONTEXT, 'GET', PATH, 503, res);
    await jest.advanceTimersByTimeAsync(1000);
    await second;
  });

  it('isolates sessions and aliases while sharing query variants for one alias', async () => {
    const retry = new GvuiPollRetry();
    const first = retry.complete('one', CONTEXT, 'GET', PATH, 403, response());
    await jest.advanceTimersByTimeAsync(1000);
    await first;
    const waits = [
      retry.complete(
        'one',
        CONTEXT,
        'GET',
        PATH.replace('count=100', 'count=1000'),
        403,
        response(),
      ),
      retry.complete('two', CONTEXT, 'GET', PATH, 403, response()),
      retry.complete(
        'one',
        CONTEXT,
        'GET',
        PATH.replace('/mailbox?', '/another?'),
        403,
        response(),
      ),
    ];
    await jest.advanceTimersByTimeAsync(1000);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(1000);
    await Promise.all(waits);
  });

  it('cancels delayed failures promptly on socket close without retaining timers/listeners', async () => {
    const retry = new GvuiPollRetry();
    const res = response();
    const wait = retry.complete('sid', CONTEXT, 'GET', PATH, 502, res);
    expect(jest.getTimerCount()).toBe(1);
    res.emit('close');
    await wait;
    expect(jest.getTimerCount()).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  });

  it('does not interfere with other workloads, methods, API paths or malformed aliases', async () => {
    const retry = new GvuiPollRetry();
    for (const [context, method, path] of [
      ['workload', 'GET', PATH],
      [CONTEXT, 'POST', PATH],
      [
        CONTEXT,
        'GET',
        '/configuration/api/v1/configuration/gv/system/configuration',
      ],
      [CONTEXT, 'GET', '/notifications/api/v1/notifications/%E0%A4'],
    ])
      await retry.complete('sid', context, method, path, 403, response());
    expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds retry-state memory and expires abandoned state', async () => {
    const retry = new GvuiPollRetry();
    const closed = response();
    Object.assign(closed, { destroyed: true });
    for (let i = 0; i < 4200; i++)
      await retry.complete(
        'sid',
        CONTEXT,
        'GET',
        PATH.replace('/mailbox?', `/mailbox-${i}?`),
        403,
        closed,
      );
    const state = retry as unknown as { failures: Map<string, unknown> };
    expect(state.failures.size).toBe(4096);
    await jest.advanceTimersByTimeAsync(600001);
    await retry.complete('sid', CONTEXT, 'GET', PATH, 403, closed);
    expect(state.failures.size).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
