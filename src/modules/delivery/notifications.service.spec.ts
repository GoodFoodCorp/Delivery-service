import { targetsOf } from './notifications.service';

describe('targetsOf', () => {
  it('reads the notifications meant for the person, their restaurant and the couriers', () => {
    expect(targetsOf({ userId: 'c1', tenantId: '', roles: ['user'], token: '' })).toEqual([
      { kind: 'user', id: 'c1' },
    ]);
    expect(targetsOf({ userId: 'm1', tenantId: 'resto', roles: ['manager'], token: '' })).toEqual([
      { kind: 'user', id: 'm1' },
      { kind: 'restaurant', id: 'resto' },
    ]);
    expect(targetsOf({ userId: 'l1', tenantId: '', roles: ['livreur'], token: '' })).toEqual([
      { kind: 'user', id: 'l1' },
      { kind: 'courier', id: 'l1' },
      { kind: 'couriers', id: 'all' },
    ]);
  });
});
