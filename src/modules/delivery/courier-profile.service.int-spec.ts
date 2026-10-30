import { BadRequestException } from '@nestjs/common';
import mongoose, { Model } from 'mongoose';
import { CourierProfileService } from './courier-profile.service';
import {
  CourierProfileDocument,
  CourierProfileSchema,
  CourierVehicleType,
} from './entities/courier-profile.schema';

/**
 * Runs against a real MongoDB: the 2dsphere index on lastLocation rejects
 * malformed points, which unit tests with fakes cannot see.
 *   MONGO_TEST_URI=mongodb://localhost:27018/delivery_it npx jest --testRegex int-spec
 */
const uri = process.env.MONGO_TEST_URI;
const describeIfMongo = uri ? describe : describe.skip;

const application = {
  vehicleType: CourierVehicleType.Bike,
  siret: '123456789',
  city: 'Paris',
  iban: 'FR76 3000 6000 0112 3456 7890 189',
  hasBagEquipped: true,
};

describeIfMongo('CourierProfileService (MongoDB)', () => {
  let profiles: Model<CourierProfileDocument>;
  let service: CourierProfileService;

  beforeAll(async () => {
    await mongoose.connect(uri as string);
    profiles = mongoose.model('CourierProfile', CourierProfileSchema) as unknown as Model<CourierProfileDocument>;
    await profiles.deleteMany({});
    await profiles.syncIndexes();
    service = new CourierProfileService(profiles);
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  it('registers a courier who has never reported a position', async () => {
    const profile = await service.apply('courier-new', application);

    expect(profile).toMatchObject({ city: 'Paris', vehicleType: CourierVehicleType.Bike });
    const stored = await profiles.findOne({ userId: 'courier-new' }).lean().exec();
    expect(stored?.lastLocation).toBeUndefined();
  });

  it('creates a minimal profile when a legacy courier goes online', async () => {
    await expect(service.setAvailability('courier-legacy', true, true)).resolves.toMatchObject({ isAvailable: true });
  });

  it('targets a located courier near the pickup point', async () => {
    await service.apply('courier-near', application);
    await service.setAvailability('courier-near', true);
    await service.setPushToken('courier-near', 'ExponentPushToken[near]');
    await service.setLocation('courier-near', 48.85, 2.35);

    const targets = await service.listPushTargets({ lat: 48.851, lng: 2.351, radiusKm: 2 });

    expect(targets.map((t) => t.userId)).toContain('courier-near');
  });

  it('answers 400, not 500, to an invalid application', async () => {
    await expect(service.apply('courier-bad', { ...application, siret: '12' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.apply('courier-bad', { ...application, iban: 'FR00 1234' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.apply('courier-bad', { ...application, vehicleType: CourierVehicleType.Car }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
