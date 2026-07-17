import { AxiosResponse } from 'axios';
import { randomUUID } from 'crypto';
import { DateTime } from 'luxon';

import events from 'events';
import { GVPlatform } from './GVPlatform';
import {
  IAmppControlError,
  IAmppControlMacro,
  IAmppControlNotification,
  IPlatformNotification,
  PushNotificationConfig,
} from './Model';

const WEBRTC_DEBUG = process.env.WEBRTC_DEBUG === 'true';
function notificationDebugLog(...args: unknown[]) {
  if (process.env.AMPP_NOTIFICATIONS_DEBUG === 'true') {
    console.log(...args);
  }
}

function webRtcDebugLog(...args: unknown[]) {
  if (WEBRTC_DEBUG) {
    console.log(...args);
  }
}

function webRtcDebugWarn(...args: unknown[]) {
  if (WEBRTC_DEBUG) {
    console.warn(...args);
  }
}

/**
 * Class for Accessing AMPP Control Functionality
 */
export class AmppControl extends events.EventEmitter {
  private gvPlatform: GVPlatform | null;
  private subscriptions: string[] = [];

  /**
   * constructor
   * @param baseURL url for accessing GV Platform
   * @param apiKey The API Key (must have platform and cluster.readonly scopes)
   * @param pushNotificationConfig Configuration for Push Notifications
   */
  constructor(baseURL: string, apiKey: string, pushNotificationConfig?: PushNotificationConfig) {
    super();
    this.gvPlatform = new GVPlatform(baseURL, apiKey, pushNotificationConfig);
  }

  /**
   * login
   * connects and authenticates with GVPlatform
   */
  async login(): Promise<boolean> {
    return this.gvPlatform.login();
  }

  /**
   * listApplicationTypes
   * uses AMPP Control API to get a list of applicationTypes
   */
  async listApplicationTypes(): Promise<string[]> {
    let res: AxiosResponse;

    try {
      res = await this.gvPlatform.get('/ampp/control/api/v1/control/application/references');
    } catch (err) {
      throw new Error('listApplicationTypes() error' + err);
    }

    const apps: [] = res.data;
    return apps.map(({ name }) => name);
  }

  /**
   * listWorkloadsForApplicationType
   * uses AMPP Control API to get a list all workloads for a specific application
   */
  async listWorkloadsForApplicationType(application: string): Promise<string[]> {
    let res: AxiosResponse;

    const url = `ampp/control/api/v1/control/application/${application}/workloads`;

    try {
      res = await this.gvPlatform.get(url);
    } catch (err) {
      throw new Error('listWorkloadsForApplicationType() error' + err);
    }

    return res.data;
  }

  /**
   * listWorkloadNamesForApplicationType
   * uses AMPP Control API to get a list all workloads for a specific application
   */
  async listWorkloadNamesForApplicationType(application: string): Promise<string[]> {
    let res: AxiosResponse;

    const url = `ampp/control/api/v1/control/application/${application}/workloadnames`;

    try {
      res = await this.gvPlatform.get(url);
    } catch (err) {
      throw new Error('listWorkloadNamesForApplicationType() error' + err);
    }

    return res.data;
  }


  /**
   * getWorkload
   * uses AMPP Cluster API to get workload data
   */
  async getWorkload(workload_id: string): Promise<string[]> {
    let res: AxiosResponse;

    const url = `cluster/state/api/v1/workload/${workload_id}?includeHistory=false`

    try {
      res = await this.gvPlatform.get(url);
    } catch (err) {
      throw new Error('getWorkload() error' + err);
    }

    return res.data;
  }

  /**
   * getApplicationConfig
   * uses AMPP Mocha API to get application configuration data
   */
  async getApplicationConfig(workloadId: string): Promise<unknown> {
    let res: AxiosResponse;

    const url = `/mocha/application/${workloadId}/api/v1/app/config`;

    try {
      res = await this.gvPlatform.get(url);
    } catch (err) {
      throw new Error('getApplicationConfig() error' + err);
    }

    return res.data;
  }

  /**
   * getApplicationState
   * uses AMPP Mocha API to get application state data
   */
  async getApplicationState(workloadId: string): Promise<unknown> {
    let res: AxiosResponse;

    const url = `/mocha/application/${workloadId}/api/v1/app/state`;

    try {
      res = await this.gvPlatform.get(url);
    } catch (err) {
      throw new Error('getApplicationState() error' + err);
    }

    if (res.data === '') {
      return null;
    }

    return res.data;
  }

  /**
   * listChildWorkloads
   * uses AMPP Cluster API to get a list all child workloads of a given parent workload ID
   */
  async listChildWorkloads(workload_id: string): Promise<any> {
    let res: AxiosResponse;

    const url = `cluster/state/api/v1/workloads?parentId=${workload_id}&includeHistory=false`

    try {
      res = await this.gvPlatform.get(url);
    } catch (err) {
      throw new Error('listChildWorkloads() error' + err);
    }

    return res.data;
  }


  /**
   * getControlSchemasForApplication
   * uses AMPP Control API to get a list all schema versions for a specific application
   */
  async getControlSchemasForApplication(application: string): Promise<[]> {
    let res: AxiosResponse;

    const url = `ampp/control/api/v1/control/application/${application}/schemaversions`;

    try {
      res = await this.gvPlatform.get(url);
    } catch (err) {
      throw new Error('getControlSchemasForApplication() error' + err);
    }

    return res.data;
  }

  /**
   * listMacros
   * uses AMPP Control API to get a list all Macros
   */
  async listMacros(): Promise<IAmppControlMacro[]> {
    let res: AxiosResponse;

    const url = `ampp/control/api/v1/macro`;

    try {
      res = await this.gvPlatform.get(url);
    } catch (err) {
      throw new Error('listMacros() error' + err);
    }

    const macros: IAmppControlMacro[] = res.data;
    return macros;
  }

  /**
   * executeMacro
   * uses AMPP Control API to execute a Macro
   * @param uuid - Unique identifier of Macro
   * @param reconKey - Key to indicate source of request. Returned in AMPP Control commands
   * @returns a value indicating success
   */
  async executeMacro(uuid: string, reconKey: string): Promise<boolean> {
    let res: AxiosResponse;

    const url = `ampp/control/api/v1/macro/execute`;

    try {
      res = await this.gvPlatform.post(url, { uuid, reconKey });
    } catch (err) {
      throw new Error('executeMacro() error' + err);
    }

    return res.status == 204;
  }

  /**
   * sendAmppControlMessage
   * uses AMPP Control API to send and AMPP Control message
   * @param workload - The workloadId to send message to
   * @param application - The Application type (not actually needed, can pass any)
   * @param command - The AMPP control command to execute
   * @param payload - an object containing the payload for the command
   * @param reconKey - a string that will be passed back in any notify or status response
   * @returns a value indicating whether command has been sent
   */
  async sendAmppControlMessage(
    workload: string,
    application: string,
    command: string,
    payload: any,
    reconKey: string,
  ): Promise<boolean> {
    let res: AxiosResponse;

    let url: string = `ampp/control/api/v1/control/commit`;

    const data = {
      application,
      command,
      workload,
      reconKey,
      FormData: JSON.stringify(payload),
    };

    try {
      res = await this.gvPlatform.post(url, data);
    } catch (err) {
      throw new Error('sendAmppControlMessage() error' + err);
    }

    return res.status == 204;
  }

  /**
   * pushAmppControlMessage
   * uses SignalR connection to send an Ampp Control message
   * @param workload - The workloadId to send message to
   * @param application - The Application type (not actually needed, can pass any)
   * @param command - The AMPP control command to execute
   * @param payload - an object containing the payload for the command
   * @param reconKey - a string that will be passed back in any notify or status response
   * @returns a value indicating whether command has been sent
   */
  async pushAmppControlMessage(
    workload: string,
    application: string,
    command: string,
    payload: any,
    reconKey: string,
  ): Promise<boolean> {
    const topic: string = `gv.ampp.control.${workload}.${command}`;

    const content = {
      Key: reconKey,
      Payload: payload,
    };

    return await this.gvPlatform.publishNotification(topic, content);
  }

  /* NOT USED...? */
  async pushProgramControlState(
    workload: string,
    application: string,
    index: number,
    reconKey: string,
  ): Promise<boolean> {
    return this.pushAmppControlMessage(
      workload,
      application,
      'controlstate',
      { Index: index, Program: true },
      reconKey,
    );
  }

  /**
   * getState
   * A wrapper for the sendAmppControlMessage() function that sends the getstate command
   * @param workload - The workloadId to send message to
   * @param reconKey - a string that will be passed back in any notify or status response
   * @returns a value indicating that the notification has been raised successfully
   */
  async getState(workload: string, reconKey: string): Promise<boolean> {
    return this.sendAmppControlMessage(workload, 'any', 'getstate', {}, reconKey);
  }

  /**
   * startNotificationListener
   * Opens the Connection to the SignalR connection on the PushNotifications Service
   * And starts listening for push notifications
   * You must subscribe to topics to get events. see subscribeToNotification
   * @returns a value indicating whether the connection has been established correctly
   */
  async startNotificationListener(): Promise<boolean> {
    this.gvPlatform.on('notification', this.onNotification);
    this.gvPlatform.on('reconnected', this.resubscribeNotifications.bind(this));
    return this.gvPlatform.startNotificationListener();
  }

  /**
   * subscribeToNotification
   * @param topic the topic to listen to notifications on
   * For AMPP Control these are of the format `gv.ampp.control.{workloadId}.{command}.notify
   */
  async subscribeToNotification(topic: string) {
    await this.gvPlatform.subscribeToNotification(topic);

    if (!this.subscriptions.includes(topic)) {
      this.subscriptions.push(topic);
    }
  }

  /**
   * publishRawNotification
   * Publishes a raw AMPP platform notification. Used for non-AMPP-Control
   * protocols such as the WebRTC signaling messages used by Flow Monitor.
   */
  async publishRawNotification(topic: string, content: any): Promise<boolean> {
    webRtcDebugLog('[VNR WebRTC SDK] publishRawNotification request', {
      topic,
      contentSummary: this.summarizeNotificationContent(content),
      subscribedTopics: this.subscriptions,
      hasSignalConnection: Boolean(this.gvPlatform?.signal),
    });

    try {
      const sent = await this.gvPlatform.publishNotification(topic, content);

      webRtcDebugLog('[VNR WebRTC SDK] publishRawNotification response', {
        topic,
        sent,
      });

      return sent;
    } catch (err) {
      console.error('[VNR WebRTC SDK] publishRawNotification error', {
        topic,
        error: err instanceof Error ? err.message : err,
      });

      throw err;
    }
  }

  /**
   * publishRawNotificationHttp
   * Publishes a raw AMPP platform notification through the HTTP Notifications API.
   * This mirrors the AMPP web UI path more closely than SignalR PublishNotification.
   * sourceWorkloadId is used to match the AMPP UI's Mocha notification source format.
   */
  async publishRawNotificationHttp(topic: string, content: any, sourceWorkloadId?: string): Promise<{
    sent: boolean;
    status: number;
    statusText: string;
    topic: string;
  }> {
    if (!this.gvPlatform) {
      throw new Error('AMPP platform client is not initialized');
    }

    const contentJson = JSON.stringify(content);
    const source = sourceWorkloadId
      ? `/mocha/application/${sourceWorkloadId}`
      : 'VNR WebRTC';

    const notification = {
      id: randomUUID(),
      time: DateTime.utc().toISO(),
      topic,
      source,
      ttl: 30000,
      content: contentJson,
      contentType: 'application/json',
      contentLength: Buffer.byteLength(contentJson, 'utf8'),
      context: {
        correlationId: this.gvPlatform.correlationId,
      },
    };

    webRtcDebugLog('[VNR WebRTC SDK] publishRawNotificationHttp request', {
      url: '/notifications/api/v1/notifications',
      topic,
      notificationId: notification.id,
      source,
      contentSummary: this.summarizeNotificationContent(content),
      notificationSummary: this.summarizeNotificationContent(notification),
      subscribedTopics: this.subscriptions,
    });

    try {
      const response = await this.gvPlatform.post('/notifications/api/v1/notifications', notification);
      const sent = response.status >= 200 && response.status < 300;

      webRtcDebugLog('[VNR WebRTC SDK] publishRawNotificationHttp response', {
        topic,
        sent,
        status: response.status,
        statusText: response.statusText,
        dataSummary: this.summarizeNotificationContent(response.data),
      });

      return {
        sent,
        status: response.status,
        statusText: response.statusText,
        topic,
      };
    } catch (err: any) {
      console.error('[VNR WebRTC SDK] publishRawNotificationHttp error', {
        topic,
        status: err?.response?.status,
        statusText: err?.response?.statusText,
        responseDataSummary: this.summarizeNotificationContent(err?.response?.data),
        error: err instanceof Error ? err.message : err,
      });

      throw err;
    }
  }


  /**
   * createMailbox
   * Creates the Notifications API mailbox before subscribing it to topics.
   * AMPP returns 404 on mailbox topic subscription if this mailbox does not exist yet.
   */
  async createMailbox(mailboxId: string): Promise<{
    created: boolean;
    status: number;
    statusText: string;
    mailboxId: string;
    secret?: string;
  }> {
    if (!this.gvPlatform) {
      throw new Error('AMPP platform client is not initialized');
    }

    const requestBody = {
      id: mailboxId,
      subscription: 'gv',
      durable: false,
      maximumLength: 10000,
      mailboxTTL: 1500000,
    };

    webRtcDebugLog('[VNR WebRTC SDK] createMailbox request', {
      url: '/notifications/api/v1/mailbox',
      mailboxId,
      requestSummary: this.summarizeNotificationContent(requestBody),
    });

    try {
      const response = await this.gvPlatform.post('/notifications/api/v1/mailbox', requestBody);
      const created = response.status >= 200 && response.status < 300;

      webRtcDebugLog('[VNR WebRTC SDK] createMailbox response', {
        mailboxId,
        created,
        status: response.status,
        statusText: response.statusText,
        responseMailboxId: response.data?.id,
        responseSubscription: response.data?.subscription,
        hasSecret: Boolean(response.data?.secret),
        dataSummary: this.summarizeNotificationContent(response.data),
      });

      return {
        created,
        status: response.status,
        statusText: response.statusText,
        mailboxId: response.data?.id ?? mailboxId,
        secret: response.data?.secret,
      };
    } catch (err: any) {
      console.error('[VNR WebRTC SDK] createMailbox error', {
        mailboxId,
        status: err?.response?.status,
        statusText: err?.response?.statusText,
        responseDataSummary: this.summarizeNotificationContent(err?.response?.data),
        error: err instanceof Error ? err.message : err,
      });

      throw err;
    }
  }


  /**
   * subscribeMailboxToNotification
   * Subscribes a Notifications API mailbox to one topic so mailbox polling can
   * receive WebRTC signaling replies using the same receive path as the AMPP UI.
   */
  async subscribeMailboxToNotification(mailboxId: string, topic: string): Promise<{
    subscribed: boolean;
    status: number;
    statusText: string;
    mailboxId: string;
    topic: string;
  }> {
    if (!this.gvPlatform) {
      throw new Error('AMPP platform client is not initialized');
    }

    const url = `/notifications/api/v1/mailbox/${encodeURIComponent(mailboxId)}/subscribe/${encodeURIComponent(topic)}`;

    webRtcDebugLog('[VNR WebRTC SDK] subscribeMailboxToNotification request', {
      url,
      mailboxId,
      topic,
    });

    try {
      const response = await this.gvPlatform.post(url, null);
      const subscribed = response.status >= 200 && response.status < 300;

      webRtcDebugLog('[VNR WebRTC SDK] subscribeMailboxToNotification response', {
        mailboxId,
        topic,
        subscribed,
        status: response.status,
        statusText: response.statusText,
        dataSummary: this.summarizeNotificationContent(response.data),
      });

      return {
        subscribed,
        status: response.status,
        statusText: response.statusText,
        mailboxId,
        topic,
      };
    } catch (err: any) {
      console.error('[VNR WebRTC SDK] subscribeMailboxToNotification error', {
        mailboxId,
        topic,
        status: err?.response?.status,
        statusText: err?.response?.statusText,
        responseDataSummary: this.summarizeNotificationContent(err?.response?.data),
        error: err instanceof Error ? err.message : err,
      });

      throw err;
    }
  }

  /**
   * pollMailboxNotifications
   * Long-polls the Notifications API mailbox and returns any platform
   * notifications delivered for the mailbox's subscribed topics.
   */
  async pollMailboxNotifications(mailboxId: string, count = 1000, timeout = 10000): Promise<{
    status: number;
    statusText: string;
    mailboxId: string;
    notifications: IPlatformNotification[];
  }> {
    if (!this.gvPlatform) {
      throw new Error('AMPP platform client is not initialized');
    }

    const url = `/notifications/api/v1/notifications/${encodeURIComponent(mailboxId)}`;

    try {
      const response = await this.gvPlatform.get(url, { count, timeout });
      const notifications = this.extractPlatformNotifications(response.data);

      if (notifications.length > 0) {
        webRtcDebugLog('[VNR WebRTC SDK] pollMailboxNotifications response', {
          mailboxId,
          notificationCount: notifications.length,
          topics: notifications.map((notification) => notification.topic),
          dataSummary: this.summarizeNotificationContent(response.data),
        });
      }

      return {
        status: response.status,
        statusText: response.statusText,
        mailboxId,
        notifications,
      };
    } catch (err: any) {
      console.error('[VNR WebRTC SDK] pollMailboxNotifications error', {
        mailboxId,
        status: err?.response?.status,
        statusText: err?.response?.statusText,
        responseDataSummary: this.summarizeNotificationContent(err?.response?.data),
        error: err instanceof Error ? err.message : err,
      });

      throw err;
    }
  }

  /**
   * resubscribeNotifications
   * Subscribes to all topics that have been previously subscribed to
   */
  public async resubscribeNotifications() {
    await Promise.all(
      this.subscriptions.map(async (subscription: string) => {
        await this.gvPlatform.subscribeToNotification(subscription);
        console.log('Resubscribing to', subscription);
      }),
    );
  }

  private onNotification = (notification: IPlatformNotification) => {
    notificationDebugLog('[AMPP notifications] platform notification received', notification);

    webRtcDebugLog('[VNR WebRTC SDK] raw SignalR notification received', {
      topic: notification.topic,
      account: notification.account,
      source: notification.source,
      time: notification.time,
      correlationId: notification.correlationId,
      ttl: notification.ttl,
      subscribedTopics: this.subscriptions,
      exactSubscriptionMatch: this.subscriptions.includes(notification.topic),
      webRtcReceiverTopic: notification.topic.startsWith('gv.webrtc.'),
      webRtcStatsTopic: /\.senders\.[^.]+\.stats$/.test(notification.topic),
      amppControlNotifyTopic: notification.topic.endsWith('notify'),
      amppControlStatusTopic: notification.topic.endsWith('status'),
      contentSummary: this.summarizeNotificationContent(notification.content),
    });

    this.emit('raw-notification', notification);

    let content: any;

    try {
      content = typeof notification.content === 'string'
        ? JSON.parse(notification.content)
        : notification.content;
    } catch {
      webRtcDebugWarn('[VNR WebRTC SDK] raw SignalR notification content could not be parsed as JSON', {
        topic: notification.topic,
        contentType: typeof notification.content,
      });
      return;
    }

    if (notification.topic.endsWith('notify')) {
      let amppControlResponse: IAmppControlNotification = {
        topic: notification.topic,
        payload: content.payload ?? content.Payload,
        reconKey: content.key ?? content.Key,
      };

      this.emit('notify', amppControlResponse);
    } else if (notification.topic.endsWith('status')) {
      let errorNotification: IAmppControlError = {
        topic: notification.topic,
        reconKey: content.key,
        status: content.status,
        error: content.error,
        details: content.details,
      };
      this.emit('status', errorNotification);
    }
  };


  /**
   * extractPlatformNotifications
   * Normalizes possible mailbox poll response shapes into a flat list of AMPP
   * platform notifications.
   */
  private extractPlatformNotifications(data: any): IPlatformNotification[] {
    const candidateLists = [
      data,
      data?.notifications,
      data?.items,
      data?.results,
      data?.value,
    ];

    for (const candidateList of candidateLists) {
      if (Array.isArray(candidateList)) {
        return candidateList
          .map((item) => item?.notification ?? item)
          .filter((item) => item?.topic) as IPlatformNotification[];
      }
    }

    if (data?.notification?.topic) {
      return [data.notification] as IPlatformNotification[];
    }

    if (data?.topic) {
      return [data] as IPlatformNotification[];
    }

    return [];
  }

  private summarizeNotificationContent(content: any) {
    if (content === null || content === undefined) {
      return { valueType: typeof content };
    }

    const contentType = typeof content;

    if (contentType === 'string') {
      const contentString = content as string;

      try {
        const parsedContent = JSON.parse(contentString);

        return {
          valueType: contentType,
          rawLength: contentString.length,
          parsed: true,
          parsedSummary: this.summarizeNotificationContentObject(parsedContent),
        };
      } catch {
        return {
          valueType: contentType,
          rawLength: contentString.length,
          parsed: false,
          preview: this.truncateForLog(contentString),
        };
      }
    }

    if (contentType === 'object') {
      return this.summarizeNotificationContentObject(content);
    }

    return {
      valueType: contentType,
      value: content,
    };
  }

  private summarizeNotificationContentObject(content: any) {
    const signalContent = content as {
      type?: string;
      sdpType?: string;
      tunnelId?: string;
      receiverTopic?: string;
      senderId?: string;
      id?: string;
      key?: string;
      status?: string | number;
      error?: string;
      details?: string;
      payload?: unknown;
      sdp?: string;
      fullSdp?: string;
      description?: { sdp?: string };
      candidate?: string | object;
      iceCandidate?: object;
      iceServers?: unknown[];
      senders?: unknown[];
      results?: unknown[];
    };

    return {
      valueType: 'object',
      keys: Object.keys(content),
      type: signalContent.type,
      sdpType: signalContent.sdpType,
      tunnelId: signalContent.tunnelId,
      receiverTopic: signalContent.receiverTopic,
      senderId: signalContent.senderId ?? signalContent.id,
      key: signalContent.key,
      status: signalContent.status,
      error: signalContent.error,
      details: signalContent.details,
      hasPayload: signalContent.payload !== undefined,
      hasSdp: Boolean(signalContent.sdp || signalContent.fullSdp || signalContent.description?.sdp),
      sdpLength: signalContent.sdp?.length ?? signalContent.fullSdp?.length ?? signalContent.description?.sdp?.length ?? 0,
      hasCandidate: Boolean(signalContent.candidate || signalContent.iceCandidate),
      candidateType: typeof signalContent.candidate,
      iceServerCount: signalContent.iceServers?.length ?? 0,
      sendersCount: signalContent.senders?.length ?? 0,
      resultsCount: signalContent.results?.length ?? 0,
      preview: this.truncateForLog(this.redactLargeWebRtcFields(content)),
    };
  }

  private redactLargeWebRtcFields(content: any) {
    try {
      return JSON.stringify(content, (key, value) => {
        if (key.toLowerCase().includes('token')) {
          return '[redacted token]';
        }

        if (key.toLowerCase().includes('credential')) {
          return '[redacted credential]';
        }

        if (key === 'sdp' || key === 'fullSdp') {
          return `[redacted SDP length=${typeof value === 'string' ? value.length : 0}]`;
        }

        if (key === 'candidate' && typeof value === 'string') {
          return `[redacted ICE candidate length=${value.length}]`;
        }

        return value;
      });
    } catch {
      return '[unserializable content]';
    }
  }

  private truncateForLog(value: string, maxLength = 1000) {
    if (value.length <= maxLength) {
      return value;
    }

    return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`;
  }
}
