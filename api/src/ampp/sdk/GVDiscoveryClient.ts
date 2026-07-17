import { GVPlatform } from './GVPlatform';

export interface IGVServiceHealth {
  health: string;
  healthText: string;
}

export interface IGVServiceDescription {
  serviceId: string;
  serviceSecret?: string;
  serviceType: string;
  serviceInstance: string;
  serviceAddress: string;
  serviceUrl: string;
  servicePort: string | number;
  reverseProxyPathRule: string;
  serviceTags: { [name: string]: string } | string[];
  serviceHealth: IGVServiceHealth;
  serviceMetadata: { localAddresses: string };
  registeredTimeUtc: string;
}

export interface IGVGetServiceParams {
  type?: string;
  instance?: string;
  tag?: { [name: string]: string } | string[] | string;
}

export class GVDiscoveryClient {
  private gvPlatform: GVPlatform;

  private readonly BASE_API_PATH = 'discovery/api/v1';

  /**
   * Constructor
   * @param platform -GVPlatform Connection
   */
  constructor(platform: GVPlatform) {
    this.gvPlatform = platform;
  }

  /**
   * getServicesAsync
   * Gets a list of services.
   * @param params Optional service params
   * @returns A list of services if any are registered; otherwise an empty list
   */
  public getServicesAsync = async (params?: IGVGetServiceParams): Promise<IGVServiceDescription[]> => {
    const result = await this.gvPlatform.get(`${this.BASE_API_PATH}/services`, params);
    if (result.status === 200) {
      return result.data as IGVServiceDescription[];
    }
    return [];
  };
}
