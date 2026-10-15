import { Actor } from '../../common/auth.util';
import { DomainError, DomainErrorCode } from '../../common/errors';
import { Withdrawal, WithdrawalDocument, WithdrawalStatus } from './entities/withdrawal.schema';
import { WithdrawalRepository } from './withdrawal.repository';
import { WithdrawalService } from './withdrawal.service';

const VALID_IBAN = 'FR1420041010050500013M02606';

// ── In-memory fakes ─────────────────────────────────────────

type FakeDoc = Withdrawal & { _id: string };

class FakeWithdrawalRepo implements WithdrawalRepository {
  docs: FakeDoc[] = [];
  private seq = 0;

  async create(data: Partial<Withdrawal>) {
    const duplicate = this.docs.some((d) => d.livreurId === data.livreurId && d.status === WithdrawalStatus.Pending);
    if (duplicate && data.status === WithdrawalStatus.Pending) {
      throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    }
    const doc = {
      _id: `w${++this.seq}`,
      requestedAt: new Date(2026, 9, this.seq),
      paidAt: null,
      ...data,
    } as unknown as FakeDoc;
    this.docs.push(doc);
    return doc as unknown as WithdrawalDocument;
  }
  async listByCourier(livreurId: string) {
    return this.docs.filter((d) => d.livreurId === livreurId).reverse() as unknown as WithdrawalDocument[];
  }
  async listByStatus(status: WithdrawalStatus) {
    return this.docs.filter((d) => d.status === status) as unknown as WithdrawalDocument[];
  }
  async findById(id: string) {
    return (this.docs.find((d) => d._id === id) ?? null) as unknown as WithdrawalDocument | null;
  }
  async save(doc: WithdrawalDocument) {
    return doc;
  }
}

const courier: Actor = { userId: 'liv-1', tenantId: '', roles: ['livreur'], token: 't' };
const otherCourier: Actor = { userId: 'liv-2', tenantId: '', roles: ['livreur'], token: 't' };
const admin: Actor = { userId: 'adm-1', tenantId: '', roles: ['admin'], token: 't' };
const customer: Actor = { userId: 'cust-1', tenantId: '', roles: ['user'], token: 't' };

function setup(opts: { totalEarned?: number; iban?: string } = {}) {
  const repo = new FakeWithdrawalRepo();
  const deliveries = {
    courierHistory: jest.fn().mockResolvedValue({
      totalEarned: opts.totalEarned ?? 30,
      completedTrips: 6,
      trips: [],
    }),
  };
  const profiles = { getIban: jest.fn().mockResolvedValue(opts.iban ?? VALID_IBAN) };
  const service = new WithdrawalService(repo, deliveries as never, profiles as never);
  return { repo, deliveries, profiles, service };
}

async function expectDomainError(promise: Promise<unknown>, code: DomainErrorCode) {
  await expect(promise).rejects.toMatchObject({ code });
  await promise.catch((e) => expect(e).toBeInstanceOf(DomainError));
}

afterEach(() => {
  delete process.env.MIN_WITHDRAWAL_CENTS;
});

// ── request ─────────────────────────────────────────────────

describe('request', () => {
  it('creates a PENDING withdrawal of the whole available balance, without exposing the IBAN', async () => {
    const { repo, service } = setup({ totalEarned: 30 });

    const view = await service.request(courier);

    expect(view).toMatchObject({ amount: 30, status: 'PENDING', ibanMasked: 'FR•• •••• 2606' });
    expect(view).not.toHaveProperty('iban');
    expect(repo.docs).toHaveLength(1);
    expect(repo.docs[0].iban).toBe(VALID_IBAN);
    expect(repo.docs[0].amountCents).toBe(3000);
  });

  it('only withdraws what is left after previous withdrawals', async () => {
    const { repo, service } = setup({ totalEarned: 30 });
    await repo.create({ livreurId: 'liv-1', amountCents: 1000, status: WithdrawalStatus.Paid, iban: VALID_IBAN });

    const view = await service.request(courier);

    expect(view.amount).toBe(20);
  });

  it('refuses a balance under the minimum (10 EUR by default)', async () => {
    const { repo, service } = setup({ totalEarned: 9.99 });

    await expectDomainError(service.request(courier), DomainErrorCode.Validation);
    expect(repo.docs).toHaveLength(0);
  });

  it('reads the minimum from MIN_WITHDRAWAL_CENTS', async () => {
    process.env.MIN_WITHDRAWAL_CENTS = '500';
    const { service } = setup({ totalEarned: 6 });

    await expect(service.request(courier)).resolves.toMatchObject({ amount: 6 });
  });

  it('refuses when the courier has no IBAN', async () => {
    const { service } = setup({ iban: '' });

    await expectDomainError(service.request(courier), DomainErrorCode.Validation);
  });

  it('refuses a second request while one is pending', async () => {
    const { service } = setup({ totalEarned: 30 });
    await service.request(courier);

    await expectDomainError(service.request(courier), DomainErrorCode.Conflict);
  });

  it('turns a concurrent duplicate-key error into a conflict', async () => {
    const { repo, service } = setup({ totalEarned: 30 });
    jest.spyOn(repo, 'listByCourier').mockResolvedValueOnce([]); // lost the race: pending not visible yet
    await repo.create({ livreurId: 'liv-1', amountCents: 3000, status: WithdrawalStatus.Pending, iban: VALID_IBAN });

    await expectDomainError(service.request(courier), DomainErrorCode.Conflict);
  });

  it('is reserved to couriers', async () => {
    const { service } = setup();
    await expectDomainError(service.request(customer), DomainErrorCode.Forbidden);
  });
});

// ── overview / list ─────────────────────────────────────────

describe('overview', () => {
  it('subtracts pending and paid withdrawals from the available balance', async () => {
    const { repo, service } = setup({ totalEarned: 30 });
    await repo.create({ livreurId: 'liv-1', amountCents: 1000, status: WithdrawalStatus.Paid, iban: VALID_IBAN });
    await repo.create({ livreurId: 'liv-1', amountCents: 500, status: WithdrawalStatus.Pending, iban: VALID_IBAN });

    const overview = await service.overview(courier);

    expect(overview).toMatchObject({
      totalEarned: 30,
      availableBalance: 15,
      withdrawnTotal: 10,
      pendingAmount: 5,
      minWithdrawal: 10,
      completedTrips: 6,
      ibanMasked: 'FR•• •••• 2606',
    });
    expect(overview.withdrawals).toHaveLength(2);
  });

  it('only shows the connected courier\'s withdrawals', async () => {
    const { repo, service } = setup();
    await repo.create({ livreurId: 'liv-2', amountCents: 1200, status: WithdrawalStatus.Paid, iban: VALID_IBAN });

    const overview = await service.overview(courier);

    expect(overview.withdrawals).toHaveLength(0);
    expect(overview.withdrawnTotal).toBe(0);
    expect((await service.list(otherCourier))).toHaveLength(1);
  });
});

// ── admin ───────────────────────────────────────────────────

describe('admin', () => {
  it('lists pending withdrawals with the full IBAN', async () => {
    const { service } = setup({ totalEarned: 30 });
    await service.request(courier);

    const list = await service.adminList(admin, WithdrawalStatus.Pending);

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ livreurId: 'liv-1', amount: 30, iban: VALID_IBAN });
  });

  it('marks a pending withdrawal as paid', async () => {
    const { service } = setup({ totalEarned: 30 });
    const created = await service.request(courier);

    const paid = await service.markPaid(admin, created.id);

    expect(paid.status).toBe('PAID');
    expect(paid.paidAt).toBeInstanceOf(Date);
    // a new request is possible again once the previous one is settled
    await expect(service.request(courier)).rejects.toMatchObject({ code: DomainErrorCode.Validation });
  });

  it('refuses to pay twice, and unknown ids', async () => {
    const { service } = setup({ totalEarned: 30 });
    const created = await service.request(courier);
    await service.markPaid(admin, created.id);

    await expectDomainError(service.markPaid(admin, created.id), DomainErrorCode.Conflict);
    await expectDomainError(service.markPaid(admin, 'nope'), DomainErrorCode.NotFound);
  });

  it('is reserved to admins', async () => {
    const { service } = setup({ totalEarned: 30 });
    const created = await service.request(courier);

    await expectDomainError(service.adminList(courier), DomainErrorCode.Forbidden);
    await expectDomainError(service.markPaid(courier, created.id), DomainErrorCode.Forbidden);
  });
});
