import { useEffect, useState } from 'react';

type Phase1Layout = { id: string; name: string; workloadId: string };

export function GvuiPhase1Button() {
  const [layout, setLayout] = useState<Phase1Layout | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/ampp-proxy/gvui-phase1', {
      credentials: 'include', signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error('GV.UI development access check failed');
      const result = await response.json() as { layout: Phase1Layout | null };
      if (!controller.signal.aborted) setLayout(result.layout);
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) console.warn('[AMVVPP] GV.UI test', err);
    });
    return () => controller.abort();
  }, []);

  if (!layout) return null;

  function openLayout() {
    setError('');
    const path = `/api/ampp-proxy/ui/${encodeURIComponent(layout!.workloadId)}` +
      `/gvui/desktop/${encodeURIComponent(layout!.id)}`;
    if (!window.open(path, '_blank')) {
      setError('Unable to open a new browser tab. Please allow popups for this site.');
    }
  }

  return <>
    <button className="workload-button" type="button" onClick={openLayout}>
      {layout.name}
    </button>
    {error && <p className="workload-action-error">{error}</p>}
  </>;
}
