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
import { AvailableDeliveryView, DeliveryService } from './delivery.service';
import { SubscribeDto } from './dto/subscribe.dto';
import { UpdatePositionDto } from './dto/update-position.dto';
import { DeliveryDocument } from './entities/delivery.schema';
import { Notification, NotificationTarget } from './messaging/order-notifications';

const COURIERS_ROOM = 'couriers';

interface AuthedSocket extends Socket {
  data: { actor?: Actor };
}

/**
 * Real-time tracking namespace. The gateway only authenticates, validates
 * and routes — every rule lives in DeliveryService. With REDIS_URL set, rooms
 * span every replica (Redis adapter, see main.ts).
 *
 * Client protocol:
 *  - connect to /tracking with `auth: { token }` (or Authorization header)
 *  - couriers receive `delivery:available` (no customer data) and, in their
 *    own room, `delivery:cancelled`
 *  - courier emits  `position:update`   { deliveryId, lat, lng }
 *  - watchers emit  `delivery:subscribe`{ deliveryId } then receive
 *    `position:broadcast` and `delivery:cancelled` for that delivery.
 *  - everyone receives `notification` (order news) in their own room; a
 *    manager also gets their restaurant's.
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
      const actor = verifyToken(token ?? '');
      client.data.actor = actor;
      const rooms = [this.userRoom(actor.userId)];
      if (actor.roles.includes('livreur')) rooms.push(COURIERS_ROOM, this.courierRoom(actor.userId));
      if (actor.roles.includes('manager') && actor.tenantId) rooms.push(this.restaurantRoom(actor.tenantId));
      void client.join(rooms);
    } catch {
      client.emit('error', { error: 'unauthorized' });
      client.disconnect(true);
      return;
    }
    this.logger.log(`ws connected: ${client.data.actor.userId}`);
  }

  /** Pushes a newly available delivery to connected couriers, without customer data. */
  emitAvailable(view: AvailableDeliveryView): void {
    this.server.to(COURIERS_ROOM).emit('delivery:available', view);
  }

  /** Tells the courier running it, and anyone tracking it, that a delivery was cancelled. */
  emitCancelled(delivery: DeliveryDocument): void {
    const payload = { deliveryId: String(delivery._id), orderId: delivery.orderId };
    const rooms = [this.room(String(delivery._id))];
    if (delivery.livreurId) rooms.push(this.courierRoom(delivery.livreurId));
    this.server.to(rooms).emit('delivery:cancelled', payload);
    // An unassigned delivery disappears from every courier's list.
    if (!delivery.livreurId) this.server.to(COURIERS_ROOM).emit('delivery:withdrawn', payload);
  }

  /** Order news to the people it concerns. */
  emitNotification(target: NotificationTarget, notification: Notification): void {
    const room =
      target.kind === 'restaurant'
        ? this.restaurantRoom(target.id)
        : target.kind === 'courier'
          ? this.courierRoom(target.id)
          : this.userRoom(target.id);
    this.server.to(room).emit('notification', notification);
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

  private courierRoom(courierId: string): string {
    return `courier:${courierId}`;
  }

  private userRoom(userId: string): string {
    return `user:${userId}`;
  }

  private restaurantRoom(restaurantId: string): string {
    return `restaurant:${restaurantId}`;
  }
}
