// src/lib/voice/types.ts
export type VoiceLocale = string;

export type LinkType = "reservar" | "comprar" | "soporte" | "web";

export type CallState = {
  awaiting?: boolean;
  pendingType?: LinkType | null;
  awaitingNumber?: boolean;
  altDest?: string | null;
  smsSent?: boolean;
  lang?: VoiceLocale;
  turn?: number;

  bookingStepIndex?: number;
  bookingData?: Record<string, string>;

  pendingBookingStepKey?: string;
  pendingBookingStepRequired?: boolean;
  pendingBookingStepPrompt?: string;

  pendingBookingStepPromptAnchorTranscript?: string;
  lastSubmittedBookingStepKey?: string;
  lastSubmittedBookingTranscript?: string;

  lastUserTranscriptSeq?: number;
  pendingBookingStepPromptAnchorSeq?: number;
  lastSubmittedBookingTranscriptSeq?: number;

  pendingActionGranted?: boolean;
  pendingActionAnswered?: boolean;
  pendingActionToolName?: string;

  awaitingPostBookingClosure?: boolean;
  postBookingClosureTranscript?: string;

  /**
   * Locks the language used by the booking flow.
   *
   * Important:
   * - Conversation outside booking may continue detecting/switching language.
   * - Once booking starts, booking prompts should use this locked language
   *   until the booking flow finishes or is cancelled.
   * - This is intentionally generic for any language, not hardcoded to ES/EN/PT.
   */
  bookingLanguageLocked?: boolean;
  bookingLockedLocale?: VoiceLocale | null;
  bookingLockedLanguageSample?: string | null;
};

export type PhoneResolutionResult =
  | { ok: true; value: string }
  | { ok: false };

export type VoiceBookingServiceOption = {
  value: string;
  aliases: string[];
};

export type VoiceBookingServiceResolution =
  | { kind: "resolved_single"; value: string }
  | { kind: "ambiguous"; options: string[] }
  | { kind: "none" };