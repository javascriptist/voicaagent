import { logger } from '../lib/logger.js';

/**
 * SMS confirmations.
 *
 * Behind an interface so tests never touch the network and a restaurant
 * without a Twilio account still gets working bookings. Sending is always
 * fire-and-forget from the caller's point of view: a Twilio outage must not
 * fail a reservation that is already committed in Postgres. The guest can be
 * told the booking is made even if the text has not gone yet.
 */

export interface BookingMessage {
  to: string;
  restaurantName: string;
  guestName: string;
  /** Already rendered in the restaurant's local time. */
  when: string;
  partySize: number;
  reference: string;
  cancellationPolicy?: string;
}

export interface Notifier {
  bookingConfirmed(message: BookingMessage): Promise<void>;
  bookingCancelled(message: BookingMessage): Promise<void>;
}

export function confirmationText(m: BookingMessage): string {
  const policy = m.cancellationPolicy ? ` ${m.cancellationPolicy}` : '';
  return (
    `${m.restaurantName}: booking confirmed for ${m.guestName}, ` +
    `${m.partySize} ${m.partySize === 1 ? 'person' : 'people'} on ${m.when}. ` +
    `Reference ${m.reference}.${policy}`
  );
}

export function cancellationText(m: BookingMessage): string {
  return (
    `${m.restaurantName}: your booking on ${m.when} for ${m.partySize} ` +
    `${m.partySize === 1 ? 'person' : 'people'} has been cancelled. Reference ${m.reference}.`
  );
}

/** Records what it would have sent. Used by tests and by local development. */
export class NoopNotifier implements Notifier {
  readonly sent: Array<{ kind: 'confirmed' | 'cancelled'; message: BookingMessage; body: string }> = [];

  async bookingConfirmed(message: BookingMessage): Promise<void> {
    this.sent.push({ kind: 'confirmed', message, body: confirmationText(message) });
  }

  async bookingCancelled(message: BookingMessage): Promise<void> {
    this.sent.push({ kind: 'cancelled', message, body: cancellationText(message) });
  }
}

/**
 * Wraps a notifier so a failure is logged and swallowed.
 *
 * Applied at the call site in the booking service: the reservation row is
 * already committed by the time we send, so throwing here would report failure
 * for a booking that exists, and the guest would arrive to a table that is
 * theirs but marked cancelled.
 */
export function bestEffort(notifier: Notifier): Notifier {
  return {
    async bookingConfirmed(message) {
      try {
        await notifier.bookingConfirmed(message);
      } catch (error) {
        logger().error({ err: error, kind: 'sms_failed', stage: 'confirmed' }, 'SMS send failed');
      }
    },
    async bookingCancelled(message) {
      try {
        await notifier.bookingCancelled(message);
      } catch (error) {
        logger().error({ err: error, kind: 'sms_failed', stage: 'cancelled' }, 'SMS send failed');
      }
    },
  };
}
