//src/lib/appointments/booking/text.ts
export {
  EMAIL_REGEX,
  PHONE_REGEX,
  normalizeText,
  removeOnce,
  cleanNameCandidate,
} from "./shared/textCore";

export {
  parseEmail,
  parsePhone,
  parseFullName,
  parseAllInOne,
  parseNameEmailOnly,
} from "./parsers/contactParsers";

export {
  hasExplicitDateTime,
  extractDateTimeToken,
  extractDateOnlyToken,
  extractTimeOnlyToken,
  buildDateTimeFromText,
  extractTimeConstraint,
} from "./parsers/dateTimeParsers";

export type { TimeConstraint } from "./parsers/dateTimeParsers";

export { detectDaypart } from "./signals/daypartSignals";

export {
  hasAppointmentContext,
  isCapabilityQuestion,
  isDirectBookingRequest,
  detectPurpose,
  wantsToCancel,
  isAmbiguousLangText,
  wantsMoreSlots,
  wantsAnotherDay,
  wantsToChangeTopic,
  matchesBookingIntent,
  wantsSpecificTime,
} from "./signals/bookingSignals";

export { buildAskAllMessage } from "./text/bookingPrompts";