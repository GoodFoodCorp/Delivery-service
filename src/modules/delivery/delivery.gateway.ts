import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { Actor, verifyToken } from '../../common/auth.util';
import { DomainError } from '../../common/errors';
import { isAllowedOrigin } from '../../common/origins';
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
@WebSocketGateway({
  namespace: 'tracking',
  // Long-polling fallback: only pages of this site (or ALLOWED_ORIGINS) get CORS.
  cors: {
    origin: (origin: string | undefined, cb: (err: Error | null, ok?: boolean) => void) =>
      cb(null, isAllowedOrigin(origin, undefined)),
    credentials: true,
  },
})
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class DeliveryGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(DeliveryGateway.name);

  @WebSocketServer()
  server: Namespace;

  constructor(private readonly deliveries: DeliveryService) {}

  /**
   * The handshake is checked before the connection exists: a page of
   * another site (cross-site WebSocket hijacking) or a missing, forged or
   * expired token never gets a socket.
   */
  afterInit(server: Namespace): void {
    server.use((socket: AuthedSocket, next) => {
      const { headers } = socket.handshake;
      if (!isAllowedOrigin(headers.origin, headers['x-forwarded-host']?.toString() ?? headers.host)) {
        next(new Error('origin not allowed'));
        return;
      }
      // The web app's session is an HttpOnly cookie: the browser sends it
      // with the handshake, scripts never see it.
      const token =
        (socket.handshake.auth?.token as string | undefined) ??
        headers.authorization?.replace(/^Bearer /, '') ??
        cookieValue(headers.cookie, 'auth_token');
      try {
        socket.data.actor = verifyToken(token ?? '');
        next();
      } catch {
        next(new Error('unauthorized'));
      }
    });
  }

  handleConnection(client: AuthedSocket): void {
    const actor = client.data.actor;
    if (!actor) {
      client.disconnect(true);
      return;
    }
    const rooms = [this.userRoom(actor.userId)];
    if (actor.roles.includes('livreur')) rooms.push(COURIERS_ROOM, this.courierRoom(actor.userId));
    if (actor.roles.includes('manager') && actor.tenantId) rooms.push(this.restaurantRoom(actor.tenantId));
    void client.join(rooms);
    this.logger.log(`ws connected: ${actor.userId}`);
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
          : target.kind === 'couriers'
            ? COURIERS_ROOM
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

/** One cookie of a Cookie header, undefined when absent. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}
