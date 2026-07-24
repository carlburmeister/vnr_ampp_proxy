import assert from 'node:assert/strict';
import test from 'node:test';

import { getAmppUiLaunchTarget } from '../src/utils/workloadAmppUiHandlers.ts';

const workload = {
  id: 'workload-001',
  name: 'Test workload',
  is_parent: 0 as const,
  applicationName: 'Test application',
  packageName: 'GV.AMPP.Apps.MiniMixer',
  pageType: 'ampp-ui' as const,
};

test('builds a MiniMixer AMPP UI URL from packageName', () => {
  assert.deepEqual(getAmppUiLaunchTarget(workload), {
    url:
      '/api/ampp-proxy/ui/workload-001' +
      '/app/wrapper/single/GV.AMPP.Apps.MiniMixer/workload-001',
    title: 'Test workload',
  });
});

test('builds another AMPP UI URL without an application mapping', () => {
  assert.equal(
    getAmppUiLaunchTarget({
      ...workload,
      packageName: 'GV.AMPP.Apps.AudioMixer',
    }).url,
    '/api/ampp-proxy/ui/workload-001' +
      '/app/wrapper/single/GV.AMPP.Apps.AudioMixer/workload-001',
  );
});

test('rejects workloads without packageName', () => {
  assert.throws(
    () => getAmppUiLaunchTarget({ ...workload, packageName: undefined }),
    /No AMPP UI package is available/,
  );
});
