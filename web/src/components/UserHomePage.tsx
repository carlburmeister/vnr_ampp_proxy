import { useState } from 'react';
import { UserManagementDialog } from './UserManagementDialog';
import { GvuiPhase1Button } from '../features/gvui/GvuiPhase1Button';

import './UserHomePage.css';

import { FLOW_MONITOR_APPLICATION_NAME } from '../features/flowMonitor/flowMonitorConstants';
import { getFlowMonitorLaunchTarget } from '../features/flowMonitor/flowMonitorWorkloadHandler';
import { MINI_MIXER_APPLICATION_NAME } from '../features/miniMixer/minMixerConstants';
import { getMiniMixerLaunchTarget } from '../features/miniMixer/minMixerWorkloadHandler';

import type {
  AllowedDashboard,
  AllowedWorkload,
  ChildWorkload,
  SessionData,
} from '../services/amppSessionApi';
import {
  resolveWorkloadApplicationLaunchTarget,
  type WorkloadApplicationLaunchHandler,
  type WorkloadLaunchTarget,
} from '../utils/workloadApplicationHandlers';
import { getAmppUiLaunchTarget } from '../utils/workloadAmppUiHandlers';

type UserHomePageProps = {
  session: SessionData;
  onLogout: () => void;
  onPermissionsSaved: () => void;
};

type WorkloadLaunchTargetResolver = () =>
  | Promise<WorkloadLaunchTarget | null>
  | WorkloadLaunchTarget
  | null;

export function UserHomePage({ session, onLogout, onPermissionsSaved }: UserHomePageProps) 
{  
  const workloads: AllowedWorkload[] = session.allowedWorkloads ?? [];
  const dashboards: AllowedDashboard[] = session.allowedDashboards ?? [];
  const [actionsOpen, setActionsOpen] = useState(false);
  const [managementOpen, setManagementOpen] = useState(false);
  const [expandedWorkloadIds, setExpandedWorkloadIds] = useState<string[]>([]);
  const [workloadActionError, setWorkloadActionError] = useState('');
  const [loadingWorkloadId, setLoadingWorkloadId] = useState('');

  const workloadApplicationLaunchHandlers: Record<string, WorkloadApplicationLaunchHandler> = {
    [FLOW_MONITOR_APPLICATION_NAME]: getFlowMonitorLaunchTarget,
    [MINI_MIXER_APPLICATION_NAME]: getMiniMixerLaunchTarget,
  };

  const workloadNames = [
    ...workloads.flatMap((workload: AllowedWorkload) => [
      workload.name,
      ...(workload.child_workloads ?? []).map(
        (childWorkload: ChildWorkload) => childWorkload.name,
      ),
    ]),
    ...dashboards.map((dashboard) => dashboard.name),
  ];

  const longestNameLength = Math.max(
    12,
    ...workloadNames.map((workloadName: string) => workloadName.length),
  );

  const buttonWidth = `${longestNameLength + 4}ch`;
  const hasStandaloneDashboards = dashboards.some(
    (dashboard) => dashboard.associatedWorkloadId === null,
  );

  /*-------------------------------------------------------------*/
  //  handleWorkloadClick()
  /*-------------------------------------------------------------*/
  async function handleWorkloadClick(workload: AllowedWorkload) {
    console.log('[AMVVPP WebRTC] workload button clicked', {
      workloadId: workload.id,
      workloadName: workload.name,
      applicationName: workload.applicationName,
      pageType: workload.pageType,
      isParent: workload.is_parent,
    });

    setWorkloadActionError('');

    if (workload.is_parent === 1) {
      toggleWorkloadExpanded(workload.id);
      return;
    }

    if (
      workload.pageType === 'custom' &&
      hasWorkloadApplicationLaunchHandler(workload)
    ) {
      await openWorkloadInNewTab(workload, () =>
        resolveWorkloadApplicationLaunchTarget(
          workload,
          workloadApplicationLaunchHandlers,
        ),
      );

      return;
    }

    if (workload.pageType === 'ampp-ui') {
      await openWorkloadInNewTab(
        workload,
        () => getAmppUiLaunchTarget(workload),
      );

      return;
    }

    setWorkloadActionError(
      `No custom UI is configured for ${
        workload.applicationName ?? workload.name
      }.`,
    );
  }

  /*-------------------------------------------------------------*/
  //  toggleWorkloadExpanded()
  /*-------------------------------------------------------------*/
  function toggleWorkloadExpanded(workloadId: string) {
    setExpandedWorkloadIds((currentExpandedWorkloadIds) => (
      currentExpandedWorkloadIds.includes(workloadId)
        ? currentExpandedWorkloadIds.filter((id) => id !== workloadId)
        : [...currentExpandedWorkloadIds, workloadId]
    ));
  }

  /*-------------------------------------------------------------*/
  //  handleChildWorkloadClick()
  /*-------------------------------------------------------------*/
  function handleChildWorkloadClick(workload: ChildWorkload) {
    // TODO: Route/click behavior will use workload.applicationName.
    console.log(
      'Selected workload application:',
      workload.applicationName,
    );

    void handleWorkloadClick(workload);
  }

  /*-------------------------------------------------------------*/
  //  handleDashboardClick()
  /*-------------------------------------------------------------*/
  function handleDashboardClick(dashboard: AllowedDashboard) {
    setWorkloadActionError('');

    const proxyWorkloadId =
      dashboard.associatedWorkloadId ??
      workloads[0]?.child_workloads?.[0]?.id ??
      workloads[0]?.id;
    if (!proxyWorkloadId) {
      setWorkloadActionError(
        'An assigned workload is required to open a dashboard.',
      );
      return;
    }

    const dashboardUrl =
      `/api/ampp-proxy/ui/${encodeURIComponent(proxyWorkloadId)}` +
      `/cluster/systemdashboard/dashboard/${encodeURIComponent(dashboard.id)}`;
    const newTab = window.open(dashboardUrl, '_blank');

    if (!newTab) {
      setWorkloadActionError(
        'Unable to open a new browser tab. Please allow popups for this site.',
      );
    }
  }

  /*-------------------------------------------------------------*/
  //  hasWorkloadApplicationLaunchHandler()
  /*-------------------------------------------------------------*/
  function hasWorkloadApplicationLaunchHandler(
    workload: AllowedWorkload,
  ) {
    return Boolean(
      workload.applicationName &&
      workloadApplicationLaunchHandlers[workload.applicationName]
    );
  }

  /*-------------------------------------------------------------*/
  //  openWorkloadInNewTab()
  /*-------------------------------------------------------------*/
  async function openWorkloadInNewTab(
    workload: AllowedWorkload,
    resolveLaunchTarget: WorkloadLaunchTargetResolver,
  ) {
    const newTab = window.open('about:blank', '_blank');

    if (!newTab) {
      setWorkloadActionError(
        'Unable to open a new browser tab. Please allow popups for this site.',
      );

      return;
    }

    setLoadingWorkloadId(workload.id);

    try {
      const launchTarget = await resolveLaunchTarget();

      if (!launchTarget) {
        newTab.close();
        return;
      }

      newTab.location.href = launchTarget.url;
    } catch (err) {
      newTab.close();

      console.error(
        '[AMVVPP] open workload application failed',
        err,
      );

      setWorkloadActionError(
        err instanceof Error
          ? err.message
          : 'Open workload application failed',
      );
    } finally {
      setLoadingWorkloadId('');
    }
  }

  /*-------------------------------------------------------------*/
  //  renderDashboardButtons()
  /*-------------------------------------------------------------*/
  function renderDashboardButtons(workloadId: string | null) {
    return dashboards
      .filter((dashboard) => dashboard.associatedWorkloadId === workloadId)
      .map((dashboard) => (
        <button
          key={dashboard.id}
          type="button"
          className={workloadId === null
            ? 'workload-button'
            : 'workload-button child-workload-button'}
          style={{ width: buttonWidth }}
          data-dashboard-id={dashboard.id}
          data-associated-workload-id={dashboard.associatedWorkloadId}
          data-page-type={dashboard.pageType}
          onClick={() => handleDashboardClick(dashboard)}
        >
          {dashboard.name}
        </button>
      ));
  }

  return (
    <section className="user-home-page">
      <header className="user-home-header">
        <div>
          <h1>{session.user.displayName}</h1>
          <p>{session.user.username}</p>
        </div>

        <div className="user-actions">
          <button type="button" aria-expanded={actionsOpen} onClick={() => setActionsOpen(!actionsOpen)}>
            Actions ▾
          </button>
          {actionsOpen && (
            <div className="user-actions-menu">
              {session.user.userType === 'admin' && (
                <button type="button" onClick={() => { setManagementOpen(true); setActionsOpen(false); }}>
                  User Management
                </button>
              )}
              <button type="button" onClick={onLogout}>Sign Out</button>
            </div>
          )}
        </div>
      </header>

      {managementOpen && session.user.userType === 'admin' && (
        <UserManagementDialog onClose={() => setManagementOpen(false)}
          onPermissionsSaved={onPermissionsSaved} />
      )}
      <section className="workloads-section">
        <h2>My Workloads</h2>

        {workloadActionError && (
          <p className="workload-action-error">
            {workloadActionError}
          </p>
        )}

        {workloads.length || hasStandaloneDashboards ? (
          <div className="workload-button-list">
            {workloads.map((workload: AllowedWorkload) => {
              const isExpanded = expandedWorkloadIds.includes(workload.id);
              const hasDashboards = dashboards.some(
                (dashboard) => dashboard.associatedWorkloadId === workload.id,
              );
              const childWorkloads = [
                ...(workload.child_workloads ?? []),
              ].sort((firstWorkload, secondWorkload) =>
                firstWorkload.name.localeCompare(
                  secondWorkload.name,
                  undefined,
                  { numeric: true },
                ),
              );

              return (
                <div key={workload.id} className="workload-group">
                  <div className="workload-selector">
                    <button
                      type="button"
                      className="workload-button"
                      style={{ width: buttonWidth }}
                      data-workload-id={workload.id}
                      data-application-name={workload.applicationName}
                      disabled={loadingWorkloadId === workload.id}
                      aria-expanded={workload.is_parent === 1
                        ? isExpanded
                        : undefined}
                      onClick={() => handleWorkloadClick(workload)}
                    >
                      {loadingWorkloadId === workload.id
                        ? 'Loading...'
                        : workload.name}
                    </button>

                    {workload.is_parent === 0 && hasDashboards && (
                      <button
                        type="button"
                        className="workload-expand-button"
                        aria-label={`Toggle dashboards for ${workload.name}`}
                        aria-expanded={isExpanded}
                        onClick={() => toggleWorkloadExpanded(workload.id)}
                      >
                        {isExpanded ? '▾' : '▸'}
                      </button>
                    )}
                  </div>

                  {isExpanded && (workload.is_parent === 1 || hasDashboards) && (
                    <div className="child-workload-button-list">
                      {renderDashboardButtons(workload.id)}
                      {workload.is_parent === 1 && (
                        childWorkloads.length ? (
                          childWorkloads.map((childWorkload: ChildWorkload) => {
                            const isChildExpanded = expandedWorkloadIds.includes(
                              childWorkload.id,
                            );
                            const hasChildDashboards = dashboards.some(
                              (dashboard) =>
                                dashboard.associatedWorkloadId === childWorkload.id,
                            );

                            return (
                              <div
                                key={childWorkload.id}
                                className="workload-group"
                              >
                                <div className="workload-selector">
                                  <button
                                    type="button"
                                    className="workload-button child-workload-button"
                                    style={{ width: buttonWidth }}
                                    data-application-name={
                                      childWorkload.applicationName
                                    }
                                    //onClick={() => handleChildWorkloadClick(childWorkload)}
                                    onClick={() =>
                                      handleChildWorkloadClick(childWorkload)
                                    }
                                  >
                                    {childWorkload.name}
                                  </button>
                                  {hasChildDashboards && (
                                    <button
                                      type="button"
                                      className="workload-expand-button"
                                      aria-label={
                                        `Toggle dashboards for ${childWorkload.name}`
                                      }
                                      aria-expanded={isChildExpanded}
                                      onClick={() =>
                                        toggleWorkloadExpanded(childWorkload.id)
                                      }
                                    >
                                      {isChildExpanded ? '▾' : '▸'}
                                    </button>
                                  )}
                                </div>
                                {hasChildDashboards && isChildExpanded && (
                                  <div className="child-workload-button-list">
                                    {renderDashboardButtons(childWorkload.id)}
                                  </div>
                                )}
                              </div>
                            );
                          })
                        ) : !hasDashboards ? (
                          <p className="child-workload-empty-message">
                            No child workloads found.
                          </p>
                        ) : null
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {renderDashboardButtons(null)}
            <GvuiPhase1Button />
          </div>
        ) : (
          <p>No workloads assigned.</p>
        )}
      </section>
    </section>
  );
}
