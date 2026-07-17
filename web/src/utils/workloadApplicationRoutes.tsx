import type { ReactNode } from 'react';

import { FlowMonitorWebRtcViewerPage } from '../features/flowMonitor/FlowMonitorWebRtcViewerPage';
import { FLOW_MONITOR_WEBRTC_VIEWER_PATH } from '../features/flowMonitor/flowMonitorConstants';
import { MiniMixerControlPage } from '../features/miniMixer/minMixerControlPage';
import { MINI_MIXER_CONTROL_PATH } from '../features/miniMixer/minMixerConstants';

type WorkloadApplicationRoute = {
  path: string;
  render: () => ReactNode;
};

const workloadApplicationRoutes: WorkloadApplicationRoute[] = [
  {
    path: FLOW_MONITOR_WEBRTC_VIEWER_PATH,
    render: () => <FlowMonitorWebRtcViewerPage />,
  },
  {
    path: MINI_MIXER_CONTROL_PATH,
    render: () => <MiniMixerControlPage />,
  },
];

export function renderWorkloadApplicationRoute(pathname: string) {
  return workloadApplicationRoutes.find((route) => route.path === pathname)?.render() ?? null;
}
