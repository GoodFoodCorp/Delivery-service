import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Withdrawal, WithdrawalDocument, WithdrawalStatus } from './entities/withdrawal.schema';

/** Persistence port, swappable for an in-memory fake in tests. */
export interface WithdrawalRepository {
  /** Rejects with a Mongo duplicate-key error (code 11000) if the courier already has a PENDING one. */
  create(data: Partial<Withdrawal>): Promise<WithdrawalDocument>;
  listByCourier(livreurId: string): Promise<WithdrawalDocument[]>;
  listByStatus(status: WithdrawalStatus): Promise<WithdrawalDocument[]>;
  /** Includes the IBAN (hidden by default). */
  findById(id: string): Promise<WithdrawalDocument | null>;
  save(doc: WithdrawalDocument): Promise<WithdrawalDocument>;
}

export const WITHDRAWAL_REPOSITORY = Symbol('WITHDRAWAL_REPOSITORY');

@Injectable()
export class MongooseWithdrawalRepository implements WithdrawalRepository {
  constructor(@InjectModel(Withdrawal.name) private readonly withdrawals: Model<WithdrawalDocument>) {}

  create(data: Partial<Withdrawal>): Promise<WithdrawalDocument> {
    return this.withdrawals.create(data);
  }

  listByCourier(livreurId: string): Promise<WithdrawalDocument[]> {
    return this.withdrawals.find({ livreurId }).sort({ requestedAt: -1 }).exec();
  }

  listByStatus(status: WithdrawalStatus): Promise<WithdrawalDocument[]> {
    return this.withdrawals.find({ status }).select('+iban').sort({ requestedAt: 1 }).exec();
  }

  findById(id: string): Promise<WithdrawalDocument | null> {
    return this.withdrawals.findById(id).select('+iban').exec();
  }

  save(doc: WithdrawalDocument): Promise<WithdrawalDocument> {
    return doc.save();
  }
}
