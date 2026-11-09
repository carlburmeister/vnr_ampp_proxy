import { useEffect } from 'react';

export function useSessionActivity(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    // Public assets are also available to rewritten AMPP documents. Keep one
    // tracking implementation independent of the upstream AMPP application.
    const moduleUrl = '/session-activity.js';
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
