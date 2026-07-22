import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { GVPlatform } from '../ampp/sdk/GVPlatform';

@Injectable()
export class AmppSessionBrokerService {
  private client?: GVPlatform;
  private clientLoginPromise?: Promise<GVPlatform>;

  constructor(private readonly config: ConfigService) {}

  async getClient(): Promise<GVPlatform> {
    if (this.client) {
      return this.client;
    }

    if (!this.clientLoginPromise) {
      this.clientLoginPromise = this.createLoggedInClient();
    }

    try {
      this.client = await this.clientLoginPromise;
      return this.client;
    } catch (error) {
      this.clientLoginPromise = undefined;
      this.client = undefined;
      throw error;
    }
  }

  private async createLoggedInClient(): Promise<GVPlatform> {
    const platformUrl = this.config.getOrThrow<string>('PLATFORM_URL');
    const apiKey = this.config.getOrThrow<string>('API_KEY');

    const client = new GVPlatform(platformUrl, apiKey);
    await client.login();

    return client;
  }
}
