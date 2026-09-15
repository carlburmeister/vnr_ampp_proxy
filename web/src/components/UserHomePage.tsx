import { Fragment, useState } from 'react';

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
};

type WorkloadLaunchTargetResolver = () =>
  | Promise<WorkloadLaunchTarget | null>
  | WorkloadLaunchTarget
  | null;

export function UserHomePage({ session, onLogout }: UserHomePageProps) 
{  
  const workloads: AllowedWorkload[] = session.allowedWorkloads ?? [];
  const dashboards: AllowedDashboard[] = session.allowedDashboards ?? [];
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
      setExpandedWorkloadIds((currentExpandedWorkloadIds) => (
        currentExpandedWorkloadIds.includes(workload.id)
          ? currentExpandedWorkloadIds.filter(
              (workloadId) => workloadId !== workload.id,
            )
          : [...currentExpandedWorkloadIds, workload.id]
      ));

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
  function renderDashboardButtons(workloadId: string) {
    return dashboards
      .filter((dashboard) => dashboard.associatedWorkloadId === workloadId)
      .map((dashboard) => (
        <button
          key={dashboard.id}
          type="button"
          className="workload-button child-workload-button"
          style={{ width: buttonWidth, cursor: 'default', opacity: 1 }}
          data-dashboard-id={dashboard.id}
          data-associated-workload-id={dashboard.associatedWorkloadId}
          data-page-type={dashboard.pageType}
          disabled
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

        <button type="button" onClick={onLogout}>
          Sign out
        </button>
      </header>

      <section className="workloads-section">
        <h2>My Workloads</h2>

        {workloadActionError && (
          <p className="workload-action-error">
            {workloadActionError}
          </p>
        )}

        {workloads.length ? (
          <div className="workload-button-list">
            {workloads.map((workload: AllowedWorkload) => {
              const isExpanded =
                expandedWorkloadIds.includes(workload.id);
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
                <div
                  key={workload.id}
                  className="workload-group"
                >
                  <button
                    type="button"
                    className="workload-button"
                    style={{ width: buttonWidth }}
                    data-workload-id={workload.id}
                    data-application-name={workload.applicationName}
                    disabled={loadingWorkloadId === workload.id}
                    onClick={() => handleWorkloadClick(workload)}
                  >
                    {loadingWorkloadId === workload.id
                      ? 'Loading...'
                      : workload.name}
                  </button>

                  {renderDashboardButtons(workload.id)}

                  {workload.is_parent === 1 && isExpanded && (
                    <div className="child-workload-button-list">
                      {childWorkloads.length ? (
                        childWorkloads.map(
                          (childWorkload: ChildWorkload) => (
                            <Fragment key={childWorkload.id}>
                              <button
                                type="button"
                                className="workload-button child-workload-button"
                                style={{ width: buttonWidth }}
                                data-application-name={
                                  childWorkload.applicationName
                                }
                                //onClick={() => handleChildWorkloadClick(childWorkload)}
                                onClick={() =>
                                  handleChildWorkloadClick(
                                    childWorkload,
                                  )
                                }
                              >
                                {childWorkload.name}
                              </button>

                              {renderDashboardButtons(childWorkload.id)}
                            </Fragment>
                          ),
                        )
                      ) : (
                        <p className="child-workload-empty-message">
                          No child workloads found.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p>No workloads assigned.</p>
        )}
      </section>
    </section>
  );
}
