import type { AllowedWorkload } from '../services/amppSessionApi';

export type WorkloadLaunchTarget = {
  url: string;
  title?: string;
};

export type WorkloadApplicationLaunchHandler = (
  workload: AllowedWorkload,
) => Promise<WorkloadLaunchTarget> | WorkloadLaunchTarget;

export async function resolveWorkloadApplicationLaunchTarget(
  workload: AllowedWorkload,
  handlers: Record<string, WorkloadApplicationLaunchHandler>,
): Promise<WorkloadLaunchTarget | null> {
  if (!workload.applicationName) {
    return null;
  }

  const handler = handlers[workload.applicationName];

  if (!handler) {
    return null;
  }

  return handler(workload);
}
