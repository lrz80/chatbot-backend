// src/lib/appointments/booking/signals/bookingSignals.ts
import { extractTimeOnlyToken } from "../parsers/dateTimeParsers";
import { normalizeText } from "../shared/textCore";

export type BookingPurpose =
  | "appointment"
  | "class"
  | "consultation"
  | "call"
  | "visit"
  | "demo";

type SignalContext = {
  raw: string;
  text: string;
  tokens: Set<string>;
};

const APPOINTMENT_CONTEXT_TERMS = [
  "appointment",
  "appointments",
  "booking",
  "book",
  "schedule",
  "scheduled",
  "scheduling",
  "availability",
  "available",
  "slot",
  "slots",
  "time",
  "times",
  "calendar",
];

const CAPABILITY_QUESTION_TERMS = [
  "can",
  "could",
  "do",
  "does",
  "able",
  "possible",
  "offer",
  "supports",
  "support",
  "provide",
  "provides",
  "allows",
  "allow",
];

const BOOKING_ACTION_TERMS = [
  "book",
  "booking",
  "schedule",
  "scheduled",
  "reserve",
  "reservation",
  "appointment",
  "appointments",
];

const DIRECT_BOOKING_PHRASES = [
  "book me",
  "schedule me",
  "reserve for me",
  "i want to book",
  "i want to schedule",
  "i want to reserve",
  "i need to book",
  "i need to schedule",
  "i need an appointment",
  "i want an appointment",
  "i would like to book",
  "i would like to schedule",
  "let's book",
  "lets book",
  "let me book",
  "set up an appointment",
  "make an appointment",
];

const CANCEL_PHRASES = [
  "cancel",
  "cancel it",
  "stop booking",
  "stop scheduling",
  "never mind",
  "nevermind",
  "forget it",
  "not now",
  "not anymore",
  "i dont want to continue",
  "i don't want to continue",
  "i want to stop",
  "stop",
  "quit",
  "exit",
];

const MORE_SLOTS_PHRASES = [
  "more times",
  "more time options",
  "more options",
  "other options",
  "other times",
  "other slots",
  "another slot",
  "show more",
  "see more",
  "send more",
  "later",
  "earlier",
  "before",
  "after",
];

const ANOTHER_DAY_PHRASES = [
  "another day",
  "other day",
  "next day",
  "different day",
  "another date",
  "different date",
  "next date",
  "day after tomorrow",
];

const TOPIC_CHANGE_PRICE_PHRASES = [
  "price",
  "prices",
  "pricing",
  "cost",
  "costs",
  "fee",
  "fees",
  "how much",
  "what is the price",
  "whats the price",
  "what's the price",
];

const TOPIC_CHANGE_LOCATION_PHRASES = [
  "location",
  "address",
  "where is",
  "where are you",
];

const TOPIC_CHANGE_INFO_PHRASES = [
  "info",
  "information",
  "details",
  "more info",
  "explain this",
  "how does it work",
  "how it works",
  "what is this",
];

const TOPIC_CHANGE_HOURS_PHRASES = [
  "open",
  "close",
  "opening hours",
  "hours of operation",
  "business hours",
];

const PURPOSE_MAP: Array<{ purpose: BookingPurpose; terms: string[] }> = [
  {
    purpose: "appointment",
    terms: ["appointment", "appointments", "book", "booking", "schedule", "scheduled", "appt"],
  },
  {
    purpose: "class",
    terms: ["class", "classes", "trial", "session", "workout", "training"],
  },
  {
    purpose: "consultation",
    terms: ["consultation", "consult", "assessment", "evaluation"],
  },
  {
    purpose: "call",
    terms: ["call", "phone", "phone call", "video call", "videocall"],
  },
  {
    purpose: "visit",
    terms: ["visit", "in person", "walk in", "walk-in"],
  },
  {
    purpose: "demo",
    terms: ["demo", "demonstration", "presentation"],
  },
];

const SPECIFIC_TIME_ASKING_TERMS = [
  "available",
  "availability",
  "have",
  "is",
  "are",
  "can",
  "could",
  "works",
  "work",
];

const SPECIFIC_TIME_CUE_PHRASES = [
  "at ",
  "for ",
  "around ",
  "about ",
];

export function hasAppointmentContext(text: string) {
  const ctx = buildSignalContext(text);
  return hasAnyPhrase(ctx, APPOINTMENT_CONTEXT_TERMS);
}

export function isCapabilityQuestion(text: string) {
  const ctx = buildSignalContext(text);

  if (!looksLikeQuestion(ctx)) return false;

  const asksCapability = hasAnyPhrase(ctx, CAPABILITY_QUESTION_TERMS);
  const mentionsBooking = hasAnyPhrase(ctx, BOOKING_ACTION_TERMS);

  if (mentionsBooking) return true;
  return asksCapability;
}

export function isDirectBookingRequest(text: string) {
  const ctx = buildSignalContext(text);

  if (hasAnyPhrase(ctx, DIRECT_BOOKING_PHRASES)) return true;

  const hasBookingAction = hasAnyPhrase(ctx, BOOKING_ACTION_TERMS);
  const hasFirstPersonIntent =
    hasAnyPhrase(ctx, [
      "i want",
      "i need",
      "i would like",
      "can you",
      "could you",
      "please",
      "lets",
      "let's",
    ]);

  return hasBookingAction && hasFirstPersonIntent;
}

export function detectPurpose(text: string): BookingPurpose | null {
  const ctx = buildSignalContext(text);

  for (const entry of PURPOSE_MAP) {
    if (hasAnyPhrase(ctx, entry.terms)) {
      return entry.purpose;
    }
  }

  return null;
}

export function wantsToCancel(text: string) {
  const ctx = buildSignalContext(text);
  return hasAnyPhrase(ctx, CANCEL_PHRASES);
}

export function isAmbiguousLangText(txt: string) {
  const raw = String(txt || "").trim();
  if (!raw) return true;

  const text = normalizeText(raw);
  if (!text) return true;

  if (isOnlyDigitsAndPunctuation(raw)) return true;

  if (text.length <= 3) return true;

  if (isSingleShortAck(text)) return true;

  if (isTimeOnlyLike(text)) return true;

  return false;
}

export function wantsMoreSlots(text: string) {
  const ctx = buildSignalContext(text);

  if (hasAnyPhrase(ctx, ANOTHER_DAY_PHRASES)) return false;

  return hasAnyPhrase(ctx, MORE_SLOTS_PHRASES);
}

export function wantsAnotherDay(text: string) {
  const ctx = buildSignalContext(text);
  return hasAnyPhrase(ctx, ANOTHER_DAY_PHRASES);
}

export function wantsToChangeTopic(text: string) {
  const ctx = buildSignalContext(text);

  return (
    hasAnyPhrase(ctx, TOPIC_CHANGE_PRICE_PHRASES) ||
    hasAnyPhrase(ctx, TOPIC_CHANGE_LOCATION_PHRASES) ||
    hasAnyPhrase(ctx, TOPIC_CHANGE_INFO_PHRASES) ||
    hasAnyPhrase(ctx, TOPIC_CHANGE_HOURS_PHRASES) ||
    hasAnyPhrase(ctx, CANCEL_PHRASES)
  );
}

export function matchesBookingIntent(text: string, terms: string[]) {
  const ctx = buildSignalContext(text);
  return hasAnyPhrase(ctx, terms.map((term) => normalizeText(term)));
}

export function wantsSpecificTime(text: string) {
  const raw = String(text || "").trim();
  if (!raw) return false;

  const ctx = buildSignalContext(raw);

  if (isPureChoice(raw)) return false;

  const hasTime = Boolean(extractTimeOnlyToken(raw));
  if (!hasTime) return false;

  const asking = looksLikeQuestion(ctx) || hasAnyPhrase(ctx, SPECIFIC_TIME_ASKING_TERMS);
  const hasCue = containsAnyRawPhrase(ctx.text, SPECIFIC_TIME_CUE_PHRASES);

  return asking || hasCue;
}

function buildSignalContext(raw: string): SignalContext {
  const text = normalizeText(raw);
  const tokens = new Set(
    text
      .split(" ")
      .map((token) => token.trim())
      .filter(Boolean)
  );

  return {
    raw: String(raw || ""),
    text,
    tokens,
  };
}

function hasAnyPhrase(ctx: SignalContext, phrases: string[]): boolean {
  for (const phrase of phrases) {
    if (containsPhrase(ctx, phrase)) return true;
  }
  return false;
}

function containsPhrase(ctx: SignalContext, phrase: string): boolean {
  const normalized = normalizeText(phrase);
  if (!normalized) return false;

  if (!normalized.includes(" ")) {
    return ctx.tokens.has(normalized);
  }

  return containsBoundedPhrase(ctx.text, normalized);
}

function containsAnyRawPhrase(text: string, phrases: string[]): boolean {
  for (const phrase of phrases) {
    if (text.includes(phrase)) return true;
  }
  return false;
}

function containsBoundedPhrase(text: string, phrase: string): boolean {
  if (text === phrase) return true;
  if (text.startsWith(`${phrase} `)) return true;
  if (text.endsWith(` ${phrase}`)) return true;
  return text.includes(` ${phrase} `);
}

function looksLikeQuestion(ctx: SignalContext): boolean {
  return (
    ctx.raw.includes("?") ||
    hasAnyPhrase(ctx, ["what", "when", "where", "how", "can", "could", "do", "does", "is", "are"])
  );
}

function isOnlyDigitsAndPunctuation(raw: string): boolean {
  for (const char of raw) {
    const code = char.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isWhitespace =
      char === " " || char === "\n" || char === "\t" || char === "\r";
    const isPunctuation = ".,;:!?()+-/_".includes(char);

    if (!isDigit && !isWhitespace && !isPunctuation) {
      return false;
    }
  }

  return true;
}

function isSingleShortAck(text: string): boolean {
  const ackTerms = new Set([
    "ok",
    "okay",
    "yes",
    "no",
    "sure",
    "thanks",
    "thank",
    "perfect",
    "done",
  ]);

  const parts = text.split(" ").filter(Boolean);
  if (parts.length === 0) return true;
  if (parts.length > 2) return false;

  const first = parts[0];
  const second = parts[1];

  if (!ackTerms.has(first)) return false;
  if (!second) return true;

  return isDigitsOnly(second);
}

function isTimeOnlyLike(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) return true;

  if (cleaned.includes(":")) {
    const [hh, mm] = cleaned.split(":");
    return isDigitsOnly(hh) && isDigitsOnly(mm || "");
  }

  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length === 1 && isDigitsOnly(parts[0])) return true;

  if (parts.length === 2 && isDigitsOnly(parts[0]) && (parts[1] === "am" || parts[1] === "pm")) {
    return true;
  }

  return false;
}

function isDigitsOnly(value: string): boolean {
  if (!value) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function isPureChoice(raw: string): boolean {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return false;
  return ["1", "2", "3", "4", "5"].includes(trimmed);
}