import { Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import fs from 'fs';
import path from 'path';
import { Observable, Subject } from 'rxjs';

import { KeyframesClient } from '../sdk/KeyframesClient';

import type { SessionData } from 'express-session';

export type KeyframeEvent = {
  producerName: string;
  imageUrl: string;
  timestamp: string;
};

@Injectable()
export class KeyframesService implements OnModuleDestroy {
  private readonly keyframeEvents$ = new Subject<KeyframeEvent>();
  private readonly latestKeyframeByProducer = new Map<string, KeyframeEvent>();
  private keyframesClient?: KeyframesClient;
  private keyframesProducerName?: string;
  private readonly keyframesOutputDir = path.join(process.cwd(), 'keyframes');

  constructor(private readonly config: ConfigService) {}

  /*---------------------------------------------------------------------------------------------------
  //  keyframeEvents()
  ----------------------------------------------------------------------------------------------------*/
  keyframeEvents(
    producerName?: string,
    userSession?: SessionData,
  ): Observable<KeyframeEvent> {
    
    //const allowedWorkloads = userSession?.allowedWorkloads ?? [];

    return new Observable<KeyframeEvent>((subscriber) => {
      const sub = this.keyframeEvents$.subscribe((event) => {
        if (!producerName || event.producerName === producerName) {
          subscriber.next(event);
        }
      });

      return () => sub.unsubscribe();
    });
  }
  /*---------------------------------------------------------------------------------------------------
  //  getLatestKeyframeForProducer()
  ----------------------------------------------------------------------------------------------------*/
  async getLatestKeyframeForProducer(producerName: string, userSession?: SessionData,) {
    if (!producerName?.trim()) {
      throw new Error('producerName is required');
    }

    const latest = this.latestKeyframeByProducer.get(producerName);

    if (!latest) {
      return {
        producerName,
        imageUrl: '',
        timestamp: new Date().toISOString(),
      };
    }

    return latest;
  }
  /*---------------------------------------------------------------------------------------------------
  //  getLatestKeyframeImagePath()
  ----------------------------------------------------------------------------------------------------*/
  async getLatestKeyframeImagePath(producerName: string, userSession?: SessionData,) {
    if (!producerName?.trim()) {
      throw new Error('producerName is required');
    }

    const filePath = path.join(
      this.keyframesOutputDir,
      `${this.sanitizeProducerName(producerName)}.jpg`,
    );

    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('No keyframe image has been received yet');
    }

    return filePath;
  }
  /*---------------------------------------------------------------------------------------------------
  //  startKeyframesListener()
  ----------------------------------------------------------------------------------------------------*/
  async startKeyframesListener(
    producerName: string,
    userSession: SessionData,
  ) {
    const platformUrl = this.config.getOrThrow<string>('PLATFORM_URL');
    const apiKey = this.config.getOrThrow<string>('API_KEY');
    
    const fabricId = userSession.fabricId;
    const nodeId = userSession.nodeId;

    fs.mkdirSync(this.keyframesOutputDir, { recursive: true });

    if (!this.keyframesClient || this.keyframesProducerName !== producerName) {
      if (this.keyframesClient) {
        await this.keyframesClient.stopKeyframesSubscriptionAsync();
      }

      this.keyframesClient = new KeyframesClient(
        platformUrl,
        apiKey,
        this.keyframesOutputDir,
      );
      this.keyframesProducerName = producerName;
      this.keyframesClient.setProducerName(producerName);

      this.keyframesClient.on('keyframe', () => {
        const timestamp = new Date().toISOString();
        const imageUrl = `/api/ampp/keyframes/producers/${encodeURIComponent(producerName)}/image/latest?t=${encodeURIComponent(timestamp)}`;
        const event = { producerName, imageUrl, timestamp };

        this.latestKeyframeByProducer.set(producerName, event);
        this.keyframeEvents$.next(event);
      });

      await this.keyframesClient.login();
      await this.keyframesClient.startNotificationListener();

      const producer = await this.keyframesClient.getProducerAsync(
        fabricId,
        producerName,
      );
      const flowId = producer?.producer?.stream?.flows?.find(
        (f) => f.dataType === 'Pic',
      )?.flowId;

      if (!flowId) {
        throw new Error('Unable to resolve keyframe flowId for producer');
      }

      this.keyframesClient.addKeyframesSubscription(nodeId, flowId);
      await this.keyframesClient.startKeyframesSubscriptionAsync();
    }

    return {
      started: true,
      producerName,
    };
  }
  /*---------------------------------------------------------------------------------------------------
  //  sanitizeProducerName()
  ----------------------------------------------------------------------------------------------------*/
  private sanitizeProducerName(producerName: string) {
    return producerName.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  async onModuleDestroy() {
    this.keyframeEvents$.complete();

    if (this.keyframesClient) {
      await this.keyframesClient.stopKeyframesSubscriptionAsync();
    }
  }
}
