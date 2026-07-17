export type ExtractedWorkload = {
  id: string;
  name: string;
  applicationName: string;
  fabricId: string;
  nodeId: string;
};

export type UserDBWorkload = {
  id: string;
  name: string;
  is_parent: 0 | 1;
};

export type AllowedWorkload = UserDBWorkload & {
  applicationName?: string;
  fabricId?: string;
  nodeId?: string;
  child_workloads?: ExtractedWorkload[];
};

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
