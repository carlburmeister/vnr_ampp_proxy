import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { randomUUID } from 'crypto';
import { DateTime } from 'luxon';
import events from 'events';
import * as signalR from '@microsoft/signalr';
import { IPlatformNotification, NotificationEvent, PushNotificationConfig } from './Model';
import { getPushNotificationServiceLocators } from './GVHubConnectionUtils';
import { GVDiscoveryClient } from './GVDiscoveryClient';

const WEBRTC_DEBUG = process.env.WEBRTC_DEBUG === 'true';

function webRtcDebugLog(...args: unknown[]) {
  if (WEBRTC_DEBUG) {
    console.log(...args);
  }
}

/**
 * Class for Accessing AMPP Control Functionality
 */
export class GVPlatform extends events.EventEmitter implements NotificationEvent {
  platformUri: string;
  instance: AxiosInstance;
  discovery: GVDiscoveryClient;
  apiKey: string;
  scopes: string[];
  bearerToken: string;
  notificationConnection: any;
  signal: signalR.HubConnection | null;
  pushNotificationConfig: PushNotificationConfig | null;
  localPushCheckInterval: NodeJS.Timer | null = null;
  awaitingLocalPushConnection: signalR.HubConnection | null = null;
  correlationId: string;
  tokenRefreshTimer: any;

  /**
   * constructor
   * @param baseURL url for accessing GV Platform
   * @param apiKey The API Key (must have platform and cluster.readonly scopes)
   */
  constructor(baseURL: string, apiKey: string, pushNotificationConfig?: PushNotificationConfig) {
    super();
    this.platformUri = baseURL;
    this.apiKey = apiKey;
    this.instance = axios.create({
      baseURL,
    });

    // If using AMMPP Control Only then you only need platform and cluster.readonly scopes
    // this.scopes = ['platform', 'cluster.readonly']
    // However, if you are using the Routing API then you will need the cluster scope
    this.scopes = ['platform', 'platform.readonly', 'cluster', 'cluster.readonly'];

    this.bearerToken = '';
    this.notificationConnection = null;
    this.correlationId = randomUUID();
    this.pushNotificationConfig = pushNotificationConfig;

    this.discovery = new GVDiscoveryClient(this);
  }

  public OnNotification(notification: IPlatformNotification) {
    this.emit('notification', notification);
  }

  /**
   * Schedule a token refresh based on its expiration time
   * The refresh will occur at 75% of expiry time
   * @param token The base64 JWT token
   */
  scheduleTokenRefresh(token: string) {
    const payloadBase64 = token.split('.')[1];
    const decodedJson = Buffer.from(payloadBase64, 'base64').toString();
    const decoded = JSON.parse(decodedJson);

    // Calculate the remaining time until expiration
    const remainingTime = decoded.exp * 1000 - Date.now();

    // Schedule a refresh at 75% of the remaining time
    const sleepTime = 0.75 * remainingTime;

    // Clear the previous timer if it exists
    clearTimeout(this.tokenRefreshTimer);

    // Set up the refresh timer.
    this.tokenRefreshTimer = setTimeout(async () => {
      await this.getToken();
    }, sleepTime);
  }

  /**
   * Obtains a JWT token from the identity service
   * Will schedule a timer to refresh the token before its expiration
   * @returns true if token obtained.
   */
  async getToken(): Promise<boolean> {
    let res: AxiosResponse;

    try {
      res = await this.instance.request({
        data: 'grant_type=client_credentials&scope=' + this.scopes.join(' '),
        headers: {
          Authorization: 'Basic ' + this.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        method: 'POST',
        url: '/identity/connect/token',
      });

      this.bearerToken = res.data.access_token;
      this.scheduleTokenRefresh(this.bearerToken);
    } catch (err) {
      throw new Error('login error' + err);
    }

    return true;
  }

  /**
   * login
   * connects and authenticates with GVPlatform
   */
  async login(): Promise<boolean> {
    return this.getToken();
  }

  /**
   * startNotificationListener
   * Opens the Connection to the SignalR connection on the PushNotifications Service
   * And starts listening for push notifications
   * You must subscribe to topics to get events. see subscribeToNotification
   * @returns a value indicating whether the connection has been established correctly
   */
  async startNotificationListener(): Promise<boolean> {
    try {
      let connection = null;
      let isLocalPush = null;
      if (this.awaitingLocalPushConnection) {
        connection = this.awaitingLocalPushConnection;
        isLocalPush = true;
        this.awaitingLocalPushConnection = null;
      } else {
        const connectionInfo = await this.createHubConnection();
        connection = connectionInfo.connection;
        isLocalPush = connectionInfo.isLocalPush;
      }

      // Add event handler.
      // You must subscribe to topics using subscribeToNotification() to receive notifications
      connection.on('ReceiveNotification', this.onNotification);

      // Test to make sure we are reciving notifications from the Hub
      connection.on('Pong', this.onPong);
      connection.invoke('Ping');

      this.signal = connection;

      // If connected to the cloud push, cyclically check if any local push hub is available
      if (this.pushNotificationConfig?.localPushSiteId && !isLocalPush) {
        this.startCheckingForLocalPushHub();
      } else {
        this.stopCheckingForLocalPushHub();
      }

      return true;
    } catch (err) {
      console.log('error starting SignalR Connection: ', err);
    }

    return false;
  }

  /**
   * subscribeToNotification
   * @param topic the topic to listen to notifications on
   * For AMPP Control these are of the format `gv.ampp.control.{workloadId}.{command}.notify
   */
  async subscribeToNotification(topic: string) {
    const subscriptionRequest = {
      Subscriptions: [topic],
      Context: {
        CorrelationId: this.correlationId,
      },
    };
    await this.signal.invoke('Subscribe', subscriptionRequest);
  }

  async unsubscribeNotification(topic: string) {
    const subscriptionRequest = {
      Subscriptions: [topic],
      Context: {
        CorrelationId: this.correlationId,
      },
    };
    await this.signal.invoke('Unsubscribe', subscriptionRequest);
  }

  private onPong = (account: string) => {
    webRtcDebugLog('pong', account);
  };

  private onNotification = (notification: IPlatformNotification) => {
    this.OnNotification(notification);
  };

  private emitReconnected = () => {
    this.emit('reconnected');
  };

  private emitReconnecting = () => {
    this.emit('reconnecting');
  };

  public async get(url: string, params?: any): Promise<AxiosResponse> {
    let res: AxiosResponse;

    res = await this.instance.request({
      headers: {
        Authorization: 'Bearer ' + this.bearerToken,
      },
      method: 'GET',
      url: url,
      params: params,
    });

    return res;
  }

  public async post(url: string, data: any): Promise<AxiosResponse> {
    let res: AxiosResponse;

    res = await this.instance.request({
      headers: {
        Authorization: 'Bearer ' + this.bearerToken,
      },
      method: 'POST',
      url: url,
      data,
    });

    return res;
  }

  public async put(url: string, data: any): Promise<AxiosResponse> {
    let res: AxiosResponse;

    res = await this.instance.put(url, data, {
      headers: {
        Authorization: 'Bearer ' + this.bearerToken,
        'Content-Type': 'application/json-patch+json',
        'if-match': '"*"',
      },
    });
    return res;
  }

  public async delete(url: string): Promise<AxiosResponse> {
    let res: AxiosResponse;

    res = await this.instance.delete(url, {
      headers: {
        Authorization: 'Bearer ' + this.bearerToken,
      },
    });
    return res;
  }

  /**
   * publishNotification
   * uses SignalR connection to send a notification
   * @returns a value indicating whether command has been sent
   */
  async publishNotification(topic: string, content: any): Promise<boolean> {
    var publishNotification = {
      id: randomUUID(),
      time: DateTime.utc().toISO(),
      topic,
      source: 'AMPP SDK Sample',
      ttl: 30000,
      content: JSON.stringify(content),
      contentType: null,
      contentLength: 0,
      context: {
        correlationId: this.correlationId,
      },
    };

    const response = await this.signal.invoke('PublishNotification', publishNotification);
    return response.isSuccess;
  }

  /**
   * Gets notifications for a given mailbox
   * @param mailboxId The mailbox ID to get
   * @returns A result object containing a list of notifications
   */
  public getNotifications = async (mailboxId: string) => {
    const result = await this.instance.request({
      method: 'get',
      headers: {
        'x-correlation-id': this.correlationId,
      },
      params: {
        count: 100,
        timeout: 10000,
      },
      url: `/notifications/${mailboxId}`,
    });

    return result;
  };

  private async createHubConnection(rejectCloudPush: boolean = false): Promise<{
    connection: signalR.HubConnection;
    isLocalPush: boolean;
  }> {
    const locators = await getPushNotificationServiceLocators(
      this,
      this.platformUri,
      this.pushNotificationConfig?.localPushSiteId,
      this.pushNotificationConfig?.localIpAddress,
      this.pushNotificationConfig?.localSubnetMask,
      rejectCloudPush,
    );

    let connection: signalR.HubConnection = null;
    for (const locator of locators) {
      webRtcDebugLog(`Connecting to pushNotificationsHub at: ${locator.hubUrl}`);
      let connectionBuilder = new signalR.HubConnectionBuilder()
        .withUrl(locator.hubUrl, {
          accessTokenFactory: () => {
            return this.bearerToken;
          },
          skipNegotiation: locator.isLocalPushHub ? true : undefined,
          transport: signalR.HttpTransportType.WebSockets,
        })
        .withAutomaticReconnect({
          nextRetryDelayInMilliseconds: (retryContext) => {
            if (this.pushNotificationConfig?.localPushSiteId) {
              const maxRetryCount = this.pushNotificationConfig?.maxRetryCountAfterLostConnection ?? 3;
              if (retryContext.previousRetryCount >= maxRetryCount) {
                console.log('Max retry count reached, stopping connection');
                return null;
              }
            }
            return this.pushNotificationConfig?.retryIntervalAfterLostConnectionMs ?? 5000;
          },
        })
        .configureLogging(WEBRTC_DEBUG ? signalR.LogLevel.Debug : signalR.LogLevel.None)
        .withHubProtocol(new signalR.JsonHubProtocol());

      try {
        connection = connectionBuilder.build();

        connection.onclose(async () => {
          connection.off('ReceiveNotification', this.onNotification);
          if (this.pushNotificationConfig?.localPushSiteId) {
            this.stopCheckingForLocalPushHub();
            await connection.stop();
            const startNewConnection = async () => {
              let started = false;
              do {
                started = await this.startNotificationListener();
                if (started) {
                  this.emitReconnected();
                } else {
                  await new Promise((resolve) => setTimeout(resolve, 5000));
                }
              } while (!started);
            };
            await startNewConnection();
          } else {
            const start = async () => {
              try {
                await connection.start();
                this.emitReconnected();
              } catch (err) {
                setTimeout(start, 5000);
              }
            };
            await start();
          }
        });

        connection.onreconnecting(() => {
          this.emitReconnecting();
        });

        connection.onreconnected(() => {
          this.emitReconnected();
        });

        await connection.start();

        webRtcDebugLog(`Connected to pushNotificationsHub at: ${locator.hubUrl}`);

        return {
          connection: connection,
          isLocalPush: locator.isLocalPushHub,
        };
      } catch (err) {
        await connection?.stop();
        connection = null;
        console.log(`Error connecting to pushNotificationsHub at: ${locator.hubUrl}`);
      }
    }
    throw new Error('Could not establish any pushNotification connection');
  }

  private startCheckingForLocalPushHub(): void {
    this.localPushCheckInterval = setInterval(async () => {
      try {
        const connectionInfo = await this.createHubConnection(true);
        console.log('Closing cloud push connection and switching to local push');
        this.awaitingLocalPushConnection = connectionInfo.connection;
        await this.signal.stop();
        return;
      } catch (e) {}
    }, this.pushNotificationConfig?.searchForLocalpushIntervalMs ?? 10000);
  }

  private stopCheckingForLocalPushHub(): void {
    if (this.localPushCheckInterval) {
      //clearInterval(this.localPushCheckInterval);
      clearInterval(this.localPushCheckInterval as any);
      this.localPushCheckInterval = null;
    }
  }
}
