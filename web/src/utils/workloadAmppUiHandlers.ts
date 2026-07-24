import type { AllowedWorkload } from '../services/amppSessionApi';
import type { WorkloadLaunchTarget } from './workloadApplicationHandlers';

export function getAmppUiLaunchTarget(
  workload: AllowedWorkload,
): WorkloadLaunchTarget {
  if (!workload.packageName) {
    throw new Error(
      `No AMPP UI package is available for ${
        workload.applicationName ?? workload.name
      }.`,
    );
  }

  const upstreamPath =
    `/app/wrapper/single/${encodeURIComponent(workload.packageName)}/` +
    encodeURIComponent(workload.id);

  return {
    url:
      `/api/ampp-proxy/ui/${encodeURIComponent(workload.id)}` +
      upstreamPath,
    title: workload.name,
  };
}
