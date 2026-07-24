import {
  MINI_MIXER_APPLICATION_NAME,
  MINI_MIXER_AMPP_UI_APPLICATION_NAME,
} from '../features/miniMixer/minMixerConstants';
import type { AllowedWorkload } from '../services/amppSessionApi';
import type { WorkloadLaunchTarget } from './workloadApplicationHandlers';

const amppUiApplications: Record<string, string> = {
  [MINI_MIXER_APPLICATION_NAME]: MINI_MIXER_AMPP_UI_APPLICATION_NAME,
};

export function getAmppUiLaunchTarget(
  workload: AllowedWorkload,
): WorkloadLaunchTarget {
  const wrapperApplicationName = workload.applicationName
    ? amppUiApplications[workload.applicationName]
    : undefined;

  if (!wrapperApplicationName) {
    throw new Error(
      `No standard AMPP UI is configured for ${
        workload.applicationName ?? workload.name
      }.`,
    );
  }

  const upstreamPath =
    `/app/wrapper/single/${wrapperApplicationName}/` +
    encodeURIComponent(workload.id);

  return {
    url:
      `/api/ampp-proxy/ui/${encodeURIComponent(workload.id)}` +
      upstreamPath,
    title: workload.name,
  };
}
