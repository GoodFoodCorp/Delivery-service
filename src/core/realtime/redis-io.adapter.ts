import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { Server, ServerOptions } from 'socket.io';

/**
 * Socket.IO adapter backed by Redis pub/sub: an event emitted to a room on one
 * replica reaches the sockets connected to every other replica. Without it,
 * a courier connected to replica A never sees a delivery announced by B, so
 * the service could not run more than one instance.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  async connect(url: string): Promise<void> {
    const pub = createClient({ url });
    const sub = pub.duplicate();
    pub.on('error', (err) => this.logger.warn(`redis pub error: ${(err as Error).message}`));
    sub.on('error', (err) => this.logger.warn(`redis sub error: ${(err as Error).message}`));
    await Promise.all([pub.connect(), sub.connect()]);
    this.adapterConstructor = createAdapter(pub, sub);
    this.logger.log('socket.io rooms shared across replicas through redis');
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, {
      ...options,
      // WebSocket only: long-polling would need sticky sessions behind the
      // ingress, and every client (web, mobile) supports WebSocket.
      transports: ['websocket'],
    }) as Server;
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
