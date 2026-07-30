import { logger } from '../lib/logger.js';
import {
  cancellationText,
  confirmationText,
  type BookingMessage,
  type Notifier,
} from './notifier.js';

/**
 * SMS over the Vonage SMS API.
 *
 * Plain fetch against rest.nexmo.com rather than the Vonage SDK: the SDK
 * pulls in a large dependency tree for one POST, and this keeps the notifier
 * swappable without a package change.
 */
export interface VonageSmsConfig {
  apiKey: string;
  apiSecret: string;
  from: string;
}

const SMS_ENDPOINT = 'https://rest.nexmo.com/sms/json';

export class VonageNotifier implements Notifier {
  constructor(private readonly config: VonageSmsConfig) {}

  async bookingConfirmed(message: BookingMessage): Promise<void> {
    await this.send(message.to, confirmationText(message));
  }

  async bookingCancelled(message: BookingMessage): Promise<void> {
    await this.send(message.to, cancellationText(message));
  }

  private async send(to: string, text: string): Promise<void> {
    const response = await fetch(SMS_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        api_key: this.config.apiKey,
        api_secret: this.config.apiSecret,
        from: this.config.from,
        // E.164 without the leading plus, which is what this API expects.
        to: to.replace(/^\+/, '').replace(/[^\d]/g, ''),
        text,
        type: 'text',
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Vonage SMS ${response.status}: ${await response.text()}`);
    }

    // Vonage returns 200 with a per-message status, so a non-zero status here
    // is a failure that an HTTP-only check would miss entirely.
    const json = (await response.json()) as {
      messages?: Array<{ status: string; 'error-text'?: string; 'message-id'?: string }>;
    };
    const failed = (json.messages ?? []).filter((m) => m.status !== '0');
    if (failed.length > 0) {
      throw new Error(
        `Vonage SMS rejected: ${failed.map((f) => f['error-text'] ?? f.status).join('; ')}`,
      );
    }

    // The body carries the guest's name and booking time, so it is not logged.
    logger().info(
      { kind: 'sms_sent', provider: 'vonage', message_id: json.messages?.[0]?.['message-id'] },
      'SMS queued',
    );
  }
}
