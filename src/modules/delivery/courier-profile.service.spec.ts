import { NotFoundException } from '@nestjs/common';
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
