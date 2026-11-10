import { useEffect } from 'react';

export function useSessionActivity(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    // Public assets are also available to rewritten AMPP documents. Keep one
    // tracking implementation independent of the upstream AMPP application.
    // Use a same-origin absolute URL so Vite leaves this public asset request
    // unchanged instead of adding its source-module ?import query in dev.
    const moduleUrl = new URL('/session-activity.js', window.location.origin).href;
    void import(/* @vite-ignore */ moduleUrl)
      .then((activity) => {
        if (!cancelled) stop = activity.startSessionActivityTracking();
      })
      .catch(() =>
        console.warn('Session activity tracking could not be loaded'),
      );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [enabled]);
}
