import type { AvailabilityResult, SlotOption } from '../availability/types.js';
import { PREFERENCE_PHRASES } from '../domain/preferences.js';
import {
  assertSpeechSafe,
  makeSpeakable,
  numberToWords,
  peopleWords,
  tablesWords,
} from './index.js';
import { spokenDate, spokenTime, type LocalDate } from '../time/zone.js';

/**
 * The sentences Vonage AI Studio reads aloud.
 *
 * These go straight to a Speak node with no model in between, so every one is
 * written to be *said*: no digits, no ids, no markdown, no lists, no clause
 * that only parses on a screen. Numbers go through `numberToWords`, times
 * through `spokenTime`, and anything typed by a human — a guest's name, an
 * allergy — through `makeSpeakable`.
 *
 * Every builder ends with `assertSpeechSafe`, which throws rather than letting
 * an unspeakable hint reach a caller. In tests that is a failed build; in
 * production the error handler turns it into the generic spoken fallback,
 * which is still speakable.
 */

function joinTwo(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return `${items[0]} and ${items[1]}`;
}

function describeTable(offer: SlotOption): string {
  const matched = offer.assignment.matchedPreferences;
  if (matched.length > 0) {
    return joinTwo(matched.slice(0, 2).map((p) => PREFERENCE_PHRASES[p]));
  }
  if (offer.assignment.isCombination) {
    return `${tablesWords(offer.assignment.tableIds.length)} together`;
  }
  return '';
}

/** "Seven thirty works, and I can give you a booth." */
export function availabilitySpeech(
  result: AvailabilityResult,
  zone: string,
  today: LocalDate,
): string {
  if (!result.available || !result.offer) {
    return unavailableSpeech(result, zone, today);
  }

  const time = spokenTime(result.offer.localTime);
  const dayPart =
    result.offer.localDate === today
      ? ''
      : ` on ${spokenDate(result.offer.localDate, today, zone)}`;
  const table = describeTable(result.offer);
  const unmatched = result.offer.assignment.unmatchedPreferences;

  let sentence = `${capitalise(time)}${dayPart} works`;
  if (table) sentence += `, and I can give you ${table}`;
  sentence += '.';

  // Say what we could not do, rather than letting the guest find out on
  // arrival. One item only: a list of caveats is not a spoken sentence.
  if (unmatched.length > 0 && !table) {
    sentence += ` I don't have ${PREFERENCE_PHRASES[unmatched[0]!]} free, I'm afraid.`;
  }
  if (result.largeParty) {
    sentence += ' For a party that size I will pass you to the team to confirm the details.';
  }
  return assertSpeechSafe(sentence);
}

export function unavailableSpeech(
  result: AvailabilityResult,
  zone: string,
  today: LocalDate,
): string {
  const alternatives = result.alternatives.slice(0, 2);
  const nextDate = result.nextDates[0];

  const offerTimes =
    alternatives.length > 0
      ? ` I could do ${joinTwo(alternatives.map((a) => spokenTime(a.localTime)))}.`
      : nextDate
        ? ` I have space on ${spokenDate(nextDate.localDate, today, zone)} at ${spokenTime(nextDate.localTime)}.`
        : '';

  let sentence: string;
  switch (result.reason) {
    case 'no_accessible_table':
      sentence = offerTimes
        ? `I'm afraid the accessible tables are taken then.${offerTimes}`
        : "I'm afraid our accessible tables are all taken then. Let me put you through to the team so we can sort something out.";
      break;
    case 'party_too_large':
      sentence = "I'm afraid we can't seat a party that size. Let me put you through to the team.";
      break;
    case 'large_party_referral':
      sentence = 'For a party that size, let me put you through to the team.';
      break;
    case 'outside_booking_window':
      sentence = 'That is further ahead than we take bookings, I am afraid.';
      break;
    case 'in_the_past':
      sentence = 'That time has already passed. Did you mean a later day?';
      break;
    case 'closed':
      sentence = offerTimes
        ? `We're closed that day, I'm afraid.${offerTimes}`
        : "We're closed that day, I'm afraid.";
      break;
    case 'not_a_service_time':
      sentence = offerTimes
        ? `We're not serving then.${offerTimes}`
        : "We're not serving at that time, I'm afraid.";
      break;
    case 'nonexistent_local_time':
      sentence = offerTimes
        ? `The clocks go forward that night, so that time doesn't exist.${offerTimes}`
        : 'The clocks go forward that night, so that time does not exist.';
      break;
    default:
      sentence = offerTimes
        ? `That time is fully booked.${offerTimes}`
        : "I'm afraid we're fully booked then. Would you like me to take your number for the waiting list?";
  }
  return assertSpeechSafe(sentence);
}

export function bookingConfirmedSpeech(params: {
  localDate: LocalDate;
  localTime: string;
  today: LocalDate;
  zone: string;
  partySize: number;
  guestName: string;
  allergies?: string | null;
  largeParty?: boolean;
}): string {
  const when = `${spokenTime(params.localTime)} on ${spokenDate(params.localDate, params.today, params.zone)}`;
  const name = makeSpeakable(params.guestName);

  let sentence = name
    ? `That's booked, ${name}. ${capitalise(when)}, for ${peopleWords(params.partySize)}.`
    : `That's booked. ${capitalise(when)}, for ${peopleWords(params.partySize)}.`;

  // Reading the allergy back is a safety check, not a nicety: it is the last
  // chance for the guest to correct a mishearing before it reaches the kitchen.
  if (params.allergies) {
    const allergies = makeSpeakable(params.allergies);
    if (allergies) sentence += ` I've noted ${allergies}, and I'll pass that to the kitchen.`;
  }
  sentence += " You'll get a text confirmation shortly.";
  if (params.largeParty) {
    sentence += ' Someone from the team will call you about the details for a party that size.';
  }
  return assertSpeechSafe(sentence);
}

export function bookingModifiedSpeech(params: {
  localDate: LocalDate;
  localTime: string;
  today: LocalDate;
  zone: string;
  partySize: number;
}): string {
  const when = `${spokenTime(params.localTime)} on ${spokenDate(params.localDate, params.today, params.zone)}`;
  return assertSpeechSafe(
    `That's changed. You're now down for ${when}, for ${peopleWords(params.partySize)}.`,
  );
}

export function bookingCancelledSpeech(params: {
  localDate: LocalDate;
  localTime: string;
  today: LocalDate;
  zone: string;
}): string {
  const when = `${spokenTime(params.localTime)} on ${spokenDate(params.localDate, params.today, params.zone)}`;
  return assertSpeechSafe(
    `That's cancelled, your table at ${when} has been released. You'll get a text to confirm.`,
  );
}

export function lookupSpeech(
  bookings: Array<{ localDate: LocalDate; localTime: string; partySize: number }>,
  today: LocalDate,
  zone: string,
): string {
  if (bookings.length === 0) {
    return assertSpeechSafe(
      "I can't find a booking under that number, I'm afraid. Could you check it for me?",
    );
  }
  const first = bookings[0]!;
  const when = `${spokenTime(first.localTime)} on ${spokenDate(first.localDate, today, zone)}`;
  const sentence =
    bookings.length === 1
      ? `I've got you down for ${peopleWords(first.partySize)} at ${when}.`
      : `I've got ${numberToWords(bookings.length)} bookings for you. The next is ${peopleWords(first.partySize)} at ${when}.`;
  return assertSpeechSafe(sentence);
}

export function waitlistSpeech(params: {
  localDate: LocalDate;
  today: LocalDate;
  zone: string;
  partySize: number;
}): string {
  return assertSpeechSafe(
    `I've put you on the waiting list for ${spokenDate(params.localDate, params.today, params.zone)}, ` +
      `for ${peopleWords(params.partySize)}. We'll text you if something opens up.`,
  );
}

export function enquirySpeech(guestName: string): string {
  const name = makeSpeakable(guestName);
  return assertSpeechSafe(
    name
      ? `Thanks ${name}, I've passed that to the team and someone will get back to you.`
      : "Thanks, I've passed that to the team and someone will get back to you.",
  );
}

/**
 * Knowledge answers are read from the retrieved text, so this tells the agent
 * what it has rather than answering for it. Inventing a sentence here would be
 * worse than useless: it would sound authoritative.
 */
export function knowledgeSpeech(found: boolean, topTitle?: string): string {
  if (!found) {
    return assertSpeechSafe(
      "I don't have that to hand, I'm afraid. Let me put you through to someone who can help.",
    );
  }
  const title = makeSpeakable(topTitle ?? '').toLowerCase();
  return assertSpeechSafe(title ? `Here's what we have on ${title}.` : "Here's what we have on that.");
}

/**
 * call-events is telemetry, not a turn in the conversation, but AI Studio
 * still expects the field on every response and will happily read whatever is
 * there. An empty string is not speakable, so it gets a neutral sentence the
 * flow can discard.
 */
export function acknowledgementSpeech(): string {
  return assertSpeechSafe('Thanks, I have made a note of that.');
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
