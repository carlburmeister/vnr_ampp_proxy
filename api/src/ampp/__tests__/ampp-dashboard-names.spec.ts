import { AmppControl } from '../sdk/AmppControl';
import { AmppControlService } from '../services/ampp-control.service';

describe('AMPP dashboard names', () => {
  it('parses dashboard metadata and skips malformed records', async () => {
    const sdk = new AmppControl('http://example.invalid', 'test');
    (sdk as any).gvPlatform = { get: jest.fn(async () => ({ data: [
      { configuration: { value: JSON.stringify({ id: 'DASH-1', name: 'AMPP Name' }) } },
      { configuration: { value: 'malformed' } },
      { configuration: { value: JSON.stringify({ id: 'dash-2', name: '' }) } },
    ] })) };
    const names = await sdk.listDashboardNames();
    expect(names.get('dash-1')).toBe('AMPP Name');
    expect(names.size).toBe(1);
  });

  it('shares cached dashboard names and keeps the last valid map on API failure', async () => {
    const sdk = { listDashboardNames: jest.fn()
      .mockResolvedValueOnce(new Map([['dash-1', 'AMPP Name']]))
      .mockRejectedValueOnce(new Error('AMPP unavailable')) };
    const service = new AmppControlService({} as any);
    (service as any).getClient = async () => sdk;
    expect((await service.getDashboardNames()).get('dash-1')).toBe('AMPP Name');
    expect((await service.getDashboardNames()).get('dash-1')).toBe('AMPP Name');
    expect(sdk.listDashboardNames).toHaveBeenCalledTimes(1);
    (service as any).dashboardNamesExpiresAt = 0;
    expect((await service.getDashboardNames()).get('dash-1')).toBe('AMPP Name');
    expect(sdk.listDashboardNames).toHaveBeenCalledTimes(2);
  });
});
