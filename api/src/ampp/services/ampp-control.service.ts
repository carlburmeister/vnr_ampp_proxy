// api/src/ampp/services/ampp-control.service.ts
import {
  BadRequestException,
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { Observable, Subject } from 'rxjs';

import {
  AmppControl,
} from '../sdk/AmppControl';

import {
  IAmppControlError,
  IAmppControlNotification,
  IPlatformNotification,
} from '../sdk/Model';

import type { AmppChildWorkloadsResponse } from '../types/workload_types';

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

type AmppControlEvent =
  | { type: 'notify'; data: IAmppControlNotification }
  | { type: 'status'; data: IAmppControlError }
  | { type: 'raw-notification'; data: IPlatformNotification };

type WebRtcSessionDetails = {
  workloadId: string;
  engineInstanceId: string;
  tunnelId: string;
  receiverTopic: string;
  discoveryTopic: string;
  senderTopic: string;
  statsTopic: string;
};

@Injectable()
export class AmppControlService implements OnModuleDestroy 
{
  private client?: AmppControl;
  private clientLoginPromise?: Promise<AmppControl>;

  private readonly notificationEvents$ = new Subject<AmppControlEvent>();
  private readonly webRtcSignalEvents$ = new Subject<IPlatformNotification>();
  private notificationListenerStarted = false;
  private notificationHandlersAttached = false;
  private readonly webRtcMailboxId = `vnr-webrtc--${randomUUID()}`;
  private webRtcMailboxCreated = false;
  private webRtcMailboxCreatePromise?: Promise<{
    created: boolean;
    status: number;
    statusText: string;
    mailboxId: string;
    secret?: string;
  }>;
  private readonly webRtcMailboxTopics = new Set<string>();
  private webRtcMailboxPollingStarted = false;
  private webRtcMailboxPollingStopped = false;
  private webRtcMailboxPollPromise?: Promise<void>;

  constructor(private readonly config: ConfigService) {}

  /*--------------------------------------------------------------------------*/
  //
  /*--------------------------------------------------------------------------*/
  private async getClient(): Promise<AmppControl> {
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
  /*--------------------------------------------------------------------------*/
  //
  /*--------------------------------------------------------------------------*/
  private async createLoggedInClient(): Promise<AmppControl> {
    const platformUrl = this.config.getOrThrow<string>('PLATFORM_URL');
    const apiKey = this.config.getOrThrow<string>('API_KEY');

    const client = new AmppControl(platformUrl, apiKey);
    await client.login();

    return client;
  }
  /*--------------------------------------------------------------------------*/
  //
  /*--------------------------------------------------------------------------*/
  async listApplicationTypes(): Promise<string[]> {
    const client = await this.getClient();
    return client.listApplicationTypes();
  }
  /*--------------------------------------------------------------------------*/
  //
  /*--------------------------------------------------------------------------*/
  async listWorkloadsForApplicationType(
    applicationName: string,
  ): Promise<string[]> {
    const client = await this.getClient();
    return client.listWorkloadsForApplicationType(applicationName);
  }
  /*--------------------------------------------------------------------------*/
  //
  /*--------------------------------------------------------------------------*/
  async listWorkloadNamesForApplicationType(
    applicationName: string,
  ): Promise<string[]> {
    const client = await this.getClient();
    return client.listWorkloadNamesForApplicationType(applicationName);
  }
  /*--------------------------------------------------------------------*/
  //  getWorkload()
  /*--------------------------------------------------------------------*/
  async getWorkload(
    workloadId: string,
  ): Promise<string[]> {
    const client = await this.getClient();
    return client.getWorkload(workloadId);
  }
  /*--------------------------------------------------------------------------*/
  //  getApplicationConfig()
  /*--------------------------------------------------------------------------*/
  async getApplicationConfig(workloadId: string): Promise<unknown> {
    const client = await this.getClient();
    const config = await client.getApplicationConfig(workloadId);

    console.log('[AMPP] application configuration JSON', workloadId, JSON.stringify(config, null, 2));

    return config;
  }
  /*--------------------------------------------------------------------------*/
  //  getApplicationState()
  /*--------------------------------------------------------------------------*/
  async getApplicationState(workloadId: string): Promise<unknown> {
    const client = await this.getClient();
    const state = await client.getApplicationState(workloadId);

    console.log('[AMPP] application state JSON', workloadId, JSON.stringify(state, null, 2));

    return state;
  }
  /*--------------------------------------------------------------------*/
  //  listChildWorkloads()
  /*--------------------------------------------------------------------*/
  async listChildWorkloads(
    workloadId: string,
  ): Promise<AmppChildWorkloadsResponse> {
    webRtcDebugLog('[VNR WebRTC backend] listChildWorkloads request', {
      workloadId,
    });

    const client = await this.getClient();
    const response = await client.listChildWorkloads(workloadId);

    webRtcDebugLog('[VNR WebRTC backend] listChildWorkloads response', {
      workloadId,
      childWorkloadCount: response.workloads?.length ?? 0,
      childWorkloads: response.workloads?.map((item) => ({
        id: item.workload?.id,
        name: item.workload?.name,
        packageName: item.workload?.packageName,
        state: item.workload?.state?.state,
      })) ?? [],
    });

    return response;
  }
  /*--------------------------------------------------------------------------*/
  //
  /*--------------------------------------------------------------------------*/
  async getControlSchemasForApplication(
    applicationName: string,
  ): Promise<string[]> {
    const client = await this.getClient();
    return client.getControlSchemasForApplication(applicationName);
  }
  /*--------------------------------------------------------------------------*/
  //
  /*--------------------------------------------------------------------------*/
  async listMacros() {
    const client = await this.getClient();
    return client.listMacros();
  }
  /*--------------------------------------------------------------------------*/
  //
  /*--------------------------------------------------------------------------*/
  async executeMacro(uuid: string, reconKey = 'vnr_app') {
    const client = await this.getClient();
    return client.executeMacro(uuid, reconKey);
  }
  /*--------------------------------------------------------------------------*/
  //
  /*--------------------------------------------------------------------------*/
  async sendControlMessage(input: {
    workload: string;
    application: string;
    command: string;
    payload: unknown;
    reconKey?: string;
  }) {
    const client = await this.getClient();

    return client.sendAmppControlMessage(
      input.workload,
      input.application,
      input.command,
      input.payload,
      input.reconKey ?? 'vnr_app',
    );
  }
  /*--------------------------------------------------------------------------*/
  //  getState()
  /*--------------------------------------------------------------------------*/
  async getState(input: {
    workloadId?: string;
    reconKey?: string;
  }) {
    if (!input.workloadId?.trim()) {
      throw new Error('workloadId is required');
    }

    const client = await this.getClient();
    await client.getState(input.workloadId, input.reconKey ?? 'vnr_app');

    return { sent: true };
  }
  /*--------------------------------------------------------------------------*/
  //  sendProgramPreviewControlState()
  /*--------------------------------------------------------------------------*/
  async sendProgramPreviewControlState(input: {
    workloadId?: string;
    applicationName?: string;
    index?: number;
    isProgram?: boolean;
    isPreview?: boolean;
  }) {
    if (!input.workloadId?.trim()) {
      throw new Error('workloadId is required');
    }
    if (!input.applicationName?.trim()) {
      throw new Error('applicationName is required');
    }
    if (typeof input.index !== 'number') {
      throw new Error('index is required');
    }

    const client = await this.getClient();

    await client.pushAmppControlMessage(
      input.workloadId,
      input.applicationName,
      'controlstate',
      { Index: input.index, Program: input.isProgram, Preview: input.isPreview },
      'vnr_app',
    );

    return { sent: true, index: input.index };
  }
  /*--------------------------------------------------------------------------*/
  //  sendKeyState()
  /*--------------------------------------------------------------------------*/
  async sendKeyState(input: {
    workloadId?: string;
    applicationName?: string;
    transitionType?: string;
    active?: boolean;
  }) {
    if (!input.workloadId?.trim()) {
      throw new Error('workloadId is required');
    }
    if (!input.applicationName?.trim()) {
      throw new Error('applicationName is required');
    }
    if (typeof input.transitionType !== 'string') {
      throw new Error('transitionType is required');
    }
    if (typeof input.active !== 'boolean') {
      throw new Error('active parameter is required');
    }

    const client = await this.getClient();

    await client.pushAmppControlMessage(
      input.workloadId,
      input.applicationName,
      'keystate',
      { transitionType: input.transitionType, active: input.active },
      'vnr_app',
    );

    return { sent: true };
  }
  /*--------------------------------------------------------------------------*/
  //
  /*--------------------------------------------------------------------------*/
  notificationEvents(): Observable<AmppControlEvent> {
    return this.notificationEvents$.asObservable();
  }
  /*--------------------------------------------------------------------------*/
  //
  /*--------------------------------------------------------------------------*/
  async startNotificationListener() {
    const client = await this.getClient();

    if (!this.notificationHandlersAttached) {
      client.on('notify', (data: IAmppControlNotification) => {
        notificationDebugLog('[AMPP notifications] notify received', data);

        this.notificationEvents$.next({
          type: 'notify',
          data,
        });
      });

      client.on('status', (data: IAmppControlError) => {
        notificationDebugLog('[AMPP notifications] status received', data);

        this.notificationEvents$.next({
          type: 'status',
          data,
        });
      });

      client.on('raw-notification', (data: IPlatformNotification) => {
        notificationDebugLog('[AMPP notifications] raw received', data);

        if (data.topic.startsWith('gv.ampp.apps.minimixer.') && data.topic.endsWith('.state')) {
          this.notificationEvents$.next({
            type: 'raw-notification',
            data,
          });
        }

        if (
          data.topic.startsWith('gv.webrtc.') ||
          /\.senders\.[^.]+\.stats$/.test(data.topic)
        ) {
          webRtcDebugLog('[VNR WebRTC backend] raw WebRTC notification received', {
            topic: data.topic,
            contentSummary: this.summarizeSignalContent(data.content),
          });

          this.webRtcSignalEvents$.next(data);
        }
      });

      this.notificationHandlersAttached = true;
    }

    if (!this.notificationListenerStarted) {
      webRtcDebugLog('[VNR WebRTC backend] starting AMPP notification listener');

      const started = await client.startNotificationListener();

      if (!started) {
        throw new Error('Failed to start AMPP Control notification listener');
      }

      this.notificationListenerStarted = true;

      webRtcDebugLog('[VNR WebRTC backend] AMPP notification listener started');
    }

    return { started: true };
  }
  /*--------------------------------------------------------------------------*/
  //
  /*--------------------------------------------------------------------------*/
  async subscribeToNotificationTopic(topic: string) {
    const client = await this.getClient();

    webRtcDebugLog('[VNR WebRTC backend] subscribing to notification topic', {
      topic,
    });

    await this.startNotificationListener();
    await client.subscribeToNotification(topic);

    webRtcDebugLog('[VNR WebRTC backend] subscribed to notification topic', {
      topic,
    });

    return {
      subscribed: true,
      topic,
    };
  }

  /**
   * ensureWebRtcMailbox
   * Creates the AMPP Notifications API mailbox once before mailbox topic
   * subscriptions are attempted. Subscribing to a nonexistent mailbox returns 404.
   */
  private async ensureWebRtcMailbox() {
    if (this.webRtcMailboxCreated) {
      return {
        created: true,
        mailboxId: this.webRtcMailboxId,
      };
    }

    if (!this.webRtcMailboxCreatePromise) {
      this.webRtcMailboxCreatePromise = this.createWebRtcMailbox();
    }

    const result = await this.webRtcMailboxCreatePromise;
    this.webRtcMailboxCreated = true;

    return result;
  }

  /**
   * createWebRtcMailbox
   * Calls the SDK mailbox-create method and logs the mailbox ID returned by AMPP.
   */
  private async createWebRtcMailbox() {
    const client = await this.getClient();

    webRtcDebugLog('[VNR WebRTC backend] creating WebRTC mailbox', {
      mailboxId: this.webRtcMailboxId,
    });

    try {
      const result = await client.createMailbox(this.webRtcMailboxId);

      webRtcDebugLog('[VNR WebRTC backend] WebRTC mailbox created', {
        mailboxId: this.webRtcMailboxId,
        responseMailboxId: result.mailboxId,
        status: result.status,
        statusText: result.statusText,
        hasSecret: Boolean(result.secret),
      });

      return result;
    } catch (err) {
      this.webRtcMailboxCreatePromise = undefined;

      console.error('[VNR WebRTC backend] WebRTC mailbox create failed', {
        mailboxId: this.webRtcMailboxId,
        error: err instanceof Error ? err.message : err,
      });

      throw err;
    }
  }

  /**
   * subscribeToWebRtcMailboxTopic
   * Subscribes the backend WebRTC mailbox to a topic and starts the mailbox
   * long-poll receiver used to deliver Flow Monitor signaling messages to SSE.
   */
  private async subscribeToWebRtcMailboxTopic(topic: string) {
    if (this.webRtcMailboxTopics.has(topic)) {
      webRtcDebugLog('[VNR WebRTC backend] mailbox already subscribed to notification topic', {
        mailboxId: this.webRtcMailboxId,
        topic,
      });

      this.startWebRtcMailboxPolling();
      return {
        subscribed: true,
        mailboxId: this.webRtcMailboxId,
        topic,
      };
    }

    const client = await this.getClient();
    await this.ensureWebRtcMailbox();

    webRtcDebugLog('[VNR WebRTC backend] subscribing mailbox to notification topic', {
      mailboxId: this.webRtcMailboxId,
      topic,
    });

    const result = await client.subscribeMailboxToNotification(this.webRtcMailboxId, topic);

    this.webRtcMailboxTopics.add(topic);
    this.startWebRtcMailboxPolling();

    webRtcDebugLog('[VNR WebRTC backend] mailbox subscribed to notification topic', {
      mailboxId: this.webRtcMailboxId,
      topic,
      status: result.status,
      statusText: result.statusText,
    });

    return result;
  }

  /**
   * startWebRtcMailboxPolling
   * Starts one background long-poll loop for the WebRTC mailbox. The loop emits
   * matching mailbox notifications into webRtcSignalEvents$ for the SSE endpoint.
   */
  private startWebRtcMailboxPolling() {
    if (this.webRtcMailboxPollingStarted) {
      return;
    }

    this.webRtcMailboxPollingStarted = true;
    this.webRtcMailboxPollingStopped = false;

    webRtcDebugLog('[VNR WebRTC backend] starting WebRTC mailbox polling', {
      mailboxId: this.webRtcMailboxId,
    });

    this.webRtcMailboxPollPromise = this.pollWebRtcMailbox();
  }

  /**
   * pollWebRtcMailbox
   * Repeatedly long-polls the AMPP Notifications API mailbox and forwards
   * WebRTC receiver-topic and stats-topic messages to the browser SSE stream.
   */
  private async pollWebRtcMailbox() {
    while (!this.webRtcMailboxPollingStopped) {
      try {
        const client = await this.getClient();
        const response = await client.pollMailboxNotifications(this.webRtcMailboxId, 1000, 10000);

        if (response.notifications.length > 0) {
          webRtcDebugLog('[VNR WebRTC backend] mailbox poll received notifications', {
            mailboxId: this.webRtcMailboxId,
            notificationCount: response.notifications.length,
            topics: response.notifications.map((notification) => notification.topic),
          });
        }

        for (const notification of response.notifications) {
          this.handleWebRtcMailboxNotification(notification);
        }
      } catch (err) {
        if (!this.webRtcMailboxPollingStopped) {
          console.error('[VNR WebRTC backend] WebRTC mailbox poll failed', {
            mailboxId: this.webRtcMailboxId,
            error: err instanceof Error ? err.message : err,
          });

          await this.sleep(2000);
        }
      }
    }
  }

  /**
   * handleWebRtcMailboxNotification
   * Filters one mailbox notification and emits matching WebRTC notifications to
   * the same subject used by SignalR notifications.
   */
  private handleWebRtcMailboxNotification(notification: IPlatformNotification) {
    const topic = notification.topic;
    const topicIsSubscribed = this.webRtcMailboxTopics.has(topic);
    const topicLooksWebRtc = topic.startsWith('gv.webrtc.') || /\.senders\.[^.]+\.stats$/.test(topic);

    webRtcDebugLog('[VNR WebRTC backend] mailbox notification received', {
      mailboxId: this.webRtcMailboxId,
      topic,
      topicIsSubscribed,
      topicLooksWebRtc,
      contentSummary: this.summarizeSignalContent(notification.content),
    });

    if (!topicIsSubscribed && !topicLooksWebRtc) {
      webRtcDebugLog('[VNR WebRTC backend] ignoring mailbox notification for unrelated topic', {
        mailboxId: this.webRtcMailboxId,
        topic,
      });
      return;
    }

    this.webRtcSignalEvents$.next(notification);
  }

  /**
   * sleep
   * Pauses the mailbox polling retry loop after a failed long-poll request.
   */
  private sleep(milliseconds: number) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async subscribeToWorkloadNotifications(workload: string) {
    const topic = `gv.ampp.control.${workload}.*.*`;
    const miniMixerStateTopic = `gv.ampp.apps.minimixer.${workload}.state`;

    notificationDebugLog('[AMPP notifications] subscribing to MiniMixer notifications', {
      workload,
      topic,
    });

    await this.subscribeToNotificationTopic(topic);
    await this.subscribeToNotificationTopic(miniMixerStateTopic);

    return {
      subscribed: true,
      topics: [topic, miniMixerStateTopic],
    };
  }

  /*--------------------------------------------------------------------*/
  //  webRtcSignalEvents()
  /*--------------------------------------------------------------------*/
  webRtcSignalEvents(): Observable<IPlatformNotification> {
    return this.webRtcSignalEvents$.asObservable();
  }
  /*--------------------------------------------------------------------*/
  //  startWebRtcSession()
  /*--------------------------------------------------------------------*/
  async startWebRtcSession(input: {
    workloadId?: string;
    engineInstanceId?: string;
  }): Promise<WebRtcSessionDetails> {
    const workloadId = input.workloadId?.trim();
    const engineInstanceId = input.engineInstanceId?.trim();

    if (!workloadId) {
      throw new BadRequestException('workloadId is required');
    }

    if (!engineInstanceId) {
      throw new BadRequestException('engineInstanceId is required');
    }

    webRtcDebugLog('[VNR WebRTC backend] startWebRtcSession request', {
      workloadId,
      engineInstanceId,
    });

    const tunnelId = randomUUID();
    const receiverTopic = `gv.webrtc.${engineInstanceId}.${tunnelId}`;
    const discoveryTopic = `gv.engine.${engineInstanceId}.senders`;
    const senderTopic = `gv.engine.${engineInstanceId}.senders.${workloadId}`;
    const statsTopic = `${senderTopic}.stats`;

    webRtcDebugLog('[VNR WebRTC backend] generated WebRTC signaling topics', {
      workloadId,
      engineInstanceId,
      tunnelId,
      receiverTopic,
      discoveryTopic,
      senderTopic,
      statsTopic,
    });

    await this.subscribeToWebRtcMailboxTopic(receiverTopic);
    await this.subscribeToWebRtcMailboxTopic(statsTopic);

    webRtcDebugLog('[VNR WebRTC backend] WebRTC session ready', {
      workloadId,
      engineInstanceId,
      tunnelId,
    });

    return {
      workloadId,
      engineInstanceId,
      tunnelId,
      receiverTopic,
      discoveryTopic,
      senderTopic,
      statsTopic,
    };
  }
  /*--------------------------------------------------------------------*/
  //  publishWebRtcSignal()
  /*--------------------------------------------------------------------*/
  async publishWebRtcSignal(input: {
    workloadId?: string;
    engineInstanceId?: string;
    topic?: string;
    content?: unknown;
  }) {
    const workloadId = input.workloadId?.trim();
    const engineInstanceId = input.engineInstanceId?.trim();
    const topic = input.topic?.trim();

    if (!workloadId) {
      throw new BadRequestException('workloadId is required');
    }

    if (!engineInstanceId) {
      throw new BadRequestException('engineInstanceId is required');
    }

    if (!topic) {
      throw new BadRequestException('topic is required');
    }

    webRtcDebugLog('[VNR WebRTC backend] publishWebRtcSignal request', {
      workloadId,
      engineInstanceId,
      topic,
      contentSummary: this.summarizeSignalContent(input.content),
    });

    this.assertAllowedWebRtcPublishTopic(topic, workloadId, engineInstanceId);

    const client = await this.getClient();
    const publishResult = await client.publishRawNotificationHttp(topic, input.content ?? {}, workloadId);

    webRtcDebugLog('[VNR WebRTC backend] publishWebRtcSignal result', {
      sent: publishResult.sent,
      topic,
      status: publishResult.status,
      statusText: publishResult.statusText,
    });

    return {
      sent: publishResult.sent,
      topic,
      status: publishResult.status,
      statusText: publishResult.statusText,
    };
  }

  private summarizeSignalContent(content: unknown) {
    if (!content || typeof content !== 'object') {
      return { valueType: typeof content };
    }

    const signalContent = content as {
      type?: string;
      sdpType?: string;
      tunnelId?: string;
      receiverTopic?: string;
      sdp?: string;
      fullSdp?: string;
      description?: { sdp?: string };
      candidate?: string | object;
      iceCandidate?: object;
      senderId?: string;
      id?: string;
      senders?: unknown[];
      results?: unknown[];
      iceServers?: unknown[];
    };

    return {
      type: signalContent.type,
      sdpType: signalContent.sdpType,
      tunnelId: signalContent.tunnelId,
      receiverTopic: signalContent.receiverTopic,
      senderId: signalContent.senderId ?? signalContent.id,
      hasSdp: Boolean(signalContent.sdp || signalContent.fullSdp || signalContent.description?.sdp),
      sdpLength: signalContent.sdp?.length ?? signalContent.fullSdp?.length ?? signalContent.description?.sdp?.length ?? 0,
      hasCandidate: Boolean(signalContent.candidate || signalContent.iceCandidate),
      candidateType: typeof signalContent.candidate,
      iceServerCount: signalContent.iceServers?.length ?? 0,
      sendersCount: signalContent.senders?.length ?? 0,
      resultsCount: signalContent.results?.length ?? 0,
    };
  }

  private assertAllowedWebRtcPublishTopic(
    topic: string,
    workloadId: string,
    engineInstanceId: string,
  ) {
    const discoveryTopic = `gv.engine.${engineInstanceId}.senders`;
    const senderTopic = `gv.engine.${engineInstanceId}.senders.${workloadId}`;

    if (topic !== discoveryTopic && topic !== senderTopic) {
      throw new BadRequestException('Invalid WebRTC signaling topic');
    }
  }

  onModuleDestroy() {
    this.webRtcMailboxPollingStopped = true;
    this.notificationEvents$.complete();
    this.webRtcSignalEvents$.complete();
  }
}
