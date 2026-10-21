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
