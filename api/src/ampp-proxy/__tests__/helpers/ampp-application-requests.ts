// Application requests that returned 403 in the supplied regression captures.
const requests = [
  [
    'Audio Mixer preference',
    'bc8a392e-f043-467b-8358-7dfab9d13ea0',
    'config/getAudiolevelPreference',
  ],
  [
    'Flow Monitor control',
    '6ac0ee96-f6cb-46d2-be4e-00034ad72943',
    'app/control',
  ],
  ['Flow Monitor config', '6ac0ee96-f6cb-46d2-be4e-00034ad72943', 'app/config'],
  [
    'Flow Monitor metadata',
    '6ac0ee96-f6cb-46d2-be4e-00034ad72943',
    'app/mocha',
  ],
  ['Mini Mixer state', 'cbda2ccd-a99f-4c6a-8e82-1e0948858441', 'app/state'],
  ['SRT Input health', 'fbab1aa9-405b-460d-abfa-83a239981f5e', 'app/health'],
  ['SRT Input metadata', 'fbab1aa9-405b-460d-abfa-83a239981f5e', 'app/mocha'],
  [
    'SRT Input counters',
    'fbab1aa9-405b-460d-abfa-83a239981f5e',
    'app/counters',
  ],
  ['Output state', '1c88b808-1352-4ee2-bd9b-fc2437ced0b2', 'app/state'],
  ['Output health', '1c88b808-1352-4ee2-bd9b-fc2437ced0b2', 'app/health'],
] as const;

export const applicationRequests = requests.map(
  ([name, workloadId, endpoint]) => ({
    name,
    workloadId,
    path: `/mocha/application/${workloadId}/api/v1/${endpoint}`,
  }),
);
