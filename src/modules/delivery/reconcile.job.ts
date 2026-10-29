import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Connection } from 'mongoose';
import { AvailabilityNotifier } from './availability.notifier';
import { DeliveryService } from './delivery.service';

const DEFAULT_INTERVAL_MS = 60_000;
const LOCK_ID = 'delivery-reconcile';

/**
 * Periodically creates the deliveries whose order event was missed (broker
 * down, consumer restarted). It used to run on every courier's poll, which
 * meant one full scan of order-service per courier per refresh; now one
 * replica runs it, elected with a lease document in MongoDB.
 */
@Injectable()
export class ReconcileJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconcileJob.name);
  private readonly owner = randomUUID();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deliveries: DeliveryService,
    private readonly notifier: AvailabilityNotifier,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  onModuleInit(): void {
    if (process.env.RECONCILE_INTERVAL_MS === '0') return;
    const interval = Number(process.env.RECONCILE_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => void this.runOnce(interval), interval);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass, if this replica holds (or takes) the lease. */
  async runOnce(leaseMs: number): Promise<number> {
    if (!(await this.acquireLease(leaseMs))) return 0;
    try {
      const created = await this.deliveries.reconcile();
      for (const delivery of created) {
        await this.notifier.notifyNewDelivery(delivery).catch(() => undefined);
      }
      if (created.length) this.logger.log(`reconciled ${created.length} missed deliveries`);
      return created.length;
    } catch (err) {
      this.logger.warn(`reconciliation skipped: ${(err as Error).message}`);
      return 0;
    }
  }

  /** Takes the lease when it is free, expired, or already ours. */
  private async acquireLease(leaseMs: number): Promise<boolean> {
    const now = new Date();
    try {
      const lease = await this.connection.collection<{ _id: string; owner: string; expiresAt: Date }>('locks').findOneAndUpdate(
        { _id: LOCK_ID, $or: [{ expiresAt: { $lt: now } }, { owner: this.owner }] },
        { $set: { owner: this.owner, expiresAt: new Date(now.getTime() + leaseMs) } },
        { upsert: true, returnDocument: 'after' },
      );
      return lease?.owner === this.owner;
    } catch (err) {
      // Duplicate key on upsert: another replica holds a live lease.
      if ((err as { code?: number }).code === 11000) return false;
      throw err;
    }
  }
}
