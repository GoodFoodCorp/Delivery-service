/**
 * What each person is told when an order changes: the customer follows their
 * order, the restaurant gets its new orders and cancellations, the courier
 * hears when the meal is ready. Pure: the consumer and the gateway deliver.
 */

export interface Notification {
  /** The event's id: the browser shows each notification once. */
  id: string;
  title: string;
  body: string;
  orderId: string;
  status: string;
  /** Page of the front to open from the notification. */
  link: string;
  at: string;
}

/** couriers/all: every courier (a new delivery to take). */
export type NotificationTarget = { kind: 'user' | 'restaurant' | 'courier' | 'couriers'; id: string };

export interface Addressed {
  target: NotificationTarget;
  notification: Notification;
}

interface OrderEventMessage {
  id?: string;
  type?: string;
  occurredAt?: string;
  data?: {
    orderId?: string;
    customerId?: string;
    restaurantId?: string;
    courierId?: string | null;
    fulfillment?: string;
    amountDueCents?: number;
    cancelledBy?: string;
  };
}

const euros = (cents?: number) =>
  typeof cents === 'number' ? `${(cents / 100).toFixed(2).replace('.', ',')} €` : '';

const short = (orderId: string) => `#${orderId.slice(0, 8)}`;

/** The notifications an order event gives; none for an event nobody needs to hear about. */
export function orderNotifications(raw: Buffer | string): Addressed[] {
  const event = JSON.parse(raw.toString()) as OrderEventMessage;
  const d = event.data ?? {};
  if (!d.orderId || !event.type?.startsWith('order.')) return [];
  const status = event.type.slice('order.'.length).toUpperCase();
  const at = event.occurredAt ?? new Date().toISOString();
  const pickup = d.fulfillment === 'PICKUP';
  const ref = short(d.orderId);
  const out: Addressed[] = [];
  const add = (target: NotificationTarget | null, title: string, body: string, link: string) => {
    if (!target?.id) return;
    out.push({
      target,
      notification: {
        id: `${event.id ?? d.orderId + status}:${target.kind}`,
        title,
        body,
        orderId: d.orderId!,
        status,
        link,
        at,
      },
    });
  };
  const customer = d.customerId ? { kind: 'user' as const, id: d.customerId } : null;
  const restaurant = d.restaurantId ? { kind: 'restaurant' as const, id: d.restaurantId } : null;
  const courier = d.courierId ? { kind: 'courier' as const, id: d.courierId } : null;
  const orderPage = `/orders/${d.orderId}`;

  switch (status) {
    case 'CONFIRMED':
      add(customer, 'Commande confirmée', `Le restaurant a bien reçu votre commande ${ref}.`, orderPage);
      add(
        restaurant,
        'Nouvelle commande',
        `${ref} · ${euros(d.amountDueCents)} · ${pickup ? 'À emporter' : 'Livraison'}`,
        '/portal/orders',
      );
      break;
    case 'IN_PREPARATION':
      add(customer, 'En préparation', 'Le restaurant prépare votre commande.', orderPage);
      break;
    case 'READY_FOR_PICKUP':
      if (pickup) {
        add(customer, 'Votre commande est prête', 'Vous pouvez venir la retirer au restaurant.', orderPage);
      } else {
        add(customer, 'Commande prête', 'Elle attend son livreur au restaurant.', orderPage);
        add(courier, 'Commande prête', `La commande ${ref} vous attend au restaurant.`, '/courier');
      }
      break;
    case 'IN_DELIVERY':
      add(customer, 'Votre commande est en route', 'Suivez votre livreur en direct.', orderPage);
      add(
        restaurant,
        'Commande récupérée',
        `Le livreur est parti avec la commande ${ref}.`,
        '/portal/orders',
      );
      break;
    case 'DELIVERED':
      add(
        customer,
        pickup ? 'Commande retirée' : 'Commande livrée',
        'Bon appétit ! Vous pouvez noter votre livraison.',
        orderPage,
      );
      break;
    case 'CANCELLED':
      if (d.cancelledBy !== 'CUSTOMER') {
        add(
          customer,
          'Commande annulée',
          `Votre commande ${ref} a été annulée. Vous êtes remboursé intégralement.`,
          orderPage,
        );
      }
      if (d.cancelledBy !== 'RESTAURANT') {
        add(
          restaurant,
          'Commande annulée',
          `La commande ${ref} a été annulée${d.cancelledBy === 'CUSTOMER' ? ' par le client' : ''}.`,
          '/portal/orders',
        );
      }
      add(courier, 'Course annulée', `La commande ${ref} a été annulée : inutile de la livrer.`, '/courier');
      break;
  }
  return out;
}

/** A courier accepted the delivery. */
export function courierAssignedNotifications(
  orderId: string,
  customerId: string,
  restaurantId: string,
): Addressed[] {
  const at = new Date().toISOString();
  const base = { orderId, status: 'COURIER_ASSIGNED', at };
  return [
    {
      target: { kind: 'user', id: customerId },
      notification: {
        ...base,
        id: `${orderId}:assigned:user`,
        title: 'Un livreur a pris votre commande',
        body: 'Il va la récupérer au restaurant.',
        link: `/orders/${orderId}`,
      },
    },
    {
      target: { kind: 'restaurant', id: restaurantId },
      notification: {
        ...base,
        id: `${orderId}:assigned:restaurant`,
        title: 'Livreur en route',
        body: `Un livreur vient chercher la commande ${short(orderId)}.`,
        link: '/portal/orders',
      },
    },
  ];
}
