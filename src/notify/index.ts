import { env } from '../lib/env.js';
import { NoopNotifier, bestEffort, type Notifier } from './notifier.js';
import { TwilioNotifier } from './twilio.js';
import { VonageNotifier } from './vonage.js';

export * from './notifier.js';
export { TwilioNotifier } from './twilio.js';
export { VonageNotifier } from './vonage.js';

export function buildNotifier(): Notifier {
  const config = env();

  if (config.NOTIFIER === 'vonage') {
    return bestEffort(
      new VonageNotifier({
        apiKey: config.VONAGE_API_KEY,
        apiSecret: config.VONAGE_API_SECRET,
        from: config.VONAGE_SMS_FROM,
      }),
    );
  }

  if (config.NOTIFIER === 'twilio') {
    return bestEffort(
      new TwilioNotifier({
        accountSid: config.TWILIO_ACCOUNT_SID,
        authToken: config.TWILIO_AUTH_TOKEN,
        fromNumber: config.TWILIO_FROM_NUMBER,
      }),
    );
  }

  return bestEffort(new NoopNotifier());
}
