//src/lib/voice/realtime/toolGuards/isStaleAlreadyHandledSubmitBlockedByTurnState.ts
function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeComparableText(value: unknown): string {
  return clean(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameComparableText(left: unknown, right: unknown): boolean {
  const a = normalizeComparableText(left);
  const b = normalizeComparableText(right);

  return Boolean(a && b && a === b);
}

export function isStaleAlreadyHandledSubmitBlockedByTurnState(params: {
  reason: unknown;
  submittedStepKey: unknown;
  pendingStepKey: unknown;
  bookingTurnStatus: unknown;
  lastUserTranscript: unknown;
  lastUserTranscriptSeq: unknown;
  lastSubmittedBookingStepKey: unknown;
  lastSubmittedBookingTranscript: unknown;
  lastSubmittedBookingTranscriptSeq: unknown;
}): boolean {
  const reason = clean(params.reason);
  const submittedStepKey = clean(params.submittedStepKey);
  const pendingStepKey = clean(params.pendingStepKey);
  const bookingTurnStatus = clean(params.bookingTurnStatus);

  const lastUserTranscript = clean(params.lastUserTranscript);
  const lastSubmittedBookingStepKey = clean(
    params.lastSubmittedBookingStepKey
  );
  const lastSubmittedBookingTranscript = clean(
    params.lastSubmittedBookingTranscript
  );

  const lastUserTranscriptSeq =
    typeof params.lastUserTranscriptSeq === "number"
      ? params.lastUserTranscriptSeq
      : -1;

  const lastSubmittedBookingTranscriptSeq =
    typeof params.lastSubmittedBookingTranscriptSeq === "number"
      ? params.lastSubmittedBookingTranscriptSeq
      : -1;

  const isTurnStateStaleReason =
    reason === "WRONG_STEP" || reason === "NO_PENDING_STEP";

  const sameStepWasAlreadySubmitted =
    submittedStepKey !== "" &&
    submittedStepKey === lastSubmittedBookingStepKey;

  const sameHumanTranscriptWasAlreadySubmitted =
    lastUserTranscript !== "" &&
    lastSubmittedBookingTranscript !== "" &&
    sameComparableText(lastUserTranscript, lastSubmittedBookingTranscript);

  const transcriptIsNotNewerThanSubmittedStep =
    lastUserTranscriptSeq >= 0 &&
    lastSubmittedBookingTranscriptSeq >= 0 &&
    lastUserTranscriptSeq <= lastSubmittedBookingTranscriptSeq;

  const bookingAlreadyReturnedToIdle =
    reason === "NO_PENDING_STEP" &&
    bookingTurnStatus === "idle" &&
    pendingStepKey === "";

  return (
    isTurnStateStaleReason &&
    sameStepWasAlreadySubmitted &&
    sameHumanTranscriptWasAlreadySubmitted &&
    (transcriptIsNotNewerThanSubmittedStep || bookingAlreadyReturnedToIdle)
  );
}