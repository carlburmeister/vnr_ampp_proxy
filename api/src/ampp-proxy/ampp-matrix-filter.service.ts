import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SessionData } from 'express-session';

import type { AmppCookieHttpResponse } from './ampp-cookie-http.service';

const MATRIX_RESPONSE_KEYS: Record<string, string> = {
  '/cluster/matrix/api/v1/producers': 'producers',
  '/cluster/matrix/api/v1/consumers': 'consumers',
  '/cluster/matrix/api/v1/routing/sources': 'sources',
  '/cluster/matrix/api/v1/routing/destinations': 'destinations',
};
const MATRIX_TOPIC_PREFIX = 'gv.cluster.matrix.';
const MATRIX_NOTIFICATION_PATH = /^\/notifications\/api\/v1\/notifications\/[^/]+$/i;
const MATRIX_PRODUCER_PATH = /^\/cluster\/matrix\/api\/v1\/producer\/[^/]+$/i;
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const FABRIC_MATRIX_TOPIC = new RegExp(
  `^gv\\.cluster\\.matrix\\.(${UUID_PATTERN})\\.(makeroute|routemade|flowschanged)$`,
  'i',
);
const MAX_MESSAGEPACK_DEPTH = 32;

type MatrixNotificationResult = {
  content: Record<string, unknown>;
  unchanged: boolean;
};

@Injectable()
export class AmppMatrixFilterService {
  private readonly platformUrl: URL;

  constructor(config: ConfigService) {
    this.platformUrl = new URL(config.getOrThrow<string>('PLATFORM_URL'));
  }

  isProducerIdAllowed(session: SessionData, id: string): boolean {
    return this.getCachedIds(session, 'producerIds').has(id.toLowerCase());
  }

  isConsumerIdAllowed(session: SessionData, id: string): boolean {
    return this.getCachedIds(session, 'consumerIds').has(id.toLowerCase());
  }

  isProducerNameAllowed(
    session: SessionData,
    name: string,
    fabricId?: string,
  ): boolean {
    const access = fabricId
      ? [session.amppMatrixAccess?.[fabricId.toLowerCase()]]
      : Object.values(session.amppMatrixAccess ?? {});

    return access.some(
      (item) => item && Object.values(item.producerNames ?? {}).includes(name),
    );
  }

  filterApiResponse(
    session: SessionData,
    upstreamPath: string,
    response: AmppCookieHttpResponse,
  ): AmppCookieHttpResponse {
    const target = new URL(upstreamPath, this.platformUrl);
    const pathname = target.pathname.replace(/\/+$/, '').toLowerCase();
    const responseKey = MATRIX_RESPONSE_KEYS[pathname];

    if (responseKey) {
      return this.filterMatrixResponse(session, target, response, responseKey);
    }

    if (MATRIX_PRODUCER_PATH.test(target.pathname)) {
      return this.filterProducerResponse(session, response);
    }

    if (MATRIX_NOTIFICATION_PATH.test(target.pathname)) {
      return this.filterNotificationResponse(session, response);
    }

    return response;
  }

  filterWebSocketMessage(
    session: SessionData,
    data: Buffer,
  ): Buffer | undefined {
    if (!data.toString('utf8').toLowerCase().includes(MATRIX_TOPIC_PREFIX)) {
      return data;
    }

    let messages: Buffer[];

    try {
      messages = this.readBinaryHubMessages(data);
    } catch {
      return undefined;
    }

    const allowedMessages = messages.filter((message) =>
      this.isAllowedHubMessage(session, message),
    );

    if (!allowedMessages.length) {
      return undefined;
    }

    if (allowedMessages.length === messages.length) {
      return data;
    }

    return Buffer.concat(
      allowedMessages.flatMap((message) => [
        this.writeLengthPrefix(message.length),
        message,
      ]),
    );
  }

  private filterMatrixResponse(
    session: SessionData,
    target: URL,
    response: AmppCookieHttpResponse,
    responseKey: string,
  ): AmppCookieHttpResponse {
    if (response.status < 200 || response.status >= 300) {
      return response;
    }

    const fabricId = target.searchParams.get('fabricId')?.toLowerCase();

    if (!fabricId) {
      throw new BadGatewayException('AMPP Matrix response is missing fabricId');
    }

    let parsed: Record<string, unknown>;

    try {
      parsed = JSON.parse(response.body.toString('utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      throw new BadGatewayException('AMPP Matrix response is not valid JSON');
    }

    const items = parsed[responseKey];

    if (!Array.isArray(items)) {
      throw new BadGatewayException(
        `AMPP Matrix response is missing ${responseKey}`,
      );
    }

    const allowedWorkloadIds = this.getAllowedWorkloadIds(session);
    const fabricAccess = this.getFabricAccess(session, fabricId);
    let filteredItems: unknown[];

    if (responseKey === 'producers') {
      filteredItems = items.flatMap((item) => {
        const wrapper = this.asObject(item);
        const producer = this.asObject(wrapper?.producer);

        if (!producer || !this.isAllowedEntity(producer, allowedWorkloadIds)) {
          return [];
        }

        const routedConsumers = Array.isArray(producer.routedConsumers)
          ? producer.routedConsumers.filter((consumer) => {
              const routedConsumer = this.asObject(consumer);
              return (
                !!routedConsumer &&
                this.isAllowedEntity(routedConsumer, allowedWorkloadIds)
              );
            })
          : [];
        const filteredProducer = {
          ...producer,
          ...(Array.isArray(producer.routedConsumers)
            ? { routedConsumers }
            : {}),
          ...(producer.routedConsumerIds !== undefined
            ? {
                routedConsumerIds: routedConsumers.flatMap((consumer) => {
                  const id = this.asObject(consumer)?.id;
                  return typeof id === 'string' ? [id] : [];
                }),
              }
            : {}),
        };

        return [{ ...wrapper, producer: filteredProducer }];
      });
      fabricAccess.producerIds = this.getWrappedIds(filteredItems, 'producer');
      fabricAccess.producerNames = this.getWrappedNames(
        filteredItems,
        'producer',
      );
    } else if (responseKey === 'consumers') {
      const producerIds = this.getIdSet(fabricAccess.producerIds);

      filteredItems = items.flatMap((item) => {
        const wrapper = this.asObject(item);
        const consumer = this.asObject(wrapper?.consumer);

        if (!consumer || !this.isAllowedEntity(consumer, allowedWorkloadIds)) {
          return [];
        }

        return [
          {
            ...wrapper,
            consumer: this.filterConsumerRelations(consumer, producerIds).value,
          },
        ];
      });
      fabricAccess.consumerIds = this.getWrappedIds(filteredItems, 'consumer');
    } else if (responseKey === 'sources') {
      const producerIds = this.getIdSet(fabricAccess.producerIds);
      const consumerIds = this.getIdSet(fabricAccess.consumerIds);

      filteredItems = items.flatMap((item) => {
        const source = this.asObject(item);
        const id = source?.id;

        if (
          !source ||
          typeof id !== 'string' ||
          !producerIds.has(id.toLowerCase())
        ) {
          return [];
        }

        return [
          {
            ...source,
            ...(Array.isArray(source.destinationIds)
              ? {
                  destinationIds: source.destinationIds.filter(
                    (destinationId) =>
                      typeof destinationId === 'string' &&
                      consumerIds.has(destinationId.toLowerCase()),
                  ),
                }
              : {}),
          },
        ];
      });
    } else {
      const producerIds = this.getIdSet(fabricAccess.producerIds);
      const consumerIds = this.getIdSet(fabricAccess.consumerIds);

      filteredItems = items.flatMap((item) => {
        const destination = this.asObject(item);
        const id = destination?.id;

        if (
          !destination ||
          typeof id !== 'string' ||
          !consumerIds.has(id.toLowerCase())
        ) {
          return [];
        }

        return [
          {
            ...destination,
            ...(typeof destination.sourceId === 'string' &&
            !producerIds.has(destination.sourceId.toLowerCase())
              ? { sourceId: null }
              : {}),
          },
        ];
      });
    }

    return this.replaceJsonBody(response, {
      ...parsed,
      [responseKey]: filteredItems,
    });
  }

  private filterProducerResponse(
    session: SessionData,
    response: AmppCookieHttpResponse,
  ): AmppCookieHttpResponse {
    if (response.status < 200 || response.status >= 300) {
      return response;
    }

    let producer: Record<string, unknown>;

    try {
      producer = JSON.parse(response.body.toString('utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      throw new BadGatewayException('AMPP Matrix producer response is not valid JSON');
    }

    if (!this.isAllowedEntity(producer, this.getAllowedWorkloadIds(session))) {
      throw new BadGatewayException('AMPP Matrix producer response is not allowed');
    }

    const fabricId = producer.fabricId;

    if (typeof fabricId !== 'string') {
      throw new BadGatewayException('AMPP Matrix producer response is missing fabricId');
    }

    const filtered = this.filterProducerRelations(
      producer,
      this.getIdSet(this.getFabricAccess(session, fabricId).consumerIds),
    );

    return this.replaceJsonBody(response, filtered.value);
  }

  private filterNotificationResponse(
    session: SessionData,
    response: AmppCookieHttpResponse,
  ): AmppCookieHttpResponse {
    if (response.status < 200 || response.status >= 300) {
      return response;
    }

    if (response.status === 204) {
      return response;
    }

    let notifications: unknown;

    try {
      notifications = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new BadGatewayException(
        'AMPP notification response is not valid JSON',
      );
    }

    if (!Array.isArray(notifications)) {
      throw new BadGatewayException('AMPP notification response is not an array');
    }

    const filtered = notifications.flatMap((notification) => {
      const item = this.asObject(notification);
      const topic = item?.topic;

      if (
        !item ||
        typeof topic !== 'string' ||
        !topic.toLowerCase().startsWith(MATRIX_TOPIC_PREFIX)
      ) {
        return [notification];
      }

      const content = this.parseNotificationContent(item.content);

      if (!content) {
        return [];
      }

      const result = this.filterMatrixNotification(session, topic, content);

      return result
        ? [
            {
              ...item,
              content: JSON.stringify(result.content),
            },
          ]
        : [];
    });

    return this.replaceJsonBody(response, filtered);
  }

  private isAllowedHubMessage(session: SessionData, message: Buffer): boolean {
    const strings: string[] = [];

    try {
      this.collectMessagePackStrings(message, strings, 0);
    } catch {
      return false;
    }

    const matrixTopics = strings.filter((value) =>
      value.toLowerCase().startsWith(MATRIX_TOPIC_PREFIX),
    );

    if (!matrixTopics.length) {
      return true;
    }

    return matrixTopics.every((topic) => {
      const topicIndex = strings.indexOf(topic);

      for (let index = topicIndex + 1; index < strings.length; index += 1) {
        if (strings[index].toLowerCase().startsWith(MATRIX_TOPIC_PREFIX)) {
          break;
        }

        const content = this.parseNotificationContent(strings[index]);

        if (!content) {
          continue;
        }

        const result = this.filterMatrixNotification(session, topic, content);
        return !!result?.unchanged;
      }

      return false;
    });
  }

  private filterMatrixNotification(
    session: SessionData,
    topic: string,
    content: Record<string, unknown>,
  ): MatrixNotificationResult | undefined {
    const normalizedTopic = topic.toLowerCase();
    const allowedWorkloadIds = this.getAllowedWorkloadIds(session);
    const allowedFabricIds = this.getAllowedFabricIds(session);

    if (normalizedTopic.startsWith('gv.cluster.matrix.producer.')) {
      return this.filterEntityNotification(
        session,
        content,
        'producer',
        allowedWorkloadIds,
        allowedFabricIds,
      );
    }

    if (normalizedTopic.startsWith('gv.cluster.matrix.consumer.')) {
      return this.filterEntityNotification(
        session,
        content,
        'consumer',
        allowedWorkloadIds,
        allowedFabricIds,
      );
    }

    const fabricTopic = FABRIC_MATRIX_TOPIC.exec(topic);

    if (!fabricTopic) {
      return undefined;
    }

    const fabricId = fabricTopic[1].toLowerCase();
    const event = fabricTopic[2].toLowerCase();

    if (!allowedFabricIds.has(fabricId)) {
      return undefined;
    }

    const fabricAccess = this.getFabricAccess(session, fabricId);
    const producerIds = this.getIdSet(fabricAccess.producerIds);
    const consumerIds = this.getIdSet(fabricAccess.consumerIds);

    if (event === 'routemade') {
      const sourceId = content.sourceId;
      const destinationId = content.destinationId;

      if (
        (sourceId !== null &&
          (typeof sourceId !== 'string' ||
            !producerIds.has(sourceId.toLowerCase()))) ||
        typeof destinationId !== 'string' ||
        !consumerIds.has(destinationId.toLowerCase())
      ) {
        return undefined;
      }

      return { content, unchanged: true };
    }

    if (event === 'flowschanged') {
      return this.filterEntityNotification(
        session,
        content,
        'producer',
        allowedWorkloadIds,
        allowedFabricIds,
      );
    }

    const producer = this.asObject(content.producer);
    const consumer = this.asObject(content.consumer);

    if (
      !producer ||
      !consumer ||
      !this.isAllowedEntity(producer, allowedWorkloadIds, allowedFabricIds) ||
      !this.isAllowedEntity(consumer, allowedWorkloadIds, allowedFabricIds)
    ) {
      return undefined;
    }

    const producerId = producer.id;
    const consumerId = consumer.id;

    if (typeof producerId === 'string') {
      this.addId(fabricAccess.producerIds ??= [], producerId);
      if (typeof producer.name === 'string') {
        (fabricAccess.producerNames ??= {})[producerId.toLowerCase()] =
          producer.name;
      }
    }

    if (typeof consumerId === 'string') {
      this.addId(fabricAccess.consumerIds ??= [], consumerId);
    }

    const filteredProducer = this.filterProducerRelations(
      producer,
      this.getIdSet(fabricAccess.consumerIds),
    );
    const filteredConsumer = this.filterConsumerRelations(
      consumer,
      this.getIdSet(fabricAccess.producerIds),
    );

    return {
      content: {
        ...content,
        producer: filteredProducer.value,
        consumer: filteredConsumer.value,
      },
      unchanged: filteredProducer.unchanged && filteredConsumer.unchanged,
    };
  }

  private filterEntityNotification(
    session: SessionData,
    content: Record<string, unknown>,
    entityKey: 'producer' | 'consumer',
    allowedWorkloadIds: Set<string>,
    allowedFabricIds: Set<string>,
  ): MatrixNotificationResult | undefined {
    const entity = this.asObject(content[entityKey]);

    if (
      !entity ||
      !this.isAllowedEntity(entity, allowedWorkloadIds, allowedFabricIds)
    ) {
      return undefined;
    }

    const fabricId = entity.fabricId;

    if (typeof fabricId !== 'string') {
      return undefined;
    }

    const fabricAccess = this.getFabricAccess(session, fabricId.toLowerCase());
    const filtered =
      entityKey === 'producer'
        ? this.filterProducerRelations(
            entity,
            this.getIdSet(fabricAccess.consumerIds),
          )
        : this.filterConsumerRelations(
            entity,
            this.getIdSet(fabricAccess.producerIds),
          );
    const id = entity.id;
    const action =
      typeof content.action === 'string' ? content.action.toLowerCase() : '';
    const ids =
      entityKey === 'producer'
        ? (fabricAccess.producerIds ??= [])
        : (fabricAccess.consumerIds ??= []);

    if (typeof id === 'string') {
      if (['deleted', 'removed'].includes(action)) {
        this.removeId(ids, id);
        if (entityKey === 'producer') {
          delete fabricAccess.producerNames?.[id.toLowerCase()];
        }
      } else {
        this.addId(ids, id);
        if (entityKey === 'producer' && typeof entity.name === 'string') {
          (fabricAccess.producerNames ??= {})[id.toLowerCase()] = entity.name;
        }
      }
    }

    return {
      content: { ...content, [entityKey]: filtered.value },
      unchanged: filtered.unchanged,
    };
  }

  private filterProducerRelations(
    producer: Record<string, unknown>,
    consumerIds: Set<string>,
  ): { value: Record<string, unknown>; unchanged: boolean } {
    let unchanged = true;
    const routedConsumers = Array.isArray(producer.routedConsumers)
      ? producer.routedConsumers.filter((consumer) => {
          const id = this.asObject(consumer)?.id;
          const allowed =
            typeof id === 'string' && consumerIds.has(id.toLowerCase());
          unchanged &&= allowed;
          return allowed;
        })
      : undefined;
    const routedConsumerIds = Array.isArray(producer.routedConsumerIds)
      ? producer.routedConsumerIds.filter((id) => {
          const allowed =
            typeof id === 'string' && consumerIds.has(id.toLowerCase());
          unchanged &&= allowed;
          return allowed;
        })
      : undefined;

    return {
      value: {
        ...producer,
        ...(routedConsumers ? { routedConsumers } : {}),
        ...(routedConsumerIds ? { routedConsumerIds } : {}),
      },
      unchanged,
    };
  }

  private filterConsumerRelations(
    consumer: Record<string, unknown>,
    producerIds: Set<string>,
  ): { value: Record<string, unknown>; unchanged: boolean } {
    const routedProducerId = consumer.routedProducerId;

    if (
      typeof routedProducerId !== 'string' ||
      producerIds.has(routedProducerId.toLowerCase())
    ) {
      return { value: consumer, unchanged: true };
    }

    return {
      value: { ...consumer, routedProducerId: null },
      unchanged: false,
    };
  }

  private isAllowedEntity(
    entity: Record<string, unknown>,
    allowedWorkloadIds: Set<string>,
    allowedFabricIds?: Set<string>,
  ): boolean {
    const workloadId = entity.workloadId;
    const fabricId = entity.fabricId;

    return (
      typeof workloadId === 'string' &&
      allowedWorkloadIds.has(workloadId.toLowerCase()) &&
      (!allowedFabricIds ||
        (typeof fabricId === 'string' &&
          allowedFabricIds.has(fabricId.toLowerCase())))
    );
  }

  private getAllowedWorkloadIds(session: SessionData): Set<string> {
    return new Set(
      (
        session.amppAllowedWorkloadIds ??
        (session.allowedWorkloads ?? []).flatMap((workload) => [
          workload.id,
          ...(workload.child_workloads ?? []).map(
            (childWorkload) => childWorkload.id,
          ),
        ])
      )
        .filter(Boolean)
        .map((id) => id.toLowerCase()),
    );
  }

  private getAllowedFabricIds(session: SessionData): Set<string> {
    return new Set(
      (session.allowedWorkloads ?? [])
        .flatMap((workload) => [
          workload.fabricId,
          ...(workload.child_workloads ?? []).map(
            (childWorkload) => childWorkload.fabricId,
          ),
        ])
        .filter((id): id is string => typeof id === 'string' && !!id)
        .map((id) => id.toLowerCase()),
    );
  }

  private getFabricAccess(session: SessionData, fabricId: string) {
    const matrixAccess = (session.amppMatrixAccess ??= {});
    return (matrixAccess[fabricId.toLowerCase()] ??= {});
  }

  private getWrappedIds(items: unknown[], key: string): string[] {
    return items.flatMap((item) => {
      const id = this.asObject(this.asObject(item)?.[key])?.id;
      return typeof id === 'string' ? [id] : [];
    });
  }

  private getWrappedNames(
    items: unknown[],
    key: string,
  ): Record<string, string> {
    return Object.fromEntries(
      items.flatMap((item) => {
        const entity = this.asObject(this.asObject(item)?.[key]);
        const id = entity?.id;
        const name = entity?.name;

        return typeof id === 'string' && typeof name === 'string'
          ? [[id.toLowerCase(), name] as const]
          : [];
      }),
    );
  }

  private getCachedIds(
    session: SessionData,
    key: 'producerIds' | 'consumerIds',
  ): Set<string> {
    return new Set(
      Object.values(session.amppMatrixAccess ?? {}).flatMap((access) =>
        (access[key] ?? []).map((id) => id.toLowerCase()),
      ),
    );
  }

  private getIdSet(ids: string[] | undefined): Set<string> {
    return new Set((ids ?? []).map((id) => id.toLowerCase()));
  }

  private addId(ids: string[], id: string): void {
    if (!ids.some((value) => value.toLowerCase() === id.toLowerCase())) {
      ids.push(id);
    }
  }

  private removeId(ids: string[], id: string): void {
    const normalizedId = id.toLowerCase();

    for (let index = ids.length - 1; index >= 0; index -= 1) {
      if (ids[index].toLowerCase() === normalizedId) {
        ids.splice(index, 1);
      }
    }
  }

  private parseNotificationContent(
    value: unknown,
  ): Record<string, unknown> | undefined {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }

    if (typeof value !== 'string' || !value.trimStart().startsWith('{')) {
      return undefined;
    }

    try {
      return this.asObject(JSON.parse(value));
    } catch {
      return undefined;
    }
  }

  private replaceJsonBody(
    response: AmppCookieHttpResponse,
    value: unknown,
  ): AmppCookieHttpResponse {
    return {
      ...response,
      headers: {
        ...response.headers,
        'content-length': undefined,
        etag: undefined,
        'last-modified': undefined,
      },
      body: Buffer.from(JSON.stringify(value)),
    };
  }

  private readBinaryHubMessages(data: Buffer): Buffer[] {
    const messages: Buffer[] = [];
    let offset = 0;

    while (offset < data.length) {
      let size = 0;
      let shift = 0;
      let byte: number;

      do {
        if (offset >= data.length || shift > 28) {
          throw new Error('Invalid SignalR message length');
        }

        byte = data[offset++];
        size |= (byte & 0x7f) << shift;
        shift += 7;
      } while ((byte & 0x80) !== 0);

      if (size < 0 || offset + size > data.length) {
        throw new Error('Invalid SignalR message length');
      }

      messages.push(data.subarray(offset, offset + size));
      offset += size;
    }

    return messages;
  }

  private writeLengthPrefix(size: number): Buffer {
    const bytes: number[] = [];
    let value = size;

    do {
      let byte = value & 0x7f;
      value >>>= 7;

      if (value) {
        byte |= 0x80;
      }

      bytes.push(byte);
    } while (value);

    return Buffer.from(bytes);
  }

  private collectMessagePackStrings(
    data: Buffer,
    strings: string[],
    depth: number,
  ): void {
    let offset = 0;

    while (offset < data.length) {
      offset = this.readMessagePackValue(data, offset, strings, depth);
    }
  }

  private readMessagePackValue(
    data: Buffer,
    offset: number,
    strings: string[],
    depth: number,
  ): number {
    if (depth > MAX_MESSAGEPACK_DEPTH || offset >= data.length) {
      throw new Error('Invalid MessagePack payload');
    }

    const type = data[offset++];

    if (type <= 0x7f || type >= 0xe0) {
      return offset;
    }

    if (type >= 0xa0 && type <= 0xbf) {
      return this.readMessagePackString(data, offset, type & 0x1f, strings);
    }

    if (type >= 0x90 && type <= 0x9f) {
      return this.readMessagePackValues(
        data,
        offset,
        type & 0x0f,
        strings,
        depth + 1,
      );
    }

    if (type >= 0x80 && type <= 0x8f) {
      return this.readMessagePackValues(
        data,
        offset,
        (type & 0x0f) * 2,
        strings,
        depth + 1,
      );
    }

    switch (type) {
      case 0xc0:
      case 0xc2:
      case 0xc3:
        return offset;
      case 0xc4:
        return this.skipBytes(data, offset + 1, this.readUInt(data, offset, 1));
      case 0xc5:
        return this.skipBytes(data, offset + 2, this.readUInt(data, offset, 2));
      case 0xc6:
        return this.skipBytes(data, offset + 4, this.readUInt(data, offset, 4));
      case 0xca:
        return this.skipBytes(data, offset, 4);
      case 0xcb:
        return this.skipBytes(data, offset, 8);
      case 0xcc:
      case 0xd0:
        return this.skipBytes(data, offset, 1);
      case 0xcd:
      case 0xd1:
        return this.skipBytes(data, offset, 2);
      case 0xce:
      case 0xd2:
        return this.skipBytes(data, offset, 4);
      case 0xcf:
      case 0xd3:
        return this.skipBytes(data, offset, 8);
      case 0xd9: {
        const length = this.readUInt(data, offset, 1);
        return this.readMessagePackString(data, offset + 1, length, strings);
      }
      case 0xda: {
        const length = this.readUInt(data, offset, 2);
        return this.readMessagePackString(data, offset + 2, length, strings);
      }
      case 0xdb: {
        const length = this.readUInt(data, offset, 4);
        return this.readMessagePackString(data, offset + 4, length, strings);
      }
      case 0xdc: {
        const count = this.readUInt(data, offset, 2);
        return this.readMessagePackValues(
          data,
          offset + 2,
          count,
          strings,
          depth + 1,
        );
      }
      case 0xdd: {
        const count = this.readUInt(data, offset, 4);
        return this.readMessagePackValues(
          data,
          offset + 4,
          count,
          strings,
          depth + 1,
        );
      }
      case 0xde: {
        const count = this.readUInt(data, offset, 2);
        return this.readMessagePackValues(
          data,
          offset + 2,
          count * 2,
          strings,
          depth + 1,
        );
      }
      case 0xdf: {
        const count = this.readUInt(data, offset, 4);
        return this.readMessagePackValues(
          data,
          offset + 4,
          count * 2,
          strings,
          depth + 1,
        );
      }
      case 0xc7:
        return this.readMessagePackExtension(data, offset, 1, strings, depth);
      case 0xc8:
        return this.readMessagePackExtension(data, offset, 2, strings, depth);
      case 0xc9:
        return this.readMessagePackExtension(data, offset, 4, strings, depth);
      case 0xd4:
        return this.readFixedMessagePackExtension(data, offset, 1, strings, depth);
      case 0xd5:
        return this.readFixedMessagePackExtension(data, offset, 2, strings, depth);
      case 0xd6:
        return this.readFixedMessagePackExtension(data, offset, 4, strings, depth);
      case 0xd7:
        return this.readFixedMessagePackExtension(data, offset, 8, strings, depth);
      case 0xd8:
        return this.readFixedMessagePackExtension(data, offset, 16, strings, depth);
      default:
        throw new Error('Unsupported MessagePack type');
    }
  }

  private readMessagePackValues(
    data: Buffer,
    offset: number,
    count: number,
    strings: string[],
    depth: number,
  ): number {
    let nextOffset = offset;

    for (let index = 0; index < count; index += 1) {
      nextOffset = this.readMessagePackValue(
        data,
        nextOffset,
        strings,
        depth,
      );
    }

    return nextOffset;
  }

  private readMessagePackString(
    data: Buffer,
    offset: number,
    length: number,
    strings: string[],
  ): number {
    const end = this.skipBytes(data, offset, length);
    strings.push(data.toString('utf8', offset, end));
    return end;
  }

  private readMessagePackExtension(
    data: Buffer,
    offset: number,
    lengthBytes: number,
    strings: string[],
    depth: number,
  ): number {
    const length = this.readUInt(data, offset, lengthBytes);
    return this.readMessagePackExtensionData(
      data,
      offset + lengthBytes,
      length,
      strings,
      depth,
    );
  }

  private readFixedMessagePackExtension(
    data: Buffer,
    offset: number,
    length: number,
    strings: string[],
    depth: number,
  ): number {
    return this.readMessagePackExtensionData(
      data,
      offset,
      length,
      strings,
      depth,
    );
  }

  private readMessagePackExtensionData(
    data: Buffer,
    offset: number,
    length: number,
    strings: string[],
    depth: number,
  ): number {
    const type = this.readUInt(data, offset, 1);
    const start = offset + 1;
    const end = this.skipBytes(data, start, length);

    if (type === 4) {
      this.collectMessagePackStrings(data.subarray(start, end), strings, depth + 1);
    }

    return end;
  }

  private readUInt(data: Buffer, offset: number, bytes: number): number {
    if (offset + bytes > data.length) {
      throw new Error('Invalid MessagePack payload');
    }

    return bytes === 1
      ? data.readUInt8(offset)
      : bytes === 2
        ? data.readUInt16BE(offset)
        : data.readUInt32BE(offset);
  }

  private skipBytes(data: Buffer, offset: number, bytes: number): number {
    const end = offset + bytes;

    if (end > data.length) {
      throw new Error('Invalid MessagePack payload');
    }

    return end;
  }

  private asObject(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }
}
