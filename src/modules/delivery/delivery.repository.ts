import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { ACTIVE_STATUSES, Delivery, DeliveryDocument, DeliveryStatus } from './entities/delivery.schema';
import { PositionUpdate, PositionUpdateDocument } from './entities/position-update.schema';

export interface NearQuery {
  lat: number;
  lng: number;
  radiusKm: number;
}

export interface CourierEarnings {
  /** Fees plus tips of delivered trips that carry a stored fee, in cents. */
  storedCents: number;
  completedTrips: number;
}

/**
 * Persistence port. Every state change is a single conditional update, so two
 * couriers (or a courier and a cancellation) racing on the same delivery can
 * never both win. The service depends on this interface (injected by token)
 * so tests can swap in an in-memory fake.
 */
export interface DeliveryRepository {
  findById(id: string): Promise<DeliveryDocument | null>;
  findByOrderId(orderId: string): Promise<DeliveryDocument | null>;
  /** Unassigned deliveries, oldest first, optionally around a point. */
  listAvailable(near: NearQuery | null, limit: number): Promise<DeliveryDocument[]>;
  listByCourier(courierId: string, statuses: DeliveryStatus[]): Promise<DeliveryDocument[]>;
  create(data: Partial<Delivery>): Promise<DeliveryDocument>;
  /** UNASSIGNED → ASSIGNED to the courier; null when someone else got it first. */
  claim(id: string, courierId: string, at: Date): Promise<DeliveryDocument | null>;
  /** ASSIGNED (to this courier) → UNASSIGNED. */
  release(id: string, courierId: string): Promise<DeliveryDocument | null>;
  /** Moves a delivery of this courier from one of `from` to `to`, setting `set`. */
  transition(
    id: string,
    courierId: string,
    from: DeliveryStatus[],
    to: DeliveryStatus,
    set?: Partial<Delivery>,
  ): Promise<DeliveryDocument | null>;
  /** Cancels the delivery of an order unless it is already delivered or cancelled. */
  cancelByOrder(orderId: string, at: Date): Promise<DeliveryDocument | null>;
  addPosition(deliveryId: string, lat: number, lng: number, timestamp: Date): Promise<PositionUpdateDocument>;
  lastPosition(deliveryId: string): Promise<PositionUpdateDocument | null>;
  listActiveCourierIds(): Promise<string[]>;
  /** Most recent delivered trips of a courier, at most limit. */
  listDeliveredByCourier(courierId: string, limit: number): Promise<DeliveryDocument[]>;
  /** Delivered trips created before fees were stored (fee computed on the fly). */
  listLegacyDeliveredByCourier(courierId: string): Promise<DeliveryDocument[]>;
  earningsOf(courierId: string): Promise<CourierEarnings>;
}

export const DELIVERY_REPOSITORY = Symbol('DELIVERY_REPOSITORY');

@Injectable()
export class MongooseDeliveryRepository implements DeliveryRepository {
  constructor(
    @InjectModel(Delivery.name) private readonly deliveries: Model<DeliveryDocument>,
    @InjectModel(PositionUpdate.name) private readonly positions: Model<PositionUpdateDocument>,
  ) {}

  findById(id: string): Promise<DeliveryDocument | null> {
    return this.deliveries.findById(id).exec();
  }

  findByOrderId(orderId: string): Promise<DeliveryDocument | null> {
    return this.deliveries.findOne({ orderId }).exec();
  }

  listAvailable(near: NearQuery | null, limit: number): Promise<DeliveryDocument[]> {
    const filter: FilterQuery<DeliveryDocument> = { status: DeliveryStatus.Unassigned };
    if (near) {
      // $near sorts by distance; without it, oldest first.
      filter.pickupLocation = {
        $near: {
          $geometry: { type: 'Point', coordinates: [near.lng, near.lat] },
          $maxDistance: near.radiusKm * 1000,
        },
      };
      return this.deliveries.find(filter).limit(limit).exec();
    }
    return this.deliveries.find(filter).sort({ createdAt: 1 }).limit(limit).exec();
  }

  listByCourier(courierId: string, statuses: DeliveryStatus[]): Promise<DeliveryDocument[]> {
    return this.deliveries
      .find({ livreurId: courierId, status: { $in: statuses } })
      .sort({ assignedAt: -1 })
      .exec();
  }

  create(data: Partial<Delivery>): Promise<DeliveryDocument> {
    return this.deliveries.create(data);
  }

  claim(id: string, courierId: string, at: Date): Promise<DeliveryDocument | null> {
    return this.deliveries
      .findOneAndUpdate(
        { _id: id, status: DeliveryStatus.Unassigned },
        { $set: { status: DeliveryStatus.Assigned, livreurId: courierId, assignedAt: at } },
        { new: true },
      )
      .exec();
  }

  release(id: string, courierId: string): Promise<DeliveryDocument | null> {
    return this.deliveries
      .findOneAndUpdate(
        { _id: id, status: DeliveryStatus.Assigned, livreurId: courierId },
        { $set: { status: DeliveryStatus.Unassigned, livreurId: null, assignedAt: null } },
        { new: true },
      )
      .exec();
  }

  transition(
    id: string,
    courierId: string,
    from: DeliveryStatus[],
    to: DeliveryStatus,
    set: Partial<Delivery> = {},
  ): Promise<DeliveryDocument | null> {
    return this.deliveries
      .findOneAndUpdate(
        { _id: id, livreurId: courierId, status: { $in: from } },
        { $set: { ...set, status: to } },
        { new: true },
      )
      .exec();
  }

  cancelByOrder(orderId: string, at: Date): Promise<DeliveryDocument | null> {
    return this.deliveries
      .findOneAndUpdate(
        { orderId, status: { $nin: [DeliveryStatus.Delivered, DeliveryStatus.Cancelled] } },
        { $set: { status: DeliveryStatus.Cancelled, cancelledAt: at } },
        { new: true },
      )
      .exec();
  }

  addPosition(deliveryId: string, lat: number, lng: number, timestamp: Date): Promise<PositionUpdateDocument> {
    return this.positions.create({ deliveryId, lat, lng, timestamp });
  }

  lastPosition(deliveryId: string): Promise<PositionUpdateDocument | null> {
    return this.positions.findOne({ deliveryId }).sort({ timestamp: -1 }).exec();
  }

  async listActiveCourierIds(): Promise<string[]> {
    const ids = await this.deliveries.distinct('livreurId', { status: { $in: ACTIVE_STATUSES } }).exec();
    return ids.filter((id): id is string => typeof id === 'string');
  }

  listDeliveredByCourier(courierId: string, limit: number): Promise<DeliveryDocument[]> {
    return this.deliveries
      .find({ livreurId: courierId, status: DeliveryStatus.Delivered })
      .sort({ deliveredAt: -1 })
      .limit(limit)
      .exec();
  }

  listLegacyDeliveredByCourier(courierId: string): Promise<DeliveryDocument[]> {
    return this.deliveries
      .find({ livreurId: courierId, status: DeliveryStatus.Delivered, courierFeeCents: null })
      .exec();
  }

  async earningsOf(courierId: string): Promise<CourierEarnings> {
    const [row] = await this.deliveries
      .aggregate<{ storedCents: number; completedTrips: number }>([
        { $match: { livreurId: courierId, status: DeliveryStatus.Delivered } },
        {
          $group: {
            _id: null,
            storedCents: { $sum: { $add: [{ $ifNull: ['$courierFeeCents', 0] }, { $ifNull: ['$tipCents', 0] }] } },
            completedTrips: { $sum: 1 },
          },
        },
      ])
      .exec();
    return { storedCents: row?.storedCents ?? 0, completedTrips: row?.completedTrips ?? 0 };
  }
}
