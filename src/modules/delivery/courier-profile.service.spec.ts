import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CourierProfileService } from './courier-profile.service';

function setup(result: unknown) {
  const exec = jest.fn().mockResolvedValue(result);
  const findOneAndUpdate = jest.fn().mockReturnValue({ exec });
  const service = new CourierProfileService({ findOneAndUpdate } as never);
  return { service, findOneAndUpdate };
}

const stored = {
  _id: 'p1',
  userId: 'u1',
  vehicleType: 'bike',
  siret: '',
  city: '',
  hasBagEquipped: false,
  isAvailable: true,
  availableBalanceCents: 0,
  totalEarnedCents: 0,
  completedTrips: 0,
};

describe('CourierProfileService.setAvailability', () => {
  it('creates a minimal profile for a livreur account that has none yet', async () => {
    const { service, findOneAndUpdate } = setup(stored);

    const result = await service.setAvailability('u1', true, true);

    const [filter, update, options] = findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ userId: 'u1' });
    expect(update).toMatchObject({ isAvailable: true });
    expect(options).toMatchObject({ upsert: true, new: true });
    expect(result.isAvailable).toBe(true);
  });

  it('does not create a profile for an account that is not a livreur', async () => {
    const { service, findOneAndUpdate } = setup(null);

    await expect(service.setAvailability('u2', true)).rejects.toBeInstanceOf(NotFoundException);
    expect(findOneAndUpdate.mock.calls[0][2]).not.toMatchObject({ upsert: true });
  });
});

describe('CourierProfileService IBAN', () => {
  const VALID = 'FR14 2004 1010 0505 0001 3M02 606';

  it('stores a valid IBAN normalized, creating a minimal profile for a livreur', async () => {
    const { service, findOneAndUpdate } = setup(stored);

    await service.setIban('u1', VALID, true);

    const [filter, update, options] = findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ userId: 'u1' });
    expect(update).toMatchObject({ iban: 'FR1420041010050500013M02606' });
    expect(options).toMatchObject({ upsert: true, new: true });
  });

  it('rejects an invalid IBAN without touching the database', async () => {
    const { service, findOneAndUpdate } = setup(stored);

    await expect(service.setIban('u1', 'FR00 1234', true)).rejects.toBeInstanceOf(BadRequestException);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('returns the stored IBAN, or an empty string when there is none', async () => {
    const exec = jest.fn().mockResolvedValueOnce({ iban: 'FR1420041010050500013M02606' }).mockResolvedValueOnce(null);
    const findOne = jest.fn().mockReturnValue({ select: () => ({ lean: () => ({ exec }) }) });
    const service = new CourierProfileService({ findOne } as never);

    expect(await service.getIban('u1')).toBe('FR1420041010050500013M02606');
    expect(await service.getIban('u2')).toBe('');
  });
});
