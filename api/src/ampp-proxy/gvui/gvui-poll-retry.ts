import type { Response } from 'express';

type Failure = { count: number; touchedAt: number };

// Per-controller/process state only: it is bounded, expires lazily, and is not
// authorization data. No timers or retry counters are stored in session JSON.
export class GvuiPollRetry {
  private readonly failures = new Map<string, Failure>();
  private sweptAt = 0;

  private key(sessionId: string, contextId: string, alias: string): string {
    return JSON.stringify([sessionId, contextId, alias]);
  }

  reset(sessionId: string, contextId: string, alias: string): void {
    this.failures.delete(this.key(sessionId, contextId, alias));
  }

  async complete(
    sessionId: string,
    contextId: string,
    method: string,
    path: string,
    status: number,
    response: Response,
  ): Promise<void> {
    if (!contextId.startsWith('gvui-') || method !== 'GET') return;
    const match = path
      .split('?')[0]
      .match(/^\/notifications\/api\/v1\/notifications\/([^/]+)\/?$/i);
    if (!match) return;
    let alias: string;
    try {
      alias = decodeURIComponent(match[1]);
    } catch {
      return;
    } // Preserve the policy's response to malformed paths.
    const key = this.key(sessionId, contextId, alias);
    // 404 is the SDK's same-ID recreation protocol; 401/410 and successful
    // responses also retain their immediate native behavior. Never suspend a
    // mailbox permanently, and never hold a successful notification response.
    if (status !== 403 && !(status >= 500 && status <= 599)) {
      this.failures.delete(key);
      return;
    }
    const now = Date.now();
    if (now - this.sweptAt >= 60000) {
      for (const [id, failure] of this.failures)
        if (now - failure.touchedAt >= 600000) this.failures.delete(id);
      this.sweptAt = now;
    }
    const count = Math.min((this.failures.get(key)?.count ?? 0) + 1, 4);
    this.failures.delete(key);
    if (this.failures.size >= 4096) {
      for (const oldest of this.failures.keys()) {
        this.failures.delete(oldest);
        break;
      }
    }
    this.failures.set(key, { count, touchedAt: now });
    const delay = Math.min(
      5000,
      Math.round(1000 * 2 ** (count - 1) * (0.8 + Math.random() * 0.4)),
    );
    if (response.destroyed || response.writableEnded) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        response.off('close', done);
        resolve();
      };
      const timer = setTimeout(done, delay);
      response.once('close', done);
    });
  }
}
