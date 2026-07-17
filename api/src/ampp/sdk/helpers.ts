import os from 'os';
import { execSync } from 'child_process';
import { Netmask } from 'netmask';

export const getIPAddress = (): string => {
  let res = '';
  const interfaces = os.networkInterfaces();
  Object.keys(interfaces).forEach((key) => {
    interfaces[key]?.forEach((iface) => {
      if (!iface.internal && iface.family === 'IPv4') {
        console.log('Found IP Address: ', iface.address);
        res = iface.address;
      }
    });
  });
  console.log('Selected IP Address: ', res);
  return res;
};

export const getNetmask = (ipAddress: string): string => {
  let res = '';
  try {
    //TODO: Windows ipconfig cmd... Use .env for local Push settings...or make helpers.ts OS aware...
    const ipconfig = execSync('ipconfig /all').toString();
    const regex = new RegExp(`.*${ipAddress}.*?Subnet Mask.*?:\\s*(\\d+\\.\\d+\\.\\d+\\.\\d+)`, 's');
    const match = ipconfig.match(regex);
    if (match && match[1]) {
      res = match[1].trim();
    }
  } catch (error) {
    console.error('Error getting subnet mask:', error);
  }
  console.log('Netmask: ', res);
  return res;
};

export const calculateSubnet = (ip: string, subnetMask: string) => {
  const block = new Netmask(`${ip}/${subnetMask}`);
  return block.base;
};
