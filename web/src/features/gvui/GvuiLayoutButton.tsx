import { useEffect, useRef, useState } from 'react';
import type { AllowedGvuiLayout } from '../../services/amppSessionApi';
import { getGvuiLaunchUrl } from './gvuiLaunch';

export function GvuiLayoutButton({ layout, width }: { layout: AllowedGvuiLayout; width: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ controller: AbortController; tab: Window } | null>(null);
  useEffect(() => () => { pending.current?.controller.abort(); pending.current?.tab.close(); }, []);

  async function open() {
    const tab = window.open('about:blank', '_blank');
    if (!tab) { setError('Unable to open a new browser tab. Please allow popups for this site.'); return; }
    tab.opener = null;
    const controller = new AbortController();
    pending.current = { controller, tab }; setError(''); setLoading(true);
    try {
      const url = await getGvuiLaunchUrl(layout.id, controller.signal);
      if (!controller.signal.aborted) { tab.location.replace(url); pending.current = null; }
    } catch (err) {
      tab.close();
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Unable to open the layout.');
    } finally {
      if (!controller.signal.aborted) { pending.current = null; setLoading(false); }
    }
  }

  return <div className="gvui-layout">
    <button type="button" className="workload-button" style={{ width }} data-gvui-layout-id={layout.id}
      disabled={loading} onClick={() => { void open(); }}>{loading ? 'Loading...' : layout.name}</button>
    {error && <p className="workload-action-error" role="alert">{error}</p>}
  </div>;
}
