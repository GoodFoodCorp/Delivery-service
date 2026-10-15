import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export enum WithdrawalStatus {
  Pending = 'PENDING',
  Paid = 'PAID',
}

/** A courier's request to be paid out; settled by a back-office transfer. */
@Schema({ collection: 'withdrawals', timestamps: true })
export class Withdrawal {
  @Prop({ required: true, index: true })
  livreurId: string;

  @Prop({ required: true })
  amountCents: number;

  /** Full IBAN snapshot for the back-office. Never returned to the courier. */
  @Prop({ required: true, select: false })
  iban: string;

  @Prop({ required: true })
  ibanMasked: string;

  @Prop({ required: true, enum: WithdrawalStatus, default: WithdrawalStatus.Pending, index: true })
  status: WithdrawalStatus;

  @Prop({ type: Date, default: () => new Date() })
  requestedAt: Date;

  @Prop({ type: Date, default: null })
  paidAt: Date | null;
}

export type WithdrawalDocument = HydratedDocument<Withdrawal>;
export const WithdrawalSchema = SchemaFactory.createForClass(Withdrawal);

// At most one PENDING withdrawal per courier: makes double requests race-proof.
WithdrawalSchema.index(
  { livreurId: 1 },
  { unique: true, partialFilterExpression: { status: WithdrawalStatus.Pending } },
);
