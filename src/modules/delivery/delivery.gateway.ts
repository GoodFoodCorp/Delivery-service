import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Actor, verifyToken } from '../../common/auth.util';
import { DomainError } from '../../common/errors';
import { DeliveryService } from './delivery.service';
import { SubscribeDto } from './dto/subscribe.dto';
import { UpdatePositionDto } from './dto/update-position.dto';

interface AuthedSocket extends Socket {
  data: { actor?: Actor };
}

/**
 * Real-time tracking namespace. The gateway only authenticates, validates
 * and routes — every rule lives in DeliveryService.
 *
 * Client protocol:
 *  - connect to /tracking with `auth: { token }` (or Authorization header)
 *  - courier emits  `position:update`   { deliveryId, lat, lng }
 *  - watchers emit  `delivery:subscribe`{ deliveryId } then receive
 *    `position:broadcast` events for that delivery.
 */
@WebSocketGateway({ namespace: 'tracking', cors: { origin: true, credentials: true } })
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class DeliveryGateway implements OnGatewayConnection {
  private readonly logger = new Logger(DeliveryGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(private readonly deliveries: DeliveryService) {}

  handleConnection(client: AuthedSocket): void {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      client.handshake.headers.authorization?.replace(/^Bearer /, '');
    try {
      client.data.actor = verifyToken(token ?? '');
    } catch {
      client.emit('error', { error: 'unauthorized' });
      client.disconnect(true);
      return;
    }
    this.logger.log(`ws connected: ${client.data.actor.userId}`);
  }

  // Plain return values are delivered through the Socket.IO ack callback.

  @SubscribeMessage('delivery:subscribe')
  async subscribe(@ConnectedSocket() client: AuthedSocket, @MessageBody() body: SubscribeDto) {
    const actor = client.data.actor!;
    if (!(await this.deliveries.canWatch(actor, body.deliveryId))) {
      return { ok: false, error: 'not allowed to watch this delivery' };
    }
    await client.join(this.room(body.deliveryId));
    return { ok: true, deliveryId: body.deliveryId };
  }

  @SubscribeMessage('position:update')
  async updatePosition(@ConnectedSocket() client: AuthedSocket, @MessageBody() body: UpdatePositionDto) {
    const actor = client.data.actor!;
    try {
      const position = await this.deliveries.recordPosition(actor, body.deliveryId, body.lat, body.lng);
      this.server.to(this.room(body.deliveryId)).emit('position:broadcast', position);
      return { ok: true, position };
    } catch (err) {
      const message = err instanceof DomainError ? err.message : 'internal error';
      return { ok: false, error: message };
    }
  }

  private room(deliveryId: string): string {
    return `delivery:${deliveryId}`;
  }
}
