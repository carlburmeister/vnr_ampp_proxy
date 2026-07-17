import type { AllowedWorkload } from '../../services/amppSessionApi';
import type { WorkloadLaunchTarget } from '../../utils/workloadApplicationHandlers';
import { MINI_MIXER_CONTROL_PATH } from './minMixerConstants';

export function getMiniMixerLaunchTarget(workload: AllowedWorkload): WorkloadLaunchTarget {
  const params = new URLSearchParams({
    workloadId: workload.id,
    applicationName: workload.applicationName ?? '',
    title: workload.name,
  });

  return {
    url: `${MINI_MIXER_CONTROL_PATH}?${params.toString()}`,
    title: workload.name,
  };
}
