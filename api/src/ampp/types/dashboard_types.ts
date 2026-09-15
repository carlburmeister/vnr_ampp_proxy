export type DashboardPageType = 'custom' | 'ampp-ui';

export type AllowedDashboard = {
  id: string;
  associatedWorkloadId: string;
  name: string;
  pageType: DashboardPageType;
};
