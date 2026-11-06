import { BadGatewayException } from '@nestjs/common';
import axios from 'axios';

import { AmppCookieHttpService } from '../ampp-cookie-http.service';

jest.mock('axios');

describe('AmppCookieHttpService diagnostics', () => {
  const service = new AmppCookieHttpService({
    getOrThrow: () => 'https://us-east-1.gvampp.com',
  } as any);
  const jar = {
    getCookieString: jest.fn().mockResolvedValue(''),
    setCookie: jest.fn().mockResolvedValue(undefined),
  } as any;
  const request = axios.request as jest.Mock;

  beforeEach(() => request.mockReset());

  it('preserves successful response buffers and status', async () => {
    request.mockResolvedValue({ status: 200, headers: {}, data: Buffer.from('script') });
    const result = await service.request(jar, '/app/wrapper/main.bundle.js');
    expect(result.body.toString()).toBe('script');
    expect(result.status).toBe(200);
  });

  it('passes a recorder deadline and cancellation signal to the actual transport', async () => {
    const controller = new AbortController();
    request.mockResolvedValue({
      status: 204,
      headers: {},
      data: Buffer.alloc(0),
    });
    const options = {
      method: 'POST' as const,
      timeout: 100,
      signal: controller.signal,
    };
    await service.request(
      jar,
      '/cluster/matrix/api/v1/routing/requestroute',
      options,
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        timeout: 100,
        signal: controller.signal,
      }),
    );
  });

  it('passes through upstream 502 rather than retrying a non-idempotent request', async () => {
    request.mockResolvedValue({ status: 502, headers: {}, data: Buffer.from('Bad Gateway') });
    const result = await service.request(jar, '/app/wrapper/main.bundle.js');
    expect(result.status).toBe(502);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not leak transport errors into the HTTP response', async () => {
    request.mockRejectedValue(new Error('token=supersecret'));
    await expect(service.request(jar, '/app/wrapper/main.bundle.js'))
      .rejects.toThrow(BadGatewayException);
    await expect(service.request(jar, '/app/wrapper/main.bundle.js'))
      .rejects.toThrow('Unable to reach AMPP');
  });
});
