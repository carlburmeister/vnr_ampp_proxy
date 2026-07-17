import {
  listChildWorkloads,
  type AmppChildWorkload,
} from '../../services/amppControlApi';
import type { AllowedWorkload } from '../../services/amppSessionApi';
import type { WorkloadLaunchTarget } from '../../utils/workloadApplicationHandlers';
import {
  FLOW_MONITOR_OUTPUT_ENGINE_PACKAGE_NAME,
  FLOW_MONITOR_WEBRTC_VIEWER_PATH,
} from './flowMonitorConstants';

export async function getFlowMonitorLaunchTarget(
  workload: AllowedWorkload,
): Promise<WorkloadLaunchTarget> {
  console.log('[VNR WebRTC] requesting Flow Monitor child workloads', {
    parentWorkloadId: workload.id,
  });

  const response = await listChildWorkloads(workload.id);
  const childWorkloads = response.workloads.map((item) => item.workload);

  console.log('[VNR WebRTC] Flow Monitor child workloads received', {
    parentWorkloadId: workload.id,
    childWorkloadCount: childWorkloads.length,
    childWorkloads: childWorkloads.map((childWorkload) => ({
      id: childWorkload.id,
      name: childWorkload.name,
      packageName: childWorkload.packageName,
      state: childWorkload.state?.state,
    })),
  });

  const outputEngineWorkload = findFlowMonitorOutputEngine(childWorkloads);

  if (!outputEngineWorkload) {
    console.error('[VNR WebRTC] no Flow Monitor output engine child workload found', {
      parentWorkloadId: workload.id,
      expectedPackageName: FLOW_MONITOR_OUTPUT_ENGINE_PACKAGE_NAME,
    });
    throw new Error('No Flow Monitor WebRTC output engine child workload found.');
  }

  console.log('[VNR WebRTC] Flow Monitor output engine selected', {
    parentWorkloadId: workload.id,
    engineInstanceId: outputEngineWorkload.id,
    engineName: outputEngineWorkload.name,
    packageName: outputEngineWorkload.packageName,
  });

  const params = new URLSearchParams({
    workloadId: workload.id,
    engineInstanceId: outputEngineWorkload.id,
    title: outputEngineWorkload.name,
  });

  return {
    url: `${FLOW_MONITOR_WEBRTC_VIEWER_PATH}?${params.toString()}`,
    title: outputEngineWorkload.name,
  };
}

/*-------------------------------------------------------------*/
//  findFlowMonitorOutputEngine()
/*-------------------------------------------------------------*/
function findFlowMonitorOutputEngine(workloads: AmppChildWorkload[]) {
  return workloads.find((workload) => (
    workload.packageName === FLOW_MONITOR_OUTPUT_ENGINE_PACKAGE_NAME ||
    workload.name.toLowerCase().includes('output engine')
  ));
}
