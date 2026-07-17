/* All fetch calls to Nest */

/*--------------------------------------------------------------------*/
//  Workload Notification Subscription
/*--------------------------------------------------------------------*/
export async function subscribeToWorkloadNotifications(workloadId: string) {
  const response = await fetch(
    `/api/ampp/control/workloads/${encodeURIComponent(
      workloadId,
    )}/notifications`,
    {
      method: 'POST',
      credentials: 'include',
    },
  );

  if (!response.ok) {
    throw new Error(`Subscribe failed: ${response.status}`);
  }

  return response.json();
}
/*--------------------------------------------------------------------------*/
//  ()
/*--------------------------------------------------------------------------*/
export async function getState(workloadId: string, reconKey = 'vnr_app') {
  const response = await fetch('/api/ampp/control/get-state', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ workloadId, reconKey }),
  });

  if (!response.ok) {
    throw new Error(`Get state failed: ${response.status}`);
  }

  return response.json();
}
/*--------------------------------------------------------------------------*/
//  ()
/*--------------------------------------------------------------------------*/
export async function sendProgramPreviewControlState(
  workloadId: string,
  applicationName: string,
  index: number,
  isProgram: boolean,
  isPreview: boolean
) {

  await getState(workloadId);

  const response = await fetch('/api/ampp/control/program-preview-control-state', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ workloadId, applicationName, index, isProgram, isPreview }),
  });

  if (!response.ok) {
    throw new Error(`Send program/preview controlstate failed: ${response.status}`);
  }

  return response.json();
}
/*--------------------------------------------------------------------------*/
//  ()
/*--------------------------------------------------------------------------*/
export async function sendKeyState(
  workloadId: string,
  applicationName: string,
  transitionType: string,
  active: boolean,
) {

  await getState(workloadId);

  const response = await fetch('/api/ampp/control/key-state', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ workloadId, applicationName, transitionType, active }),
  });

  if (!response.ok) {
    throw new Error(`Send keystate failed: ${response.status}`);
  }

  return response.json();
}
/*--------------------------------------------------------------------------*/
//  ()
/*--------------------------------------------------------------------------*/
export async function getApplicationConfig(workloadId: string) {
  const response = await fetch(
    `/api/ampp/control/workloads/${encodeURIComponent(workloadId)}/config`,
    { credentials: 'include' },
  );

  if (!response.ok) {
    throw new Error(`Get application config failed: ${response.status}`);
  }

  return response.json();
}
/*--------------------------------------------------------------------------*/
//  ()
/*--------------------------------------------------------------------------*/
export async function getApplicationState(workloadId: string) {
  const response = await fetch(
    `/api/ampp/control/workloads/${encodeURIComponent(workloadId)}/state`,
    { credentials: 'include' },
  );

  if (!response.ok) {
    throw new Error(`Get application state failed: ${response.status}`);
  }

  const body = await response.text();

  if (!body.trim()) {
    return null;
  }

  return JSON.parse(body);
}
/*--------------------------------------------------------------------------*/
//  ()
/*--------------------------------------------------------------------------*/
export async function listApplicationTypes(): Promise<string[]> {
  const response = await fetch('/api/ampp/control/application-types', {
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`List application types failed: ${response.status}`);
  }

  return response.json();
}
/*--------------------------------------------------------------------*/
//  Workload Notification Subscription

/*--------------------------------------------------------------------*/
//  TODO: Implement this function. Also need to add Nest api endpoints that call AMPP SDK functions and add a React button and handler.
export async function unsubscribeToWorkloadNotifications(_workloadId: string) { }

/*--------------------------------------------------------------------*/
//  listWorkloadsForApplicationType
/*--------------------------------------------------------------------*/
export async function listWorkloadsForApplicationType(
  applicationName: string,
): Promise<string[]> {
  const response = await fetch(
    `/api/ampp/control/application-types/${encodeURIComponent(applicationName,)}/workloads`,
    { credentials: 'include' },
  );

  if (!response.ok) {
    throw new Error(`List application workloads failed: ${response.status}`);
  }

  const json = await response.json();

  console.log('raw workloads response:', json);

  if (!Array.isArray(json)) {
    throw new Error('Expected workloads response to be an array');
  }

  return json;
}
/*--------------------------------------------------------------------*/
//  listWorkloadNamesForApplicationType
/*--------------------------------------------------------------------*/
export type AmppWorkload = {
  id: string;
  name: string;
  externalPackage: boolean;
  applicationType: string;
};
/*--------------------------------------------------------------------------*/
//  ()
/*--------------------------------------------------------------------------*/
export async function listWorkloadNamesForApplicationType(
  applicationName: string,
): Promise<AmppWorkload[]> {
  
  const response = await fetch(
    `/api/ampp/control/application-types/${encodeURIComponent(applicationName,)}/workload-names`,
    { credentials: 'include' },
  );

  if (!response.ok) {
    throw new Error(`List application workload names failed: ${response.status}`);
  }

  const json = await response.json();

  console.log('raw workload names response:', json);

  if (!Array.isArray(json)) {
    throw new Error('Expected workload names response to be an array');
  }

  return json;
}

/*--------------------------------------------------------------------*/
//  getWorkload
/*--------------------------------------------------------------------*/
// Don't need this here unless calling from React page...

/*--------------------------------------------------------------------*/
//  listChildWorkloads
/*--------------------------------------------------------------------*/
export type AmppChildWorkload = {
  id: string;
  name: string;
  alias?: string | null;
  applicationName?: string;
  packageName?: string;
  packageVersion?: string;
  packageVersionType?: string;
  packageSupportedOS?: string[];
  tags?: Record<string, unknown>;
  packagePlacementConstraints?: string[];
  packageDependencies?: unknown[];
  placementConstraints?: string[];
  billingProperties?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  desiredState?: Record<string, unknown>;
  states?: unknown[];
  state?: {
    nodeId?: string;
    nodeName?: string;
    state?: string;
    isWorkloadAssigned?: boolean;
    applicationVersion?: string;
    packageVersion?: string;
    errorReason?: string | null;
    errorReasonCode?: string | null;
    owner?: string | null;
    packageType?: string;
  };
  parentId?: string;
  parentProductCode?: string;
  fabricId?: string;
  configurationPath?: string;
  vru?: number;
  startupGroup?: number;
  preferContainer?: unknown;
  createdTime?: string;
  createdBy?: string;
  lastUpdatedTime?: string;
  lastUpdatedBy?: string;
};
export type AmppChildWorkloadsResponse = {
  workloads: Array<{
    workload: AmppChildWorkload;
    eTag?: string;
  }>;
};

export async function listChildWorkloads(
  workloadId: string,
): Promise<AmppChildWorkloadsResponse> {
  const response = await fetch(
    `/api/ampp/control/workloads/${encodeURIComponent(workloadId)}/child-workloads`,
    { credentials: 'include' },
  );

  if (!response.ok) {
    throw new Error(`List child workloads failed: ${response.status}`);
  }

  const json = await response.json();

  if (!json || !Array.isArray(json.workloads)) {
    throw new Error('Expected child workloads response to include a workloads array');
  }

  return json;
}
