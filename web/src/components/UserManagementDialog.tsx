import { useCallback, useEffect, useRef, useState } from 'react';

import './UserManagementDialog.css';
import {
  getClientPermissions,
  listClientResources,
  listClientUsers,
  listDiscoveredChildren,
  saveClientPermissions,
  type ClientPermissions,
  type ClientResources,
  type ClientUser,
  type DiscoveredChild,
} from '../services/clientPermissionsApi';
import { comparablePermissions, permissionSavePayload } from '../features/gvui/gvuiPermissions';

type Props = { onClose: () => void; onPermissionsSaved: () => void };

const normalized = (id: string) => id.toLowerCase();
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Unknown error';
const sortedPermissions = comparablePermissions;

export function UserManagementDialog({ onClose, onPermissionsSaved }: Props) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const childrenRequests = useRef(new Map<number, Promise<DiscoveredChild[]>>());
  const [users, setUsers] = useState<ClientUser[]>([]);
  const [resources, setResources] = useState<ClientResources | null>(null);
  const [userId, setUserId] = useState<number | null>(null);
  const [draft, setDraft] = useState<ClientPermissions | null>(null);
  const [original, setOriginal] = useState<ClientPermissions | null>(null);
  const [children, setChildren] = useState<Record<number, DiscoveredChild[]>>({});
  const [expanded, setExpanded] = useState<number[]>([]);
  const [loadingParents, setLoadingParents] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingPermissions, setLoadingPermissions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dirty = Boolean(draft && original && sortedPermissions(draft) !== sortedPermissions(original));

  const ensureChildren = useCallback((rowId: number) => {
    const existing = childrenRequests.current.get(rowId);
    if (existing) return existing;
    setLoadingParents((current) => [...current, rowId]);
    const promise = listDiscoveredChildren(rowId)
      .then((items) => {
        setChildren((current) => ({ ...current, [rowId]: items }));
        return items;
      })
      .catch((err: unknown) => {
        childrenRequests.current.delete(rowId);
        throw err;
      })
      .finally(() => setLoadingParents((current) => current.filter((id) => id !== rowId)));
    childrenRequests.current.set(rowId, promise);
    return promise;
  }, []);

  useEffect(() => {
    let active = true;
    closeButton.current?.focus();
    Promise.all([listClientUsers(), listClientResources()])
      .then(([clientUsers, available]) => {
        if (!active) return;
        setUsers(clientUsers);
        setResources(available);
        setUserId(clientUsers[0]?.id ?? null);
      })
      .catch((err: unknown) => { if (active) setError(messageOf(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (userId === null) return;
    let active = true;
    setDraft(null);
    setOriginal(null);
    setLoadingPermissions(true);
    setNotice('');
    setError('');
    getClientPermissions(userId)
      .then((permissions) => {
        if (!active) return;
        setDraft(permissions);
        setOriginal(permissions);
      })
      .catch((err: unknown) => { if (active) setError(messageOf(err)); })
      .finally(() => { if (active) setLoadingPermissions(false); });
    return () => { active = false; };
  }, [userId]);

  // Load assigned parents in advance so existing denials are retained on Save.
  useEffect(() => {
    if (!resources || !draft) return;
    for (const workload of resources.workloads) {
      if (workload.isParent && draft.workloadIds.includes(workload.id)) {
        void ensureChildren(workload.id).catch((err: unknown) => setError(messageOf(err)));
      }
    }
  }, [resources, draft?.workloadIds, ensureChildren]); // eslint-disable-line react-hooks/exhaustive-deps

  function dismiss() {
    if (saving) return;
    if (!dirty || window.confirm('Discard unsaved permission changes?')) onClose();
  }

  function changeUser(nextId: number) {
    if (saving || loadingPermissions) return;
    if (dirty && !window.confirm('Discard unsaved permission changes?')) return;
    setUserId(nextId);
  }

  function toggleDirect(field: 'workloadIds' | 'dashboardIds' | 'gvuiLayoutIds', id: number, enabled: boolean) {
    setDraft((current) => current && ({
      ...current,
      [field]: enabled ? [...(current[field] ?? []), id] : (current[field] ?? []).filter((value) => value !== id),
    }));
    setNotice('');
  }

  function toggleChild(id: string, enabled: boolean) {
    setDraft((current) => {
      if (!current) return null;
      const denied = new Set(current.deniedChildWorkloadIds.map(normalized));
      if (enabled) denied.delete(normalized(id));
      else denied.add(normalized(id));
      return { ...current, deniedChildWorkloadIds: [...denied] };
    });
    setNotice('');
  }

  function toggleExpanded(id: number) {
    setExpanded((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
    void ensureChildren(id).catch((err: unknown) => setError(messageOf(err)));
  }

  async function save() {
    if (!draft || !resources || userId === null || saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const assignedParents = resources.workloads.filter((workload) =>
        workload.isParent && draft.workloadIds.includes(workload.id),
      );
      const discovered = await Promise.all(assignedParents.map((parent) => ensureChildren(parent.id)));
      const allowedChildIds = new Set(discovered.flat().map((child) => normalized(child.id)));
      const originalParentIds = resources.workloads.filter((workload) =>
        workload.isParent && original?.workloadIds.includes(workload.id),
      ).map((workload) => workload.id);
      const parentsChanged = assignedParents.length !== originalParentIds.length ||
        assignedParents.some((parent) => !originalParentIds.includes(parent.id));
      // Keep hidden descendant denials unless parent assignments are being changed.
      const retainedDenials = parentsChanged
        ? draft.deniedChildWorkloadIds.filter((id) => allowedChildIds.has(normalized(id)))
        : draft.deniedChildWorkloadIds;
      const removedCount = draft.deniedChildWorkloadIds.length - retainedDenials.length;
      if (removedCount && assignedParents.length && !window.confirm(
        `${removedCount} existing child denial(s) are hidden from the current workload list. ` +
        'Changing parent assignments will remove these denials. Continue?',
      )) return;
      const changes: ClientPermissions = { ...draft, deniedChildWorkloadIds: retainedDenials };
      const saved = await saveClientPermissions(userId, permissionSavePayload(changes, resources.gvuiPhase2Enabled === true));
      setDraft(saved);
      setOriginal(saved);
      setNotice('Permissions saved. Active sessions will refresh automatically.');
      onPermissionsSaved();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  }

  const selectedUser = users.find((user) => user.id === userId);
  const rootIds = new Set(resources?.workloads.filter((workload) => draft?.workloadIds.includes(workload.id))
    .map((workload) => normalized(workload.workloadId)) ?? []);
  for (const workload of resources?.workloads ?? []) {
    if (workload.isParent && draft?.workloadIds.includes(workload.id)) {
      for (const child of children[workload.id] ?? []) {
        if (!draft.deniedChildWorkloadIds.some((id) => normalized(id) === normalized(child.id))) {
          rootIds.add(normalized(child.id));
        }
      }
    }
  }

  return (
    <div className="user-management-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) dismiss();
    }}>
      <section className="user-management-dialog" role="dialog" aria-modal="true"
        aria-labelledby="user-management-title" onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); dismiss(); }
        }}>
        <header className="user-management-header">
          <h2 id="user-management-title">User Management</h2>
          <button ref={closeButton} type="button" onClick={dismiss} aria-label="Close User Management">✕</button>
        </header>

        {loading ? <p>Loading client users and resources...</p> : (
          <>
            <label className="user-management-user-picker">
              Client user
              <select value={userId ?? ''} onChange={(event) => changeUser(Number(event.target.value))}
                disabled={saving || loadingPermissions || users.length === 0}>
                {users.map((user) => <option key={user.id} value={user.id}>
                  {user.username} ({user.userType})
                </option>)}
              </select>
            </label>
            {selectedUser && <p className="user-management-subtitle">
              {`${selectedUser.firstName ?? ''} ${selectedUser.lastName ?? ''}`.trim() || selectedUser.username}
              {' — '}Changes affect only this user.
            </p>}
            {loadingPermissions ? <p>Loading permissions...</p> : draft && resources ? (
              <div className="user-management-sections">
                <section aria-labelledby="user-management-workloads">
                  <h3 id="user-management-workloads">Workloads</h3>
                  <p className="user-management-hint">Assign access directly. Parent workloads include all discovered children unless explicitly denied.</p>
                  {resources.workloads.length ? resources.workloads.map((workload) => {
                    const granted = draft.workloadIds.includes(workload.id);
                    const isExpanded = expanded.includes(workload.id);
                    return <div key={workload.id} className="user-management-resource">
                      <div className="user-management-resource-row">
                        <label><input type="checkbox" checked={granted} disabled={saving}
                          onChange={(event) => toggleDirect('workloadIds', workload.id, event.target.checked)} />
                          <span>{workload.name}</span>
                          {workload.isParent ? <small>Parent</small> : null}
                        </label>
                        {Boolean(workload.isParent) && <button type="button" disabled={saving}
                          aria-expanded={isExpanded} onClick={() => toggleExpanded(workload.id)}>
                          {isExpanded ? 'Hide children' : 'Show children'}
                        </button>}
                      </div>
                      {Boolean(workload.isParent) && isExpanded && <div className="user-management-children">
                        {loadingParents.includes(workload.id) ? <p>Loading AMPP child workloads...</p>
                          : children[workload.id]?.length ? children[workload.id].map((child) => {
                            const denied = draft.deniedChildWorkloadIds.some((id) => normalized(id) === normalized(child.id));
                            return <label key={child.id} className="user-management-child">
                              <input type="checkbox" checked={granted && !denied} disabled={!granted || saving}
                                onChange={(event) => toggleChild(child.id, event.target.checked)} />
                              <span>{child.name}</span>
                              {granted && denied && <small>Denied</small>}
                            </label>;
                          }) : <p>No child workloads found, or unable to load them.</p>}
                      </div>}
                    </div>;
                  }) : <p>No workloads configured for this client.</p>}
                </section>

                <section aria-labelledby="user-management-dashboards">
                  <h3 id="user-management-dashboards">Dashboards</h3>
                  <p className="user-management-hint">Dashboard grants are separate. Associated dashboards also require effective workload access.</p>
                  {resources.dashboards.length ? resources.dashboards.map((dashboard) => {
                    const accessible = !dashboard.associatedWorkloadId || rootIds.has(normalized(dashboard.associatedWorkloadId));
                    return <label key={dashboard.id} className="user-management-dashboard">
                      <input type="checkbox" checked={draft.dashboardIds.includes(dashboard.id)} disabled={saving}
                        onChange={(event) => toggleDirect('dashboardIds', dashboard.id, event.target.checked)} />
                      <span>{dashboard.name}</span>
                      {!accessible && <small>Requires associated workload access</small>}
                    </label>;
                  }) : <p>No dashboards configured for this client.</p>}
                </section>
                {resources.gvuiPhase2Enabled && <section aria-labelledby="user-management-gvui">
                  <h3 id="user-management-gvui">GVUI Layouts</h3>
                  <p className="user-management-hint">Layout grants are separate. Embedded applications still require their own workload permissions.</p>
                  {resources.gvuiLayouts?.length ? resources.gvuiLayouts.map((layout) => {
                    const accessible = !layout.associatedWorkloadId || rootIds.has(normalized(layout.associatedWorkloadId));
                    return <label key={layout.id} className="user-management-dashboard">
                      <input type="checkbox" checked={draft.gvuiLayoutIds?.includes(layout.id) ?? false} disabled={saving}
                        onChange={(event) => toggleDirect('gvuiLayoutIds', layout.id, event.target.checked)} />
                      <span>{layout.name}</span>
                      {!accessible && <small>Requires associated workload access</small>}
                    </label>;
                  }) : <p>No GVUI layouts available for this client.</p>}
                </section>}
              </div>
            ) : !error ? <p>Select a client user to manage permissions.</p> : null}
          </>
        )}
        {error && <p className="user-management-error" role="alert">{error}</p>}
        {notice && <p className="user-management-success" role="status">{notice}</p>}
        <footer className="user-management-footer">
          {draft && <button type="button" onClick={() => void save()}
            disabled={!dirty || saving || loadingPermissions}>
            {saving ? 'Saving...' : 'Save Permissions'}
          </button>}
          <button type="button" onClick={dismiss} disabled={saving}>Close</button>
        </footer>
      </section>
    </div>
  );
}
