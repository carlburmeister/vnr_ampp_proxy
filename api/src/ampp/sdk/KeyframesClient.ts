//import { EventEmitter } from 'stream';
import { EventEmitter } from 'events';

import { IPlatformNotification, Producer, PushNotificationConfig } from './Model';
import { GVPlatform } from './GVPlatform';
import fs from 'fs';

export enum PreviewSizeNum {
  Small = 120,
  Medium = 240,
  Large = 480,
}

export const PreviewSize = {
  [PreviewSizeNum.Small]: 'small',
  [PreviewSizeNum.Medium]: 'medium',
  [PreviewSizeNum.Large]: 'large',
};

/**
 * Class for subscribing to keyframe notifications
 */
export class KeyframesClient extends EventEmitter {
  private gvPlatform: GVPlatform | null;
  private subscriptions: string[] = [];
  private readonly folderPath: string;
  private subscriptionInterval: NodeJS.Timer;
  private currentProducerName = "keyframe";

  private readonly SUBSCRIPTION_RENEW_TIME_SECONDS = 60;

  /**
   * constructor
   * @param baseURL url for accessing GV Platform
   * @param apiKey The API Key (must have platform and cluster.readonly scopes)
   * @param folderPath The folder path to save the keyframes
   * @param pushNotificationConfig Configuration for Push Notifications
   */
  constructor(baseURL: string, apiKey: string, folderPath: string, pushNotificationConfig?: PushNotificationConfig) {
    super();
    this.gvPlatform = new GVPlatform(baseURL, apiKey, pushNotificationConfig);
    this.folderPath = folderPath;
  }

  public async login(): Promise<boolean> {
    return this.gvPlatform.login();
  }

  public async getProducerAsync(fabricId: string, producerName: string): Promise<Producer> {
    const name = encodeURIComponent(producerName);
    const url = `/cluster/matrix/api/v1/producer/${fabricId}/${name}`;

    const result = await this.gvPlatform.get(url);
    if (result.status === 200) {
      const messages: Producer = { producer: result.data };
      return messages;
    }
    return null;
  }

  public async startNotificationListener(): Promise<boolean> {
    this.gvPlatform.on('notification', this.onNotification);
    this.gvPlatform.on('reconnecting', this.onReconnecting.bind(this));
    this.gvPlatform.on('reconnected', this.onReconnected.bind(this));
    return this.gvPlatform.startNotificationListener();
  }

  public setProducerName(producerName: string) {
    this.currentProducerName = producerName;
  }

  public addKeyframesSubscription(nodeId: string, flowId: string): string {
    const subscription = `gv.ampp.keyframe.${nodeId}.${flowId}.${PreviewSize[PreviewSizeNum.Small]}`;
    this.subscriptions.push(subscription);
    return subscription;
  }

  public async startKeyframesSubscriptionAsync() {
    await Promise.all(
      this.subscriptions.map(async (subscription: string) => {
        await this.gvPlatform.subscribeToNotification(subscription);
        console.log('Subscribing to', subscription);
      }),
    );
    await this.renewFrameCacheSubscriptions();
    this.subscriptionInterval = setInterval(
      this.renewFrameCacheSubscriptions.bind(this),
      this.SUBSCRIPTION_RENEW_TIME_SECONDS * 1000,
    );
  }

  public async stopKeyframesSubscriptionAsync() {
    await Promise.all(
      this.subscriptions.map(async (subscription: string) => {
        await this.gvPlatform.unsubscribeNotification(subscription);
        console.log('Unsubscribing:', subscription);
      }),
    );
    //clearInterval(this.subscriptionInterval);
    clearInterval(this.subscriptionInterval as any);
  }

  private async renewFrameCacheSubscriptions() {
    try {
      return await Promise.all(
        this.subscriptions.map(async (subscription: string) => {
          console.log('Renewing subscription', subscription);
          const parts: string[] = subscription.split('.');
          const topic = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}`;
          const flowId = parts[4];
          await this.sendFlowSubscriptionRequest(topic, flowId);
        }),
      );
    } catch (err) {
      console.log('err', err);
    }
  }

  private async sendFlowSubscriptionRequest(topic: string, flowId: string) {
    const content = {
      PreviewSize: PreviewSizeNum.Small,
      FlowId: flowId,
    };
    await this.gvPlatform.publishNotification(topic, content);
  }

  private onNotification = (notification: IPlatformNotification) => {
    console.log('Received keyframes notification');
    if (notification.binaryContent) {
      const fileName = `${this.currentProducerName.replace(/[^a-zA-Z0-9_-]/g, '_')}.jpg`;
      const filePath = `${this.folderPath}/${fileName}`;
      try {
        fs.writeFileSync(filePath, Buffer.from(notification.binaryContent, 'base64'));
        this.emit('keyframe', { filePath, producerName: this.currentProducerName, notification });
        console.log('The file was saved to', filePath);
        console.log(new Date());
      } catch (err) {
        console.log('Error saving the file:', err);
      }
    }
  };

  private onReconnected = () => {
    //clearInterval(this.subscriptionInterval);
    clearInterval(this.subscriptionInterval as any);
    this.startKeyframesSubscriptionAsync();
  };

  private onReconnecting = () => {
    //clearInterval(this.subscriptionInterval);
    clearInterval(this.subscriptionInterval as any);
  };
}
