import { Inject, Injectable } from '@nestjs/common';
import { Actor } from '../../common/auth.util';
import { DomainError } from '../../common/errors';
import { CourierProfileService } from './courier-profile.service';
import { DeliveryService } from './delivery.service';
import { WithdrawalDocument, WithdrawalStatus } from './entities/withdrawal.schema';
import { isValidIban, maskIban } from './iban';
import { WITHDRAWAL_REPOSITORY, WithdrawalRepository } from './withdrawal.repository';

const ROLE_COURIER = 'livreur';
const ROLE_ADMIN = 'admin';
const DEFAULT_MIN_WITHDRAWAL_CENTS = 1000;

const euros = (cents: number) => cents / 100;

/** Courier payout requests. The actual bank transfer is done by the back-office. */
@Injectable()
export class WithdrawalService {
  constructor(
    @Inject(WITHDRAWAL_REPOSITORY) private readonly repo: WithdrawalRepository,
    private readonly deliveries: DeliveryService,
    private readonly profiles: CourierProfileService,
  ) {}

  /** Earnings history + payout state, in a single payload for the mobile screen. */
  async overview(actor: Actor) {
    this.ensureRole(actor, ROLE_COURIER);
    const [history, withdrawals, iban] = await Promise.all([
      this.deliveries.courierHistory(actor),
      this.repo.listByCourier(actor.userId),
      this.profiles.getIban(actor.userId),
    ]);
    const { available, paidCents, pendingCents } = this.balance(history.totalEarned, withdrawals);
    return {
      totalEarned: history.totalEarned,
      availableBalance: euros(available),
      withdrawnTotal: euros(paidCents),
      pendingAmount: euros(pendingCents),
      minWithdrawal: euros(this.minWithdrawalCents()),
      completedTrips: history.completedTrips,
      trips: history.trips,
      ibanMasked: maskIban(iban),
      withdrawals: withdrawals.map((w) => this.toView(w)),
    };
  }

  async list(actor: Actor) {
    this.ensureRole(actor, ROLE_COURIER);
    return (await this.repo.listByCourier(actor.userId)).map((w) => this.toView(w));
  }

  /** Withdraws the whole available balance. */
  async request(actor: Actor) {
    this.ensureRole(actor, ROLE_COURIER);
    const iban = await this.profiles.getIban(actor.userId);
    if (!isValidIban(iban)) {
      throw DomainError.validation('Enregistrez un IBAN valide avant de demander un retrait');
    }

    const [history, existing] = await Promise.all([
      this.deliveries.courierHistory(actor),
      this.repo.listByCourier(actor.userId),
    ]);
    if (existing.some((w) => w.status === WithdrawalStatus.Pending)) {
      throw DomainError.conflict('Une demande de retrait est déjà en cours');
    }
    const { available } = this.balance(history.totalEarned, existing);
    const min = this.minWithdrawalCents();
    if (available < min) {
      throw DomainError.validation(`Le montant minimum de retrait est de ${euros(min).toFixed(2)} €`);
    }

    try {
      const created = await this.repo.create({
        livreurId: actor.userId,
        amountCents: available,
        iban,
        ibanMasked: maskIban(iban),
        status: WithdrawalStatus.Pending,
      });
      return this.toView(created);
    } catch (err) {
      // Unique partial index: a concurrent request got there first.
      if ((err as { code?: number }).code === 11000) {
        throw DomainError.conflict('Une demande de retrait est déjà en cours');
      }
      throw err;
    }
  }

  async adminList(actor: Actor, status: WithdrawalStatus = WithdrawalStatus.Pending) {
    this.ensureRole(actor, ROLE_ADMIN);
    return (await this.repo.listByStatus(status)).map((w) => ({
      ...this.toView(w),
      livreurId: w.livreurId,
      iban: w.iban,
    }));
  }

  async markPaid(actor: Actor, id: string) {
    this.ensureRole(actor, ROLE_ADMIN);
    const withdrawal = await this.repo.findById(id);
    if (!withdrawal) throw DomainError.notFound('Demande de retrait introuvable');
    if (withdrawal.status !== WithdrawalStatus.Pending) {
      throw DomainError.conflict('Cette demande a déjà été traitée');
    }
    withdrawal.status = WithdrawalStatus.Paid;
    withdrawal.paidAt = new Date();
    return this.toView(await this.repo.save(withdrawal));
  }

  private balance(totalEarned: number, withdrawals: WithdrawalDocument[]) {
    const pendingCents = withdrawals
      .filter((w) => w.status === WithdrawalStatus.Pending)
      .reduce((sum, w) => sum + w.amountCents, 0);
    const paidCents = withdrawals
      .filter((w) => w.status === WithdrawalStatus.Paid)
      .reduce((sum, w) => sum + w.amountCents, 0);
    const available = Math.max(0, Math.round(totalEarned * 100) - pendingCents - paidCents);
    return { available, paidCents, pendingCents };
  }

  private minWithdrawalCents(): number {
    const value = Number(process.env.MIN_WITHDRAWAL_CENTS);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_MIN_WITHDRAWAL_CENTS;
  }

  private toView(w: WithdrawalDocument) {
    return {
      id: String(w._id),
      amount: euros(w.amountCents),
      ibanMasked: w.ibanMasked,
      status: w.status,
      requestedAt: w.requestedAt,
      paidAt: w.paidAt,
    };
  }

  private ensureRole(actor: Actor, role: string): void {
    if (!actor.roles.includes(role)) {
      throw DomainError.forbidden(`requires role: ${role}`);
    }
  }
}
