// Shared by the React SPA and rewritten AMPP documents. Send no input contents
// or client timestamps; the authenticated API records its own time.
export function startSessionActivityTracking(
  reportFetch = window.fetch.bind(window),
) {
  const interval = 30000;
  const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
  let stopped = false;
  let pending = false;
  let lastSent = -Infinity;
  let timer;
  let request;

  function schedule() {
    if (stopped || !pending || request || timer !== undefined) return;
    const delay = Math.max(0, interval - (Date.now() - lastSent));
    if (delay) timer = window.setTimeout(send, delay);
    else void send();
  }

  async function send() {
    timer = undefined;
    if (stopped || !pending || document.hidden) {
      pending = false;
      return;
    }
    pending = false;
    lastSent = Date.now();
    const controller = new AbortController();
    request = controller;
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await reportFetch('/api/auth/activity', {
        method: 'POST',
        credentials: 'include',
        signal: controller.signal,
      });
      if (response.status === 401) stop();
    } catch {
      // Retry on a later interaction. An idle timer must not manufacture new
      // activity after an outage or keep an abandoned session alive.
    } finally {
      window.clearTimeout(timeout);
      if (request === controller) request = undefined;
      schedule();
    }
  }

  function onActivity(event) {
    if (!event.isTrusted || document.hidden || stopped) return;
    pending = true;
    schedule();
  }

  function discardPending() {
    pending = false;
    window.clearTimeout(timer);
    timer = undefined;
    request?.abort();
  }

  function onVisibility() {
    if (document.hidden) discardPending();
  }

  function stop() {
    stopped = true;
    discardPending();
    for (const name of events)
      document.removeEventListener(name, onActivity, true);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', discardPending);
  }

  for (const name of events)
    document.addEventListener(name, onActivity, {
      capture: true,
      passive: true,
    });
  document.addEventListener('visibilitychange', onVisibility);
  // Retain listeners for back/forward-cache restores, but discard old activity.
  window.addEventListener('pagehide', discardPending);
  return stop;
}
