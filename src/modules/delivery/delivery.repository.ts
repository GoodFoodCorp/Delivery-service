import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Delivery, DeliveryDocument, DeliveryStatus } from './entities/delivery.schema';
import { PositionUpdate, PositionUpdateDocument } from './entities/position-update.schema';

/**
 * Persistence port. The service depends on this interface (injected by
 * token) so tests can swap in an in-memory fake without Mongo.
 */
export interface DeliveryRepository {
  findById(id: string): Promise<DeliveryDocument | null>;
  findByOrderId(orderId: string): Promise<DeliveryDocument | null>;
  listByStatus(status: DeliveryStatus): Promise<DeliveryDocument[]>;
  create(data: Partial<Delivery>): Promise<DeliveryDocument>;
  save(doc: DeliveryDocument): Promise<DeliveryDocument>;
  addPosition(deliveryId: string, lat: number, lng: number, timestamp: Date): Promise<PositionUpdateDocument>;
  lastPosition(deliveryId: string): Promise<PositionUpdateDocument | null>;
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

  listByStatus(status: DeliveryStatus): Promise<DeliveryDocument[]> {
    return this.deliveries.find({ status }).sort({ createdAt: 1 }).exec();
  }

  create(data: Partial<Delivery>): Promise<DeliveryDocument> {
    return this.deliveries.create(data);
  }

  save(doc: DeliveryDocument): Promise<DeliveryDocument> {
    return doc.save();
  }

  addPosition(deliveryId: string, lat: number, lng: number, timestamp: Date): Promise<PositionUpdateDocument> {
    return this.positions.create({ deliveryId, lat, lng, timestamp });
  }

  lastPosition(deliveryId: string): Promise<PositionUpdateDocument | null> {
    return this.positions.findOne({ deliveryId }).sort({ timestamp: -1 }).exec();
  }
}
