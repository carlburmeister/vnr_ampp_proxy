import assert from 'node:assert/strict';
import test from 'node:test';
import { componentHarness } from './helpers/componentHarness.mjs';
import { comparablePermissions } from '../src/features/gvui/gvuiPermissions.ts';
import { getGvuiLaunchUrl } from '../src/features/gvui/gvuiLaunch.ts';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const W = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const permission = () => ({ workloadIds: [7], dashboardIds: [8], deniedChildWorkloadIds: [], gvuiLayoutIds: [] as number[] });
const layouts = [{ id: A, name: 'Layout 2', associatedWorkloadId: null }, { id: B, name: 'Layout 10', associatedWorkloadId: W }];
const type = (node, name: string) => node.type === name || node.type?.name === name;

test('GVUI grants participate in dirty comparison without changing omission semantics', () => {
  const original = permission();
  assert.notEqual(comparablePermissions(original), comparablePermissions({ ...original, gvuiLayoutIds: [21] }));
  assert.equal(comparablePermissions({ ...original, gvuiLayoutIds: [22, 21] }), comparablePermissions({ ...original, gvuiLayoutIds: [21, 22] }));
});

async function editor(t, empty = false) {
  const requests: { path: string; options: RequestInit }[] = [];
  let saved = permission();
  const api = async (path: string, options: RequestInit = {}) => {
    requests.push({ path, options });
    let body: unknown;
    if (path.endsWith('/users')) body = [{ id: 2, username: 'test-user', userType: 'user' }];
    else if (path.endsWith('/resources')) body = {
      workloads: [{ id: 7, workloadId: W, name: 'Mixer', isParent: 0 }], dashboards: [],
      gvuiLayouts: empty ? [] : [{ ...layouts[0], id: 21, layoutId: A }, { ...layouts[1], id: 22, layoutId: B }] };
    else if (options.method === 'PUT') { saved = JSON.parse(String(options.body)); body = saved; }
    else body = saved;
    return { ok: true, json: () => Promise.resolve(structuredClone(body)) };
  };
  const h = componentHarness('components/UserManagementDialog.tsx', 'UserManagementDialog', {
    onClose() {}, onPermissionsSaved() {},
  }, { fetch: api });
  t.after(() => h.unmount()); await h.flush();
  return { h, requests, saved: () => saved };
}

test('User Management checks and unchecks GVUI grants, saves them and preserves other permissions', async (t) => {
  const { h, saved } = await editor(t);
  const checkbox = () => h.all((node) => type(node, 'label') && h.text(node).includes('Layout 2'))[0].props.children[0];
  const save = () => h.all((node) => type(node, 'button') && h.text(node) === 'Save Permissions')[0];
  assert.ok(h.all((node) => node.props?.id === 'user-management-gvui').length);
  assert.equal(save().props.disabled, true);
  checkbox().props.onChange({ target: { checked: true } }); await h.flush();
  assert.equal(save().props.disabled, false); save().props.onClick(); await h.flush();
  assert.deepEqual(saved().gvuiLayoutIds, [21]); assert.deepEqual(saved().workloadIds, [7]); assert.deepEqual(saved().dashboardIds, [8]);
  assert.equal(save().props.disabled, true);
  checkbox().props.onChange({ target: { checked: false } }); await h.flush();
  save().props.onClick(); await h.flush(); assert.deepEqual(saved().gvuiLayoutIds, []);
});

test('empty resources have a clear editor message', async (t) => {
  const { h } = await editor(t, true);
  assert.match(h.text(h.tree()), /No GVUI layouts available for this client/);
});

function homeSession() {
  return { user: { userType: 'admin', displayName: 'Test', username: 'test' },
    allowedWorkloads: [{ id: W, name: 'Mixer', is_parent: 0, pageType: 'ampp-ui' }], allowedDashboards: [], allowedGvuiLayouts: layouts };
}

test('home page places top-level/associated layouts without an activation flag', async (t) => {
  const h = componentHarness('components/UserHomePage.tsx', 'UserHomePage', { session: homeSession() }); t.after(() => h.unmount());
  const buttons = () => h.all((node) => type(node, 'GvuiLayoutButton'));
  assert.deepEqual(buttons().map((node) => node.props.layout.id), [A]);
  h.all((node) => node.props?.['aria-label'] === 'Toggle assigned resources for Mixer')[0].props.onClick(); await h.flush();
  assert.deepEqual(buttons().map((node) => node.props.layout.id), [B, A]);
  h.update({ session: { ...homeSession(), allowedGvuiLayouts: [] } });
  assert.equal(buttons().length, 0);
});

test('a top-level GVUI button appears even without assigned workloads', (t) => {
  const h = componentHarness('components/UserHomePage.tsx', 'UserHomePage', { session: { ...homeSession(), allowedWorkloads: [] } });
  t.after(() => h.unmount());
  assert.equal(h.all((node) => type(node, 'GvuiLayoutButton')).length, 1);
  h.update({ session: { ...homeSession(), allowedGvuiLayouts: [] } });
  assert.equal(h.all((node) => type(node, 'GvuiLayoutButton')).length, 0);
});

test('launches use separate server-authorized addresses and retain popup handles across async work', async (t) => {
  const opened: { replaced: string; closed: boolean; opener: unknown }[] = [];
  for (const layout of layouts) {
    const tab = { replaced: '', closed: false, opener: {}, location: { replace(value: string) { tab.replaced = value; } }, close() { tab.closed = true; } };
    opened.push(tab);
    const h = componentHarness('features/gvui/GvuiLayoutButton.tsx', 'GvuiLayoutButton', { layout, width: '20ch' }, {
      window: { open: () => tab }, fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({
        url: `/api/ampp-proxy/ui/gvui-${layout.id}/gvui/desktop/${layout.id}`,
      }) }),
    });
    t.after(() => h.unmount()); h.all((node) => type(node, 'button'))[0].props.onClick(); await h.flush();
    assert.equal(tab.closed, false); assert.equal(tab.opener, null); assert.ok(tab.replaced.includes(layout.id));
  }
  assert.notEqual(opened[0].replaced, opened[1].replaced);
});

test('launch failures close the blank tab and show the server error', async (t) => {
  let closed = false;
  const h = componentHarness('features/gvui/GvuiLayoutButton.tsx', 'GvuiLayoutButton', { layout: layouts[0], width: '20ch' }, {
    window: { open: () => ({ close() { closed = true; } }) },
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({ message: 'No accessible components' }) }),
  });
  t.after(() => h.unmount()); h.all((node) => type(node, 'button'))[0].props.onClick(); await h.flush();
  assert.equal(closed, true); assert.match(h.text(h.tree()), /No accessible components/);
});

test('launch helper rejects unexpected redirects', async (t) => {
  t.mock.method(globalThis, 'fetch', () => Promise.resolve({ ok: true, json: () => Promise.resolve({ url: 'https://outside.invalid/' }) }) as Promise<Response>);
  await assert.rejects(getGvuiLaunchUrl(A), /invalid GV.UI launch address/);
});
