/**
 * The speech_hint contract.
 *
 * Vonage AI Studio pipes `speech_hint` straight into a Speak node. There is no
 * model in between to tidy it up, so whatever we emit is what the caller
 * hears, character for character. "19:30" is read as "nineteen thirty" or
 * "one nine three zero" depending on the voice, an id is read as a string of
 * letters, and a markdown bullet is read as "dash".
 *
 * Hence: words only. Every number that reaches a hint goes through
 * `numberToWords` first, and `assertSpeechSafe` is the backstop that fails
 * loudly in development and in the test suite rather than quietly reading a
 * uuid to a guest.
 */

/**
 * Allowed: letters, spaces, and the four punctuation marks a spoken sentence
 * needs. Rejects digits, colons, slashes, brackets, newlines, markdown and
 * every kind of dash except the plain hyphen in "step-free".
 *
 * Unicode letters rather than A-Za-z: a guest called José or Müller has a name
 * made of letters, and a hint that refuses to say it is a worse bug than the
 * one this guard exists to catch. Digits and punctuation are still rejected,
 * which is what the rule is actually for.
 */
export const SPEECH_SAFE = /^[\p{L} ,.'?-]+$/u;

/** Characters that most often sneak in, with what they should have been. */
const COMMON_OFFENDERS: Array<[RegExp, string]> = [
  [/\d/, 'a digit — spell it with numberToWords'],
  [/[:]/, 'a colon — times must be spelled out, "seven thirty" not "19:30"'],
  [/[\n\r]/, 'a newline — a hint is one sentence, never a list'],
  [/[*_#`]/, 'markdown'],
  [/[–—]/, 'an en or em dash — use a comma'],
  [/[’‘“”]/, 'a typographic quote — use a plain apostrophe'],
  [/[()[\]{}]/, 'a bracket'],
  [/[/\\]/, 'a slash'],
];

export class UnspeakableHintError extends Error {
  constructor(
    readonly hint: string,
    readonly reason: string,
  ) {
    super(`speech_hint is not speakable (${reason}): ${JSON.stringify(hint)}`);
    this.name = 'UnspeakableHintError';
  }
}

export function isSpeechSafe(hint: string): boolean {
  return SPEECH_SAFE.test(hint);
}

/** Why a hint failed, for a test assertion that is worth reading. */
export function describeSpeechViolation(hint: string): string | null {
  if (hint.length === 0) return 'empty';
  if (isSpeechSafe(hint)) return null;
  for (const [pattern, description] of COMMON_OFFENDERS) {
    if (pattern.test(hint)) return description;
  }
  const bad = [...hint].filter((c) => !SPEECH_SAFE.test(c));
  return `disallowed characters: ${JSON.stringify([...new Set(bad)].join(''))}`;
}

export function assertSpeechSafe(hint: string): string {
  const violation = describeSpeechViolation(hint);
  if (violation) throw new UnspeakableHintError(hint, violation);
  return hint;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const UNITS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen',
] as const;

const TENS = [
  '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
] as const;

/**
 * Whole numbers as words, for party sizes, day counts and booking counts.
 *
 * Covers 0 to 999, which is every number that can legitimately reach a hint —
 * a party size, a count of bookings, a booking window in days. Anything larger
 * is a bug upstream, so it returns a safe word rather than digits.
 */
export function numberToWords(value: number): string {
  if (!Number.isFinite(value)) return 'several';
  const n = Math.round(Math.abs(value));

  if (n < 20) return UNITS[n]!;
  if (n < 100) {
    const tens = TENS[Math.floor(n / 10)]!;
    const unit = n % 10;
    return unit === 0 ? tens : `${tens}-${UNITS[unit]}`;
  }
  if (n < 1000) {
    const hundreds = `${UNITS[Math.floor(n / 100)]} hundred`;
    const rest = n % 100;
    return rest === 0 ? hundreds : `${hundreds} and ${numberToWords(rest)}`;
  }
  return 'a great many';
}

/** "two people", "one person". */
export function peopleWords(partySize: number): string {
  return `${numberToWords(partySize)} ${partySize === 1 ? 'person' : 'people'}`;
}

/** "two tables", "one table". */
export function tablesWords(count: number): string {
  return `${numberToWords(count)} ${count === 1 ? 'table' : 'tables'}`;
}

/**
 * Last-resort cleanup for text we did not write, such as a guest's name or an
 * allergy typed by an admin.
 *
 * Strips what cannot be spoken rather than throwing, because refusing to
 * confirm a booking on account of an odd character in a name is the wrong
 * failure. Digits become words so "table 4 please" in a note is still read
 * sensibly.
 */
export function makeSpeakable(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '')
    .replace(/[–—]/g, ', ')
    .replace(/\d+/g, (digits) => numberToWords(Number(digits)))
    .replace(/[^\p{L} ,.'?-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.?])/g, '$1')
    .trim();
}
