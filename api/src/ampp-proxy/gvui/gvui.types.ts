export type GvuiLayoutAssignment = {
  id: number;
  layoutId: string;
  name: string;
  associatedWorkloadId: string | null;
};

export type AllowedGvuiLayout = {
  id: string;
  name: string;
  associatedWorkloadId: string | null;
};
