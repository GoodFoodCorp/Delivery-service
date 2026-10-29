import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as amqp from 'amqplib';
import {
  ORDER_EVENTS_EXCHANGE,
  ORDER_READY_DLQ,
  ORDER_READY_QUEUE,
  ORDER_ROUTING_KEYS,
} from './order-ready.event';
import { OrderReadyHandler } from './order-ready.handler';

const RECONNECT_DELAY_MS = 5000;

/**
 * Consumes order.ready_for_pickup and order.cancelled from RabbitMQ. Starts in the background so
 * the service boots even when the broker is down, and reconnects on loss.
 * Messages that cannot be processed are rejected without requeue and land in
 * the dead-letter queue.
 */
@Injectable()
export class OrderReadyConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderReadyConsumer.name);
  private connection: amqp.ChannelModel | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly handler: OrderReadyHandler) {}

  onModuleInit(): void {
    if (!process.env.RABBITMQ_URL) {
      this.logger.warn('RABBITMQ_URL not set: order-ready consumer disabled (REST sync only)');
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
      // Sans listener, une erreur de canal (ex. queue déjà déclarée avec d'autres
      // arguments) serait levée comme exception non gérée et ferait tomber le service.
      channel.on('error', (err) => this.logger.error(`rabbitmq channel error: ${err.message}`));
      await channel.assertExchange(ORDER_EVENTS_EXCHANGE, 'topic', { durable: true });
      await channel.assertQueue(ORDER_READY_DLQ, { durable: true });
      await channel.assertQueue(ORDER_READY_QUEUE, {
        durable: true,
        arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': ORDER_READY_DLQ },
      });
      for (const key of ORDER_ROUTING_KEYS) {
        await channel.bindQueue(ORDER_READY_QUEUE, ORDER_EVENTS_EXCHANGE, key);
      }
      await channel.prefetch(10);

      await channel.consume(ORDER_READY_QUEUE, async (msg) => {
        if (!msg) return;
        try {
          await this.handler.handle(msg.content);
          channel.ack(msg);
        } catch (err) {
          this.logger.error(`order-ready message rejected to DLQ: ${(err as Error).message}`);
          channel.nack(msg, false, false);
        }
      });
      this.logger.log(`consuming ${ORDER_READY_QUEUE}`);
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
