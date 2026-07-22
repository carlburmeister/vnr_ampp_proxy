import { BadGatewayException, Injectable } from '@nestjs/common';
import type { AxiosResponse } from 'axios';

import { AmppSessionBrokerService } from './ampp-session-broker.service';

export type AmppProxyResponse = {
  status: number;
  contentType: string;
  body: Buffer;
};

@Injectable()
export class AmppProxyService {
  constructor(private readonly sessionBroker: AmppSessionBrokerService) {}

  async getUiPage(upstreamPath: string): Promise<AmppProxyResponse> {
    const client = await this.sessionBroker.getClient();
    let response: AxiosResponse<ArrayBuffer>;

    try {
      response = await client.instance.get<ArrayBuffer>(upstreamPath, {
        headers: {
          Authorization: `Bearer ${client.bearerToken}`,
          Accept:
            'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        },
        maxRedirects: 0,
        responseType: 'arraybuffer',
        validateStatus: () => true,
      });
    } catch (error) {
      throw new BadGatewayException(
        `Unable to reach AMPP: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }

    if (response.status >= 300 && response.status < 400) {
      throw new BadGatewayException(
        'AMPP redirected the proxy request. The UI does not accept the current utility bearer token.',
      );
    }

    return {
      status: response.status,
      contentType: String(
        response.headers['content-type'] ?? 'application/octet-stream',
      ),
      body: Buffer.from(response.data),
    };
  }
}
