import twilio from 'twilio';
import { logger } from '../lib/logger.js';
import {
  cancellationText,
  confirmationText,
  type BookingMessage,
  type Notifier,
} from './notifier.js';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export class TwilioNotifier implements Notifier {
  private readonly client: ReturnType<typeof twilio>;

  constructor(private readonly config: TwilioConfig) {
    this.client = twilio(config.accountSid, config.authToken);
  }

  async bookingConfirmed(message: BookingMessage): Promise<void> {
    await this.send(message.to, confirmationText(message));
  }

  async bookingCancelled(message: BookingMessage): Promise<void> {
    await this.send(message.to, cancellationText(message));
  }

  private async send(to: string, body: string): Promise<void> {
    const result = await this.client.messages.create({
      to,
      from: this.config.fromNumber,
      body,
    });
    // The message body contains the guest's name and booking time, so it is
    // deliberately not logged; the sid is enough to find it in Twilio.
    logger().info({ kind: 'sms_sent', sid: result.sid, status: result.status }, 'SMS queued');
  }
}
