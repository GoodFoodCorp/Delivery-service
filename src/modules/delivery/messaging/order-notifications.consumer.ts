import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as amqp from 'amqplib';
import { DeliveryGateway } from '../delivery.gateway';
import { ORDER_EVENTS_EXCHANGE } from './order-ready.event';
import { orderNotifications } from './order-notifications';

const QUEUE = 'delivery.notifications';
const RECONNECT_DELAY_MS = 5000;

/**
 * Turns every order event into live notifications (Socket.IO rooms, shared
 * by every replica through Redis). A notification is only useful now: a
 * message that cannot be read is dropped, and the queue keeps an hour at most.
 */
@Injectable()
export class OrderNotificationsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderNotificationsConsumer.name);
  private connection: amqp.ChannelModel | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly gateway: DeliveryGateway) {}

  onModuleInit(): void {
    if (!process.env.RABBITMQ_URL) {
      this.logger.warn('RABBITMQ_URL not set: order notifications disabled');
      return;
    }
    void this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.connection?.close().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    try {
      const connection = await amqp.connect(process.env.RABBITMQ_URL as string);
      this.connection = connection;
      connection.on('error', (err) => this.logger.warn(`rabbitmq connection error: ${err.message}`));
      connection.on('close', () => this.scheduleReconnect());

      const channel = await connection.createChannel();
      channel.on('error', (err) => this.logger.error(`rabbitmq channel error: ${err.message}`));
      await channel.assertExchange(ORDER_EVENTS_EXCHANGE, 'topic', { durable: true });
      await channel.assertQueue(QUEUE, { durable: true, arguments: { 'x-message-ttl': 3_600_000 } });
      await channel.bindQueue(QUEUE, ORDER_EVENTS_EXCHANGE, 'order.*');
      await channel.prefetch(50);

      await channel.consume(QUEUE, (msg) => {
        if (!msg) return;
        try {
          for (const { target, notification } of orderNotifications(msg.content)) {
            this.gateway.emitNotification(target, notification);
          }
        } catch (err) {
          this.logger.warn(`order notification dropped: ${(err as Error).message}`);
        }
        channel.ack(msg);
      });
      this.logger.log(`consuming ${QUEUE}`);
    } catch (err) {
      this.logger.warn(`rabbitmq unavailable: ${(err as Error).message}`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.connection = null;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RECONNECT_DELAY_MS);
  }
}
