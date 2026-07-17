import { IGVServiceDescription } from './GVDiscoveryClient';
import { GVPlatform } from './GVPlatform';
import { calculateSubnet } from './helpers';

interface PushNotificationServiceLocator {
  hubUrl: string;
  isLocalPushHub: boolean;
}

interface IGVGetServiceParams {
  type?: string;
  instance?: string;
  tag?: { [name: string]: string } | string[] | string;
}

/**
 * getPushNotificationServiceLocators
 * Searches for all available LocalPushNotificationRelay services in the local network and a cloud push service
 * @returns servce urls with a boolean indicating if it is a localPush
 */
export const getPushNotificationServiceLocators = async (
  platform: GVPlatform,
  platformUri: string,
  siteId?: string,
  localIpAddress?: string,
  localSubnetMask?: string,
  rejectCloudPush: boolean = false,
): Promise<PushNotificationServiceLocator[]> => {
  const result = [];

  const localPushUrls = await getLocalPushNotificationServiceLocators(
    platform,
    siteId,
    localIpAddress,
    localSubnetMask,
  );
  result.push(...localPushUrls.map((url) => ({ hubUrl: url, isLocalPushHub: true })));

  if (!rejectCloudPush) {
    result.push({ hubUrl: `${platformUri}/pushnotificationshub`, isLocalPushHub: false });
  }

  return result;
};

const getLocalPushNotificationServiceLocators = async (
  platform: GVPlatform,
  siteId?: string,
  localIpAddress?: string,
  localSubnetMask?: string,
): Promise<string[]> => {
  if (siteId) {
    console.log(`Searching for LocalPushNotificationRelay with SiteId: ${siteId}`);

    try {
      const services = await getLocalPushServices(platform, siteId);
      return services.flatMap((s) => findLocalPushUrls(s, localIpAddress, localSubnetMask));
    } catch (e) {
      console.error(`Error Finding LocalPushNotificationRelay: ${e}`);
    }
  }
  return [];
};

const getLocalPushServices = async (platform: GVPlatform, siteId: string): Promise<IGVServiceDescription[]> => {
  const params: IGVGetServiceParams = {
    type: 'LocalPushNotificationRelay-Hub',
    tag: `SiteId=${siteId}`,
  };

  const services = await platform.discovery.getServicesAsync(params);
  return services.sort((a, b) => new Date(b.registeredTimeUtc).getTime() - new Date(a.registeredTimeUtc).getTime());
};

const findLocalPushUrls = (
  service: IGVServiceDescription,
  localIpAddress: string,
  localSubnetMask: string,
): string[] => {
  const localAddresses = service.serviceMetadata?.localAddresses?.split(', ');
  if (localIpAddress && localSubnetMask) {
    const localSubnet = calculateSubnet(localIpAddress, localSubnetMask);
    const localPushIp = localAddresses.find((ip: string) => calculateSubnet(ip, localSubnetMask) === localSubnet);
    if (localPushIp) {
      return [createLocalPushAddress(localPushIp, service.servicePort, service.serviceId)];
    } else {
      return [];
    }
  } else {
    return localAddresses.map((a) => createLocalPushAddress(a, service.servicePort, service.serviceId));
  }
};

const createLocalPushAddress = (address: string, port: string | number, serviceId: string) =>
  `http://${address}:${port}/${serviceId}-pushnotificationshub`;
