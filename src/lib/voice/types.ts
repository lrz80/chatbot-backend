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

  pendingBookingStepSlot?: string;
  pendingBookingStepExpectedType?: string;
  pendingBookingStepValidationConfig?: Record<string, unknown>;

  bookingTurnStatus?:
    | "waiting_assistant_prompt"
    | "waiting_user_answer"
    | "flow_complete";

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

  bookingLanguageLocked?: boolean;
  bookingLockedLocale?: VoiceLocale | null;
  bookingLockedLanguageSample?: string | null;

  returningCustomer?: boolean;
  returningCustomerContactId?: number | null;
  returningCustomerName?: string | null;
  returningCustomerFirstName?: string | null;
  returningCustomerPhone?: string | null;
  returningCustomerLocale?: VoiceLocale | null;
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